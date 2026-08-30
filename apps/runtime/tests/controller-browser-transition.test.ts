import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ArenaRuntimeController,
  type RuntimeBrowserDependencies,
} from '../src/controller';
import { loadRuntimeConfig } from '../src/config';
import type { BrowserLaunchTarget } from '../src/browser-launch';
import type {
  CollectBrowserPort,
  ManualAuthSession,
} from '../../../packages/browser-worker/src/types';

function deferred<T = void>() {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

const launchTarget: BrowserLaunchTarget = {
  browserName: 'Microsoft Edge',
  channel: 'msedge',
  executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  profileKey: 'edge',
  source: 'windows-default',
};

const directories: string[] = [];

function runtimeConfig(directory: string, live = false) {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ARENA_DATA_DIR: join(directory, 'data'),
    ARENA_RUNTIME_STATE_DIR: join(directory, 'runtime-state'),
    ARENA_BROWSER_PROFILE: join(directory, 'browser-profile'),
    ARENA_RUNTIME_PORT: '4317',
  };
  if (live) {
    const baseline = JSON.parse(
      readFileSync(
        resolve(
          'packages',
          'gray-swan-adapter',
          'contracts',
          'grayswan.fixture-v1.json',
        ),
        'utf8',
      ),
    ) as { compatibility: { status: string } };
    baseline.compatibility.status = 'verified';
    const contractPath = join(directory, 'verified-contract.json');
    writeFileSync(contractPath, JSON.stringify(baseline), 'utf8');
    env.ARENA_LIVE_COLLECTION = 'true';
    env.ARENA_INDEX_URL = 'https://app.grayswan.invalid/archive';
    env.ARENA_SELECTOR_CONTRACT = contractPath;
  }
  return loadRuntimeConfig(env, resolve('.'));
}

async function waitForCompletedDemo(
  controller: ArenaRuntimeController,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await controller.status();
    if (status.run?.state !== 'running') {
      expect(status.run?.state).toBe('completed');
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('demo did not complete');
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
});

