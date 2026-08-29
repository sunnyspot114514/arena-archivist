import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';

import { strToU8, zipSync } from 'fflate';

export const ANALYSIS_PACK_FORMAT = 'arena-archivist.analysis-pack' as const;
export const ANALYSIS_PACK_VERSION = 1 as const;
export const ANALYSIS_PACK_MANIFEST_PATH = 'analysis-pack-manifest.json';

const UTF8 = new TextDecoder('utf-8', { fatal: false });
const FORBIDDEN_PATH_TOKEN =
  /(^|[._-])(chrome[._-]?profile|cookies?|credentials?|env)([._-]|$)/i;

type SecretPattern = {
  kind: SecretFindingKind;
  expression: RegExp;
};

const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    kind: 'pem_private_key',
    expression:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/g,
  },
  {
    kind: 'jwt',
    expression:
      /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    kind: 'authorization',
    expression:
      /\bauthorization\s*["']?\s*[:=]\s*["']?\s*(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{8,}/gi,
  },
  {
    kind: 'cookie',
    expression: /\b(?:set-cookie|cookie)\s*["']?\s*:\s*["']?[^\r\n]{8,}/gi,
  },
  {
    kind: 'provider_api_key',
    expression:
      /\b(?:sk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{16,}|nvapi-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{30,}|(?:AKIA|ASIA)[A-Z0-9]{16}|(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    kind: 'credential_assignment',
    expression:
      /\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret|private[-_]?key|password|secret)\s*["']?\s*[:=]\s*["']?\s*[A-Za-z0-9+/_=.-]{8,}/gi,
  },
] as const;

export type SecretFindingKind =
  | 'pem_private_key'
  | 'jwt'
  | 'authorization'
  | 'cookie'
  | 'provider_api_key'
  | 'credential_assignment';

export type SecretFinding = {
  path: string;
  kind: SecretFindingKind;
  /** Character offset only. The matching credential is deliberately omitted. */
  offset: number;
};

export type AnalysisPackFile = {
  path: string;
  data: Uint8Array;
};

export type AnalysisPackManifest = {
  format: typeof ANALYSIS_PACK_FORMAT;
  version: typeof ANALYSIS_PACK_VERSION;
  createdAt: string;
  files: Array<{
    path: string;
    bytes: number;
    sha256: string;
  }>;
};

export type BuildAnalysisPackOptions = {
  archiveRoot: string;
  now?: Date;
};

export type BuiltAnalysisPack = {
  bytes: Uint8Array;
  includedPaths: string[];
  manifest: AnalysisPackManifest;
};

export type ExportAnalysisPackOptions = BuildAnalysisPackOptions & {
  /** Defaults to <archiveRoot>/exports/analysis_pack_<timestamp>.zip. */
  outputPath?: string;
};

export type ExportedAnalysisPack = Omit<BuiltAnalysisPack, 'bytes'> & {
  outputPath: string;
  bytesWritten: number;
};

export class SecretScanDeniedError extends Error {
  readonly code = 'ANALYSIS_PACK_SECRET_DENIED';

  constructor(readonly findings: readonly SecretFinding[]) {
    const summary = findings
      .map((finding) => `${finding.path}:${finding.kind}`)
      .join(', ');
    super(`Analysis pack export denied by secret scan (${summary})`);
    this.name = 'SecretScanDeniedError';
  }
}

export class AnalysisPackPolicyError extends Error {
  readonly code = 'ANALYSIS_PACK_POLICY_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'AnalysisPackPolicyError';
  }
}

function portablePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function pathSegments(value: string): string[] {
  return portablePath(value).split('/').filter(Boolean);
}

/** True when a relative path names a browser/session/credential surface. */
export function isForbiddenExportPath(relativePath: string): boolean {
  return pathSegments(relativePath).some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return /^\.env(?:[._-]|$)/.test(lower) || FORBIDDEN_PATH_TOKEN.test(lower);
  });
}

/**
 * The pack is intentionally narrower than the archive. Raw evidence, Parquet,
 * checkpoints, screenshots, browser state, and arbitrary reports are excluded.
 */
export function isAllowedAnalysisPackPath(relativePath: string): boolean {
  const candidate = portablePath(relativePath);
  if (
    !candidate ||
    candidate.startsWith('/') ||
    candidate.includes('../') ||
    candidate === '..' ||
    isForbiddenExportPath(candidate)
  ) {
    return false;
  }

  if (candidate === 'manifest.json') return true;
  if (/^normalized\/.+\.(?:sqlite|sqlite3|db)$/i.test(candidate)) return true;
  if (/^(?:normalized|analysis)\/.+\.jsonl$/i.test(candidate)) return true;
  if (candidate === 'analysis/metrics.json') return true;
  if (candidate === 'analysis/report.md') return true;
  return false;
}

function isSanitizedMatch(value: string): boolean {
  return /\[(?:redacted|opaque|removed)\]/i.test(value);
}

/** Scan file contents without returning the matching secret bytes. */
export function scanAnalysisPackFiles(
  files: readonly AnalysisPackFile[],
): SecretFinding[] {
  const findings: SecretFinding[] = [];

  for (const file of files) {
    const text = UTF8.decode(file.data);
    for (const pattern of SECRET_PATTERNS) {
      pattern.expression.lastIndex = 0;
      for (const match of text.matchAll(pattern.expression)) {
        if (isSanitizedMatch(match[0])) continue;
        findings.push({
          path: portablePath(file.path),
          kind: pattern.kind,
          offset: match.index ?? 0,
        });
      }
    }
  }

  return findings;
}

