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

function runtimeConfig(
  directory: string,
  live = false,
  liveContractPath?: string,
) {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ARENA_DATA_DIR: join(directory, 'data'),
    ARENA_RUNTIME_STATE_DIR: join(directory, 'runtime-state'),
    ARENA_BROWSER_PROFILE: join(directory, 'browser-profile'),
    ARENA_RUNTIME_PORT: '4317',
  };
  if (live) {
    if (liveContractPath) {
      env.ARENA_LIVE_COLLECTION = 'true';
      env.ARENA_INDEX_URL =
        'https://app.grayswan.invalid/arena/challenge/hazard-hunt-q3';
      env.ARENA_SELECTOR_CONTRACT = liveContractPath;
      return loadRuntimeConfig(env, resolve('.'));
    }
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

async function waitForTerminalRun(
  controller: ArenaRuntimeController,
): Promise<Awaited<ReturnType<ArenaRuntimeController['status']>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = await controller.status();
    if (status.run?.state !== 'running') return status;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error('run did not reach a terminal state');
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

  it('sanitizes browser-step failures during session validation', async () => {
    const cases = [
      {
        step: 'navigate',
        code: 'SESSION_NAVIGATION_FAILED',
        message: '无法打开登录状态验证页。请检查网络连接后重试。',
      },
      {
        step: 'prepare',
        code: 'SESSION_INDEX_PREPARATION_FAILED',
        message: '无法打开只读聊天归档列表。页面结构可能已变化。',
      },
      {
        step: 'snapshot',
        code: 'SESSION_SNAPSHOT_FAILED',
        message: '无法读取登录状态验证页。请重试。',
      },
    ] as const;
    for (const testCase of cases) {
      const directory = mkdtempSync(
        join(tmpdir(), `arena-validate-${testCase.step}-`),
      );
      directories.push(directory);
      const fixtureHtml = readFileSync(
        resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
        'utf8',
      );
      let closeCalls = 0;
      const rawDetail =
        'Browser logs: D:\\private\\browser-profile\\SingletonLock diagnostic-marker';
      const dependencies: RuntimeBrowserDependencies = {
        resolveLaunchTarget: async () => launchTarget,
        openAuthSession: async () => {
          throw new Error('auth browser must not open');
        },
        openCollectSession: async () => ({
          mode: 'COLLECT_MODE',
          runtimeKind: 'live_browser',
          primaryOrigin: 'https://app.grayswan.invalid',
          navigate: async () => {
            if (testCase.step === 'navigate') throw new Error(rawDetail);
          },
          prepareIndex: async () => {
            if (testCase.step === 'prepare') throw new Error(rawDetail);
          },
          snapshot: async () => {
            if (testCase.step === 'snapshot') throw new Error(rawDetail);
            return {
              url: 'https://app.grayswan.invalid/archive',
              title: 'Archive index',
              html: fixtureHtml,
              visibleText: 'Archive index',
              capturedAt: '2026-08-30T00:00:00.000Z',
            };
          },
          consumePolicyViolation: () => null,
          close: async () => {
            closeCalls += 1;
          },
        }),
      };
      const controller = await ArenaRuntimeController.create(
        runtimeConfig(
          directory,
          true,
          testCase.step === 'prepare'
            ? resolve(
                'packages',
                'gray-swan-adapter',
                'contracts',
                'grayswan.live-v2.json',
              )
            : undefined,
        ),
        dependencies,
      );
      try {
        const error = await controller.validateSession().then(
          () => {
            throw new Error('session validation should fail');
          },
          (caught: unknown) => {
            expect(caught).toBeInstanceOf(Error);
            return caught as Error & { code?: string };
          },
        );
        expect(error).toMatchObject({
          code: testCase.code,
          message: testCase.message,
        });
        expect(error.message).not.toContain('Browser logs');
        expect(error.message).not.toContain('browser-profile');
        expect(closeCalls).toBe(1);
        expect((await controller.status()).browser.session).toBe('unknown');
      } finally {
        await controller.close();
      }
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
          throw new Error(
            'Browser logs: D:\\private\\browser-profile\\SingletonLock',
          );
        },
      }),
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).rejects.toMatchObject({
        code: 'SESSION_BROWSER_CLOSE_FAILED',
        message: '无法释放专用浏览器。请关闭整个登录浏览器后重试。',
      });
      expect((await controller.status()).browser.session).toBe('unknown');
    } finally {
      await controller.close();
    }
  });

  it('reports a profile lock without exposing browser launch logs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-profile-lock-'));
    directories.push(directory);
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => {
        throw new Error(
          'browserType.launchPersistentContext: Target page, context or browser has been closed Browser logs: ProcessSingleton profile is in use',
        );
      },
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).rejects.toMatchObject({
        code: 'BROWSER_PROFILE_IN_USE',
        message:
          '专用登录浏览器仍在运行。请关闭整个登录浏览器后重试；登录状态会保留。',
      });
      expect((await controller.status()).browser.session).toBe('unknown');
    } finally {
      await controller.close();
    }
  });

  it('does not classify a generic browser-close launch failure as a profile lock', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-launch-failure-'));
    directories.push(directory);
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => {
        throw new Error(
          'browserType.launchPersistentContext: Target page, context or browser has been closed Browser logs: D:\\private\\browser-profile',
        );
      },
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).rejects.toMatchObject({
        code: 'BROWSER_LAUNCH_FAILED',
        message: '无法打开专用浏览器。请确认 Microsoft Edge 可用后重试。',
      });
      expect((await controller.status()).browser.session).toBe('unknown');
    } finally {
      await controller.close();
    }
  });

  it('validates a live v2 session through the reviewed index preparation', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-live-prepare-'));
    directories.push(directory);
    const liveIndexHtml = readFileSync(
      resolve(
        'packages',
        'gray-swan-adapter',
        'fixtures',
        'html',
        'live-index-v2.html',
      ),
      'utf8',
    );
    let prepared = false;
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
        prepareIndex: async (plan) => {
          expect(plan.steps.map((step) => step.intent)).toEqual([
            'open_history_panel',
            'select_chat_tab',
          ]);
          prepared = true;
        },
        snapshot: async () => {
          expect(prepared).toBe(true);
          return {
            url: 'https://app.grayswan.invalid/arena/challenge/hazard-hunt-q3',
            title: 'Synthetic challenge archive',
            html: liveIndexHtml,
            visibleText: 'Synthetic archived chat',
            capturedAt: '2026-08-30T00:00:00.000Z',
          };
        },
        consumePolicyViolation: () => null,
        close: async () => undefined,
      }),
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(
        directory,
        true,
        resolve(
          'packages',
          'gray-swan-adapter',
          'contracts',
          'grayswan.live-v2.json',
        ),
      ),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).resolves.toEqual({
        session: 'valid',
      });
      expect((await controller.status()).browser.session).toBe('valid');
    } finally {
      await controller.close();
    }
  });

  it('fails validation when a primary-origin denial arrives during snapshot', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-late-denial-'));
    directories.push(directory);
    const fixtureHtml = readFileSync(
      resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
      'utf8',
    );
    let policyChecks = 0;
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
        consumePolicyViolation: () => {
          policyChecks += 1;
          return policyChecks === 2
            ? {
                allowed: false,
                reason: 'graphql_endpoint_denied',
                method: 'POST',
                origin: 'https://app.grayswan.invalid',
                resourceType: 'fetch',
                endpointPath: '/api/unknown',
              }
            : null;
        },
        close: async () => undefined,
      }),
    };
    const controller = await ArenaRuntimeController.create(
      runtimeConfig(directory, true),
      dependencies,
    );
    try {
      await expect(controller.validateSession()).resolves.toEqual({
        session: 'invalid',
      });
      expect(policyChecks).toBe(2);
      expect((await controller.status()).browser.session).toBe('invalid');
    } finally {
      await controller.close();
    }
  });

  it('revokes live-session reuse after an unexpected mutation denial', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-mutation-session-'));
    directories.push(directory);
    const fixtureHtml = readFileSync(
      resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
      'utf8',
    );
    let openCount = 0;
    const dependencies: RuntimeBrowserDependencies = {
      resolveLaunchTarget: async () => launchTarget,
      openAuthSession: async () => {
        throw new Error('auth browser must not open');
      },
      openCollectSession: async () => {
        openCount += 1;
        let navigationCount = 0;
        let pendingViolation = false;
        return {
          mode: 'COLLECT_MODE',
          runtimeKind: 'live_browser',
          primaryOrigin: 'https://app.grayswan.invalid',
          navigate: async () => {
            navigationCount += 1;
            if (openCount === 2 && navigationCount === 2) {
              pendingViolation = true;
            }
          },
          snapshot: async () => ({
            url: 'https://app.grayswan.invalid/archive',
            title: 'Archive index',
            html: fixtureHtml,
            visibleText: 'Archive index',
            capturedAt: '2026-08-30T00:00:00.000Z',
          }),
          consumePolicyViolation: () => {
            if (!pendingViolation) return null;
            pendingViolation = false;
            return {
              allowed: false,
              reason: 'graphql_endpoint_denied',
              method: 'POST',
              origin: 'https://app.grayswan.invalid',
              resourceType: 'fetch',
              endpointPath: '/api/unknown',
            };
          },
          close: async () => undefined,
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
      const status = await waitForTerminalRun(controller);
      expect(status.run).toMatchObject({
        state: 'stopped',
        stopReason: 'unexpected_mutation',
      });
      expect(status.browser.session).toBe('unknown');
      await expect(
        controller.startSync({ maxRecords: 1, source: 'live' }),
      ).rejects.toMatchObject({ code: 'SESSION_NOT_VALID' });
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
