import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ANALYSIS_PACK_MANIFEST_PATH,
  SecretScanDeniedError,
  buildAnalysisPack,
  exportAnalysisPack,
  isAllowedAnalysisPackPath,
  isForbiddenExportPath,
  scanAnalysisPackFiles,
} from '../src/index';

const temporaryRoots: string[] = [];

async function archiveFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'arena-exporter-'));
  temporaryRoots.push(root);
  await Promise.all([
    mkdir(join(root, 'normalized'), { recursive: true }),
    mkdir(join(root, 'analysis'), { recursive: true }),
    mkdir(join(root, 'raw', 'chats'), { recursive: true }),
    mkdir(join(root, 'runtime', 'chrome-profile'), { recursive: true }),
    mkdir(join(root, 'credentials'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(root, 'normalized', 'arena.sqlite'),
      'SQLite format 3\0fixture',
    ),
    writeFile(join(root, 'normalized', 'chats.jsonl'), '{"id":"chat-1"}\n'),
    writeFile(
      join(root, 'analysis', 'annotations.jsonl'),
      '{"label":"roleplay"}\n',
    ),
    writeFile(join(root, 'analysis', 'metrics.json'), '{"sampleSize":1}\n'),
    writeFile(join(root, 'analysis', 'report.md'), '# Safe report\n'),
    writeFile(join(root, 'manifest.json'), '{"schemaVersion":1}\n'),
    writeFile(
      join(root, 'raw', 'chats', 'page.html'),
      '<p>must stay local</p>',
    ),
    writeFile(
      join(root, 'runtime', 'chrome-profile', 'Cookies'),
      'session=secret',
    ),
    writeFile(
      join(root, 'credentials', 'provider.json'),
      '{"apiKey":"secret"}',
    ),
    writeFile(join(root, '.env'), 'DEEPSEEK_API_KEY=secret'),
  ]);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('analysis-pack path policy', () => {
  it('allows only documented normalized and analysis artifacts', () => {
    expect(isAllowedAnalysisPackPath('normalized/arena.sqlite')).toBe(true);
    expect(isAllowedAnalysisPackPath('normalized/chats.jsonl')).toBe(true);
    expect(isAllowedAnalysisPackPath('analysis/annotations.jsonl')).toBe(true);
    expect(isAllowedAnalysisPackPath('analysis/metrics.json')).toBe(true);
    expect(isAllowedAnalysisPackPath('analysis/report.md')).toBe(true);
    expect(isAllowedAnalysisPackPath('manifest.json')).toBe(true);

    expect(isAllowedAnalysisPackPath('raw/chats/page.html')).toBe(false);
    expect(isAllowedAnalysisPackPath('analysis/clusters.parquet')).toBe(false);
    expect(isAllowedAnalysisPackPath('analysis/debug.log')).toBe(false);
    expect(isAllowedAnalysisPackPath('../manifest.json')).toBe(false);
  });

  it('explicitly rejects browser profile, cookie, credential, and env names', () => {
    expect(isForbiddenExportPath('runtime/chrome-profile/Cookies')).toBe(true);
    expect(isForbiddenExportPath('normalized/cookies.sqlite')).toBe(true);
    expect(isForbiddenExportPath('analysis/credentials.jsonl')).toBe(true);
    expect(isForbiddenExportPath('.env.production')).toBe(true);
    expect(isForbiddenExportPath('analysis/environment.jsonl')).toBe(false);
  });
});

describe('analysis-pack export', () => {
  it('zips only the allowlist and emits hashes in a generated manifest', async () => {
    const root = await archiveFixture();
    const built = await buildAnalysisPack({
      archiveRoot: root,
      now: new Date('2026-08-29T01:02:03.000Z'),
    });
    const archive = unzipSync(built.bytes);
    const paths = Object.keys(archive).sort();

    expect(paths).toEqual(
      [
        ANALYSIS_PACK_MANIFEST_PATH,
        'analysis/annotations.jsonl',
        'analysis/metrics.json',
        'analysis/report.md',
        'manifest.json',
        'normalized/arena.sqlite',
        'normalized/chats.jsonl',
      ].sort(),
    );
    expect(
      paths.some((path) =>
        /raw|chrome-profile|cookie|credential|\.env/i.test(path),
      ),
    ).toBe(false);

    const manifest = JSON.parse(
      strFromU8(archive[ANALYSIS_PACK_MANIFEST_PATH]),
    ) as {
      format: string;
      files: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.format).toBe('arena-archivist.analysis-pack');
    expect(manifest.files).toHaveLength(6);
    expect(
      manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
  });

  it('writes the pack only after scanning and refuses overwrite', async () => {
    const root = await archiveFixture();
    const outputPath = join(root, 'exports', 'pack.zip');
    const result = await exportAnalysisPack({ archiveRoot: root, outputPath });
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect((await readFile(outputPath)).byteLength).toBe(result.bytesWritten);
    await expect(
      exportAnalysisPack({ archiveRoot: root, outputPath }),
    ).rejects.toMatchObject({
      code: 'EEXIST',
    });
  });
});

describe('fail-closed secret scan', () => {
  it.each([
    ['provider key', 'sk-proj-abcdefghijklmnopqrstuvwxyz123456'],
    ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno'],
    ['cookie header', 'Cookie: session_id=abcdef0123456789'],
    [
      'authorization header',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    ],
    ['PEM key', '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----'],
  ])('detects %s without returning the secret text', (_label, secret) => {
    const findings = scanAnalysisPackFiles([
      { path: 'analysis/report.md', data: new TextEncoder().encode(secret) },
    ]);
    expect(findings).not.toHaveLength(0);
    expect(JSON.stringify(findings)).not.toContain(secret);
  });

  it('denies the entire export and leaves no ZIP when an allowed file contains a secret', async () => {
    const root = await archiveFixture();
    const outputPath = join(root, 'exports', 'denied.zip');
    await writeFile(
      join(root, 'analysis', 'annotations.jsonl'),
      '{"authorization":"Bearer abcdefghijklmnopqrstuvwxyz"}\n',
    );

    const error = await exportAnalysisPack({
      archiveRoot: root,
      outputPath,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SecretScanDeniedError);
    expect(String(error)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    await expect(readFile(outputPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