export function assertAnalysisPackSecretFree(
  files: readonly AnalysisPackFile[],
): void {
  const findings = scanAnalysisPackFiles(files);
  if (findings.length) throw new SecretScanDeniedError(findings);
}

function isWithinRoot(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === '' || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== '..')
  );
}

async function collectDirectory(
  archiveRoot: string,
  directory: string,
  output: AnalysisPackFile[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new AnalysisPackPolicyError(
      `Unable to inspect an allowed export directory: ${portablePath(relative(archiveRoot, directory))}`,
    );
  }

  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolutePath = resolve(directory, entry.name);
    const relativePath = portablePath(relative(archiveRoot, absolutePath));

    if (isForbiddenExportPath(relativePath)) continue;
    if (entry.isSymbolicLink()) {
      throw new AnalysisPackPolicyError(
        `Symbolic links are not allowed in analysis pack inputs: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      await collectDirectory(archiveRoot, absolutePath, output);
      continue;
    }
    if (!entry.isFile() || !isAllowedAnalysisPackPath(relativePath)) continue;

    output.push({
      path: relativePath,
      data: new Uint8Array(await readFile(absolutePath)),
    });
  }
}

/** Collect only the fixed analysis-pack allowlist from an archive root. */
export async function collectAnalysisPackFiles(
  archiveRoot: string,
): Promise<AnalysisPackFile[]> {
  const resolvedRoot = resolve(archiveRoot);
  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch {
    throw new AnalysisPackPolicyError(
      'Archive root does not exist or cannot be inspected',
    );
  }

  const files: AnalysisPackFile[] = [];
  for (const allowedDirectory of ['normalized', 'analysis']) {
    const directory = resolve(canonicalRoot, allowedDirectory);
    if (!isWithinRoot(canonicalRoot, directory)) {
      throw new AnalysisPackPolicyError(
        'Allowed export directory escaped the archive root',
      );
    }

    try {
      const status = await lstat(directory);
      if (status.isSymbolicLink()) {
        throw new AnalysisPackPolicyError(
          `Symbolic links are not allowed in analysis pack inputs: ${allowedDirectory}`,
        );
      }
      if (!status.isDirectory()) {
        throw new AnalysisPackPolicyError(
          `Allowed export path is not a directory: ${allowedDirectory}`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }

    await collectDirectory(canonicalRoot, directory, files);
  }

  const sourceManifest = resolve(canonicalRoot, 'manifest.json');
  try {
    const status = await lstat(sourceManifest);
    if (status.isSymbolicLink()) {
      throw new AnalysisPackPolicyError(
        'Symbolic links are not allowed in analysis pack inputs: manifest.json',
      );
    }
    if (status.isFile()) {
      files.push({
        path: 'manifest.json',
        data: new Uint8Array(await readFile(sourceManifest)),
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function validTimestamp(now: Date): string {
  if (!Number.isFinite(now.getTime())) {
    throw new AnalysisPackPolicyError(
      'Analysis pack timestamp must be a valid date',
    );
  }
  return now.toISOString();
}

/** Build an in-memory ZIP after the complete candidate set passes secret scan. */
export async function buildAnalysisPack(
  options: BuildAnalysisPackOptions,
): Promise<BuiltAnalysisPack> {
  const now = options.now ?? new Date();
  const createdAt = validTimestamp(now);
  const files = await collectAnalysisPackFiles(options.archiveRoot);

  // No ZIP bytes are produced before every candidate file has passed the gate.
  assertAnalysisPackSecretFree(files);

  const manifest: AnalysisPackManifest = {
    format: ANALYSIS_PACK_FORMAT,
    version: ANALYSIS_PACK_VERSION,
    createdAt,
    files: files.map((file) => ({
      path: file.path,
      bytes: file.data.byteLength,
      sha256: digest(file.data),
    })),
  };
  const manifestData = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  assertAnalysisPackSecretFree([
    { path: ANALYSIS_PACK_MANIFEST_PATH, data: manifestData },
  ]);

  const zipEntries: Record<string, Uint8Array> = Object.fromEntries(
    files.map((file) => [file.path, file.data]),
  );
  zipEntries[ANALYSIS_PACK_MANIFEST_PATH] = manifestData;

  // ZIP timestamps cannot represent dates before 1980; the manifest retains
  // the exact requested timestamp while archive metadata uses the ZIP epoch.
  const zipTimestamp =
    now.getUTCFullYear() < 1980 ? new Date('1980-01-01T00:00:00.000Z') : now;
  const bytes = zipSync(zipEntries, { level: 6, mtime: zipTimestamp });
  return {
    bytes,
    includedPaths: [
      ...files.map((file) => file.path),
      ANALYSIS_PACK_MANIFEST_PATH,
    ],
    manifest,
  };
}

function defaultOutputPath(archiveRoot: string, now: Date): string {
  const timestamp = validTimestamp(now).replace(/[-:.]/g, '');
  return resolve(archiveRoot, 'exports', `analysis_pack_${timestamp}.zip`);
}

/** Write a completed pack without overwriting a prior export. */
export async function exportAnalysisPack(
  options: ExportAnalysisPackOptions,
): Promise<ExportedAnalysisPack> {
  const now = options.now ?? new Date();
  const built = await buildAnalysisPack({
    archiveRoot: options.archiveRoot,
    now,
  });
  const outputPath = resolve(
    options.outputPath ?? defaultOutputPath(options.archiveRoot, now),
  );
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, built.bytes, { flag: 'wx' });

  return {
    outputPath,
    bytesWritten: built.bytes.byteLength,
    includedPaths: built.includedPaths,
    manifest: built.manifest,
  };
}
