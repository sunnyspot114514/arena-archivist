import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  NATIVE_AUTH_INITIAL_PAGES,
  nativeAuthArguments,
  nativeBrowserEnvironment,
  openNativeAuthBrowser,
} from '../src/native-auth';

class FakeBrowserProcess extends EventEmitter {
  unrefCalled = false;

  unref(): void {
    this.unrefCalled = true;
  }
}

const temporaryProfiles: string[] = [];

async function temporaryProfile(): Promise<string> {
  const profile = await mkdtemp(join(tmpdir(), 'arena-chrome-profile-'));
  temporaryProfiles.push(profile);
  return profile;
}

afterEach(async () => {
  await Promise.all(
    temporaryProfiles
      .splice(0)
      .map((profile) => rm(profile, { recursive: true, force: true })),
  );
});

describe('native AUTH_MODE browser', () => {
  it('opens exactly three tabs without automation or debugging switches', async () => {
    const child = new FakeBrowserProcess();
    const profileDirectory = await temporaryProfile();
    let received:
      | {
          executablePath: string;
          args: readonly string[];
          cwd: string;
          detached: true;
          env: Record<string, string>;
          shell: false;
          windowsVerbatimArguments: false;
        }
      | undefined;
    const sessionPromise = openNativeAuthBrowser(
      {
        executablePath:
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        profileDirectory,
        startUrl: 'https://fixture.invalid/login',
      },
      {
        spawnBrowser: (executablePath, args, options) => {
          received = {
            executablePath,
            args,
            cwd: options.cwd,
            detached: options.detached,
            env: options.env,
            shell: options.shell,
            windowsVerbatimArguments: options.windowsVerbatimArguments,
          };
          queueMicrotask(() => child.emit('spawn'));
          return child;
        },
      },
    );
    const session = await sessionPromise;

    expect(received?.executablePath).toBe(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
    expect(
      received?.args.filter((arg) => arg === 'https://fixture.invalid/login')
        .length,
    ).toBe(NATIVE_AUTH_INITIAL_PAGES);
    expect(
      received?.args.some((arg) =>
        /automation|debugging|no-sandbox/iu.test(arg),
      ),
    ).toBe(false);
    expect(received?.args).toContain(`--user-data-dir=${profileDirectory}`);
    expect(received?.shell).toBe(false);
    expect(received?.windowsVerbatimArguments).toBe(false);
    expect(received?.cwd).toBe(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application',
    );
    expect(received?.detached).toBe(true);
    expect(session.pageCount()).toBe(3);

    const closed = session.waitForClose();
    await session.close();
    await closed;
    expect(child.unrefCalled).toBe(true);
    expect(session.pageCount()).toBe(0);
  });

  it('builds a bounded argument list with no shell command string', () => {
    expect(
      nativeAuthArguments(
        'D:\\Agent\\runtime\\chrome-profile\\edge',
        'https://fixture.invalid/',
      ),
    ).toEqual([
      '--user-data-dir=D:\\Agent\\runtime\\chrome-profile\\edge',
      '--disable-background-mode',
      '--no-first-run',
      '--no-default-browser-check',
      '--new-window',
      'https://fixture.invalid/',
      'https://fixture.invalid/',
      'https://fixture.invalid/',
    ]);
  });

  it('passes only required Windows desktop environment variables', () => {
    expect(
      nativeBrowserEnvironment({
        SystemRoot: 'C:\\Windows',
        LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
        TEMP: 'C:\\Temp',
        PATH: 'C:\\tools',
        HTTPS_PROXY: 'https://user:password@proxy.invalid',
        DATABASE_URL: 'postgres://secret',
        NVIDIA_API_KEY: 'secret',
        NODE_OPTIONS: '--require malicious.js',
      }),
    ).toEqual({
      SystemRoot: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local',
      TEMP: 'C:\\Temp',
    });
  });

  it('propagates a native browser launch failure', async () => {
    const child = new FakeBrowserProcess();
    const profileDirectory = await temporaryProfile();
    const session = openNativeAuthBrowser(
      {
        executablePath:
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        profileDirectory,
        startUrl: 'https://fixture.invalid/',
      },
      {
        spawnBrowser: () => {
          queueMicrotask(() => child.emit('error', new Error('launch failed')));
          return child;
        },
      },
    );

    await expect(session).rejects.toThrow('launch failed');
  });
});
