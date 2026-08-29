import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

import { assertDedicatedProfileDirectory } from '../../../packages/browser-worker/src/profile';
import type { ManualAuthSession } from '../../../packages/browser-worker/src/types';

export const NATIVE_AUTH_INITIAL_PAGES = 3;

interface NativeBrowserProcess {
  readonly pid?: number;
  once(event: 'spawn', listener: () => void): this;
  once(event: 'exit', listener: () => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  unref(): void;
}

interface NativeBrowserSpawnOptions {
  readonly cwd: string;
  readonly detached: true;
  readonly env: Record<string, string>;
  readonly shell: false;
  readonly stdio: 'ignore';
  readonly windowsHide: true;
  readonly windowsVerbatimArguments: false;
}

type SpawnNativeBrowser = (
  executablePath: string,
  args: readonly string[],
  options: NativeBrowserSpawnOptions,
) => NativeBrowserProcess;

export interface NativeAuthDependencies {
  readonly spawnBrowser?: SpawnNativeBrowser;
}

export interface NativeAuthConfig {
  readonly executablePath: string;
  readonly profileDirectory: string;
  readonly startUrl: string;
}

const NATIVE_BROWSER_ENV_NAMES = new Set(
  [
    'APPDATA',
    'COMMONPROGRAMFILES',
    'COMMONPROGRAMFILES(X86)',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'SESSIONNAME',
    'SYSTEMROOT',
    'TEMP',
    'TMP',
    'USERDOMAIN',
    'USERNAME',
    'USERPROFILE',
    'WINDIR',
  ].map((name) => name.toLocaleLowerCase()),
);

export function nativeBrowserEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        NATIVE_BROWSER_ENV_NAMES.has(entry[0].toLocaleLowerCase()),
    ),
  );
}

function validateExecutablePath(executablePath: string): string {
  if (!isAbsolute(executablePath)) {
    throw new Error('Native AUTH_MODE browser path must be absolute');
  }
  const resolved = resolve(executablePath);
  const executable = basename(resolved).toLocaleLowerCase();
  const normalized = resolved.replace(/\//gu, '\\');
  const trustedInstallation =
    (executable === 'msedge.exe' &&
      /\\Microsoft\\Edge\\Application\\msedge\.exe$/iu.test(normalized)) ||
    (executable === 'chrome.exe' &&
      /\\Google\\Chrome\\Application\\chrome\.exe$/iu.test(normalized));
  if (!trustedInstallation) {
    throw new Error('Native AUTH_MODE supports only official Edge or Chrome');
  }
  return resolved;
}

function validateStartUrl(startUrl: string): string {
  const url = new URL(startUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Native AUTH_MODE start URL must be credential-free HTTPS');
  }
  return url.href;
}

export function nativeAuthArguments(
  profileDirectory: string,
  startUrl: string,
): readonly string[] {
  return [
    `--user-data-dir=${profileDirectory}`,
    '--disable-background-mode',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    ...Array.from({ length: NATIVE_AUTH_INITIAL_PAGES }, () => startUrl),
  ];
}

const defaultSpawnBrowser: SpawnNativeBrowser = (
  executablePath,
  args,
  options,
) =>
  spawn(executablePath, [...args], {
    ...options,
    env: options.env as NodeJS.ProcessEnv,
  }) as NativeBrowserProcess;

export async function openNativeAuthBrowser(
  config: NativeAuthConfig,
  dependencies: NativeAuthDependencies = {},
): Promise<ManualAuthSession> {
  const executablePath = validateExecutablePath(config.executablePath);
  const profileDirectory = assertDedicatedProfileDirectory(
    config.profileDirectory,
  );
  const startUrl = validateStartUrl(config.startUrl);
  await mkdir(profileDirectory, { recursive: true });

  const child = (dependencies.spawnBrowser ?? defaultSpawnBrowser)(
    executablePath,
    nativeAuthArguments(profileDirectory, startUrl),
    {
      cwd: dirname(executablePath),
      detached: true,
      env: nativeBrowserEnvironment(),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: false,
    },
  );

  let browserOpen = true;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolveClosedPromise) => {
    resolveClosed = resolveClosedPromise;
  });
  const noteClosed = (): void => {
    if (!browserOpen) return;
    browserOpen = false;
    resolveClosed?.();
  };
  child.once('exit', noteClosed);

  await new Promise<void>((resolveStarted, rejectStarted) => {
    let started = false;
    child.once('spawn', () => {
      started = true;
      resolveStarted();
    });
    child.once('error', (error) => {
      noteClosed();
      if (!started) rejectStarted(error);
    });
  });

  return {
    mode: 'AUTH_MODE',
    profileDirectory,
    browserOpen: true,
    pageCount: () => (browserOpen ? NATIVE_AUTH_INITIAL_PAGES : 0),
    openLoginPage: async () => {},
    waitForClose: () => closed,
    close: async () => {
      if (!browserOpen) return;
      // AUTH_MODE is user-owned. Runtime shutdown must not force-terminate a browser while it
      // may be persisting login state; detach and let the user close it normally.
      child.unref();
      noteClosed();
    },
  };
}