describe('browser profile transitions', () => {
  it('serializes auth opening while allowing the offline demo', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-auth-transition-'));
    directories.push(directory);
    const authOpening = deferred();
    const releaseAuthOpen = deferred();
    const authClosed = deferred();
    const authSession: ManualAuthSession = {
      mode: 'AUTH_MODE',
      profileDirectory: join(directory, 'browser-profile', 'edge'),
      browserOpen: true,
      pageCount: () => 3,
      openLoginPage: async () => undefined,
      waitForClose: () => authClosed.promise,
      close: async () => authClosed.resolve(),
    };
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        authOpening.resolve();
        await releaseAuthOpen.promise;
        return authSession;
      },
      openCollectSession: async () => {
        throw new Error('live browser must not open');
      },
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory),
      dependencies,
    );
    try {
      const opening = controller.openAuthBrowser();
      await authOpening.promise;

      await expect(controller.openAuthBrowser()).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await controller.startSync({ maxRecords: 1, source: 'demo' });
      await waitForCompletedDemo(controller);

      releaseAuthOpen.resolve();
      await expect(opening).resolves.toEqual({
        status: 'opened',
        pageCount: 3,
      });
      expect((await controller.status()).browser.authBrowserOpen).toBe(true);
      await expect(
        controller.startSync({ maxRecords: 1, source: 'live' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });
    } finally {
      releaseAuthOpen.resolve();
      await controller.close();
    }
  });

  it('does not publish a valid session until validation closes its browser', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-validate-transition-'));
    directories.push(directory);
    const closeStarted = deferred();
    const releaseClose = deferred();
    const fixtureHtml = readFileSync(
      resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
      'utf8',
    );
    const browser: CollectBrowserPort = {
      mode: 'COLLECT_MODE',
      runtimeKind: 'live_browser',
      primaryOrigin: 'https://app.grayswan.invalid',
      navigate: async () => undefined,
      snapshot: async () => ({
        url: 'https://app.grayswan.invalid/archive',
        title: 'Archive index',
        html: fixtureHtml,
        visibleText: 'Archive index',
        capturedAt: '2026-08-30T00:00:00.000Z',
      }),
      consumePolicyViolation: () => null,
      close: async () => {
        closeStarted.resolve();
        await releaseClose.promise;
      },
    };
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => browser,
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      const validating = controller.validateSession();
      await closeStarted.promise;

      expect((await controller.status()).browser.session).toBe('unknown');
      await expect(controller.validateSession()).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(controller.openAuthBrowser()).rejects.toMatchObject({
        code: 'CONFLICT',
      });
      await expect(
        controller.startSync({ maxRecords: 1, source: 'live' }),
      ).rejects.toMatchObject({ code: 'CONFLICT' });

      releaseClose.resolve();
      await expect(validating).resolves.toEqual({ session: 'valid' });
      expect((await controller.status()).browser.session).toBe('valid');
    } finally {
      releaseClose.resolve();
      await controller.close();
    }
  });

  it('keeps the session unvalidated when validation browser close fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-validate-close-'));
    directories.push(directory);
    const fixtureHtml = readFileSync(
      resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
      'utf8',
    );
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => ({
        mode: 'COLLECT_MODE',
        runtimeKind: 'live_browser',
        primaryOrigin: 'https://app.grayswan.invalid',
        navigate: async () => undefined,
        snapshot: async () => ({
          url: 'https://app.grayswan.invalid/archive',
          title: 'Archive index',
          html: fixtureHtml,
          visibleText: 'Archive index',
          capturedAt: '2026-08-30T00:00:00.000Z',
        }),
        consumePolicyViolation: () => null,
        close: async () => {
          throw new Error('close failed');
        },
      }),
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).rejects.toThrow(
        'close failed',
      );
      expect((await controller.status()).browser.session).toBe('unknown');
    } finally {
      await controller.close();
    }
  });

  it('fails closed when a live collection browser cannot release its profile', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-run-close-'));
    directories.push(directory);
    const profileIndexHtml = `<!doctype html>
      <html><head><title>Profile index</title></head><body>
        <main data-aa-index>
          <article data-aa-index-item data-record-id="profile_001" data-record-kind="profile">
            <a data-aa-record-link href="/arena/archive/profile_001">
              <h2 data-aa-record-title>Signed-in profile</h2>
            </a>
          </article>
        </main>
      </body></html>`;
    const collectionCloseAttempted = deferred();
    let openCount = 0;
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => {
        openCount += 1;
        const isCollection = openCount === 2;
        return {
          mode: 'COLLECT_MODE',
          runtimeKind: 'live_browser',
          primaryOrigin: 'https://app.grayswan.invalid',
          navigate: async () => undefined,
          snapshot: async () => ({
            url: 'https://app.grayswan.invalid/archive',
            title: 'Profile index',
            html: profileIndexHtml,
            visibleText: 'Signed-in profile',
            capturedAt: '2026-08-30T00:00:00.000Z',
          }),
          consumePolicyViolation: () => null,
          close: async () => {
            if (!isCollection) return;
            collectionCloseAttempted.resolve();
            throw new Error('profile release failed');
          },
        } satisfies CollectBrowserPort;
      },
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).resolves.toEqual({
        session: 'valid',
      });

      await controller.startSync({ maxRecords: 1, source: 'live' });
      await collectionCloseAttempted.promise;
      await waitForCompletedDemo(controller);

      expect((await controller.status()).browser.session).toBe('unknown');
      await expect(
        controller.startSync({ maxRecords: 1, source: 'live' }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_VALID' });
      expect(
        controller
          .listPolicyEvents({ limit: 20, offset: 0 })
          .items.some(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'reason' in item &&
              item.reason === 'browser_close_failed',
          ),
      ).toBe(true);
    } finally {
      await controller.close();
    }
  });
});
