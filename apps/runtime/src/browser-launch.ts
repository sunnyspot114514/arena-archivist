import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HTTPS_USER_CHOICE =
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice';

export type BrowserLaunchTarget = {
  readonly browserName: 'Google Chrome' | 'Microsoft Edge';
  readonly channel: 'chrome' | 'msedge';
  readonly executablePath?: string;
  readonly profileKey: 'chrome' | 'edge';
  readonly source: 'platform-default' | 'windows-default' | 'windows-fallback';
};

type Environment = Readonly<Record<string, string | undefined>>;

type ResolverDependencies = {
  readonly platform?: NodeJS.Platform;
  readonly env?: Environment;
  readonly queryRegistry?: (
    key: string,
    valueName: string | null,
  ) => Promise<string | null>;
  readonly fileExists?: (path: string) => Promise<boolean>;
};

function registryValue(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/gu)) {
    const match =
      /^\s*.+?\s+REG_(?:EXPAND_)?SZ\s+([A-Z0-9._-]{1,160})\s*$/iu.exec(line);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function queryRegistry(
  key: string,
  valueName: string | null,
): Promise<string | null> {
  try {
    const args = ['query', key, valueName ? '/v' : '/ve'];
    if (valueName) args.push(valueName);
    const { stdout } = await execFileAsync('reg.exe', args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    return registryValue(stdout);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function envValue(env: Environment, name: string): string | null {
  const key = Object.keys(env).find(
    (candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  return key ? (env[key] ?? null) : null;
}

function edgeTarget(
  source: BrowserLaunchTarget['source'],
): BrowserLaunchTarget {
  return {
    browserName: 'Microsoft Edge',
    channel: 'msedge',
    profileKey: 'edge',
    source,
  };
}

function chromeTarget(
  source: BrowserLaunchTarget['source'],
): BrowserLaunchTarget {
  return {
    browserName: 'Google Chrome',
    channel: 'chrome',
    profileKey: 'chrome',
    source,
  };
}

function targetFromProgId(progId: string | null): BrowserLaunchTarget | null {
  if (progId?.toLocaleLowerCase() === 'msedgehtm') {
    return edgeTarget('windows-default');
  }
  if (progId?.toLocaleLowerCase() === 'chromehtml') {
    return chromeTarget('windows-default');
  }
  return null;
}

function fallbackCandidates(env: Environment): Array<{
  path: string;
  target: BrowserLaunchTarget;
}> {
  const programFiles = envValue(env, 'ProgramFiles');
  const programFilesX86 = envValue(env, 'ProgramFiles(x86)');
  const localAppData = envValue(env, 'LOCALAPPDATA');
  return [
    programFilesX86
      ? {
          path: join(
            programFilesX86,
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          ),
          target: edgeTarget('windows-fallback'),
        }
      : null,
    programFiles
      ? {
          path: join(
            programFiles,
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          ),
          target: edgeTarget('windows-fallback'),
        }
      : null,
    localAppData
      ? {
          path: join(
            localAppData,
            'Microsoft',
            'Edge',
            'Application',
            'msedge.exe',
          ),
          target: edgeTarget('windows-fallback'),
        }
      : null,
    localAppData
      ? {
          path: join(
            localAppData,
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
          target: chromeTarget('windows-fallback'),
        }
      : null,
    programFiles
      ? {
          path: join(
            programFiles,
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
          target: chromeTarget('windows-fallback'),
        }
      : null,
    programFilesX86
      ? {
          path: join(
            programFilesX86,
            'Google',
            'Chrome',
            'Application',
            'chrome.exe',
          ),
          target: chromeTarget('windows-fallback'),
        }
      : null,
  ].filter(
    (candidate): candidate is { path: string; target: BrowserLaunchTarget } =>
      candidate !== null,
  );
}

export async function resolveBrowserLaunchTarget(
  dependencies: ResolverDependencies = {},
): Promise<BrowserLaunchTarget> {
  const platform = dependencies.platform ?? process.platform;
  if (platform !== 'win32') return chromeTarget('platform-default');

  const env = dependencies.env ?? process.env;
  const readRegistry = dependencies.queryRegistry ?? queryRegistry;
  const exists = dependencies.fileExists ?? fileExists;
  const selected = targetFromProgId(
    await readRegistry(HTTPS_USER_CHOICE, 'ProgId'),
  );
  if (selected) {
    for (const candidate of fallbackCandidates(env)) {
      if (
        candidate.target.profileKey === selected.profileKey &&
        (await exists(candidate.path))
      ) {
        return { ...selected, executablePath: candidate.path };
      }
    }
  }

  for (const candidate of fallbackCandidates(env)) {
    if (await exists(candidate.path)) {
      return { ...candidate.target, executablePath: candidate.path };
    }
  }

  throw new Error(
    'No supported Windows browser was found. Set Edge or Chrome as the default browser, or install Edge/Chrome.',
  );
}
