import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { loadSelectorContract } from '../../gray-swan-adapter/src/contract.js';
import type {
  IndexPreparationPlan,
  RawPageSnapshot,
} from '../../gray-swan-adapter/src/types.js';
import { createSanitizedEvidence } from '../src/evidence.js';
import { MemoryArchive } from '../src/memory-archive.js';
import { CollectNetworkPolicy } from '../src/network-policy.js';
import { OfflineFixtureBrowser } from '../src/offline-fixture-browser.js';
import {
  browserProcessEnvironment,
  openCollectBrowser,
  openManualAuthBrowser,
  type PlaywrightRuntimeLike,
} from '../src/playwright-port.js';
import { assertDedicatedProfileDirectory } from '../src/profile.js';
import { GraySwanBrowserWorker } from '../src/state-machine.js';
import type {
  ArchivePort,
  CollectBrowserPort,
  NetworkPolicyDecision,
} from '../src/types.js';

const adapterRoot = resolve('packages/gray-swan-adapter');
const fixtureRoot = resolve(adapterRoot, 'fixtures/html');
const fixedNow = () => new Date('2026-08-29T00:00:00.000Z');

async function fixture(
  name: string,
  url: string,
  title: string,
): Promise<RawPageSnapshot> {
  return {
    url,
    title,
    html: await readFile(resolve(fixtureRoot, name), 'utf8'),
    visibleText: title,
    capturedAt: fixedNow().toISOString(),
  };
}

async function fixtureBrowser(): Promise<OfflineFixtureBrowser> {
  const pages = [
    await fixture(
      'index.html',
      'https://fixture.invalid/arena/archive',
      'Archive fixture index',
    ),
    await fixture(
      'chat-001.html',
      'https://fixture.invalid/arena/archive/chat_001',
      'First synthetic chat',
    ),
    await fixture(
      'submission-001.html',
      'https://fixture.invalid/arena/archive/submission_001',
      'Synthetic judged submission',
    ),
  ];
  return new OfflineFixtureBrowser(pages, fixedNow);
}

void test('network policy allows reads and fails closed on writes', () => {
  const policy = new CollectNetworkPolicy({
    primaryOrigin: 'https://fixture.invalid',
    staticOrigins: ['https://static.fixture.invalid'],
    readOnlyGraphqlEndpoints: ['https://fixture.invalid/graphql'],
  });
  assert.deepEqual(
    policy.decide({
      url: 'https://fixture.invalid/archive',
      method: 'GET',
      resourceType: 'document',
      postData: null,
    }),
    { allowed: true, reason: 'read_only_request' },
  );
  assert.equal(
    policy.decide({
      url: 'https://fixture.invalid/graphql',
      method: 'POST',
      resourceType: 'fetch',
      postData: JSON.stringify({
        query: 'query ArchiveIndex { records { id } }',
      }),
    }).allowed,
    true,
  );
  const mutation = policy.decide({
    url: 'https://fixture.invalid/graphql',
    method: 'POST',
    resourceType: 'fetch',
    postData: JSON.stringify({
      query: 'mutation SubmitBreak { submitBreak(input: {}) { id } }',
    }),
  });
  assert.equal(mutation.allowed, false);
  if (!mutation.allowed)
    assert.equal(mutation.reason, 'graphql_operation_denied');
  const getMutation = policy.decide({
    url: `https://fixture.invalid/graphql?query=${encodeURIComponent(
      'mutation SubmitBreak { submitBreak(input: {}) { id } }',
    )}`,
    method: 'GET',
    resourceType: 'fetch',
    postData: null,
  });
  assert.equal(getMutation.allowed, false);
  if (!getMutation.allowed)
    assert.equal(getMutation.reason, 'graphql_operation_denied');

  const unknownPost = policy.decide({
    url: 'https://fixture.invalid/api/events',
    method: 'POST',
    resourceType: 'fetch',
    postData: '{}',
  });
  assert.equal(unknownPost.allowed, false);
  if (!unknownPost.allowed)
    assert.equal(unknownPost.endpointPath, '/api/events');
  const staticOriginPost = policy.decide({
    url: 'https://static.fixture.invalid/telemetry',
    method: 'POST',
    resourceType: 'fetch',
    postData: '{}',
  });
  assert.equal(staticOriginPost.allowed, false);
  if (!staticOriginPost.allowed)
    assert.equal(staticOriginPost.endpointPath, undefined);
  const methodOverride = policy.decide({
    url: 'https://fixture.invalid/archive?_method=DELETE',
    method: 'GET',
    resourceType: 'fetch',
    postData: null,
  });
  assert.equal(methodOverride.allowed, false);
  const mutationPath = policy.decide({
    url: 'https://fixture.invalid/account/delete',
    method: 'GET',
    resourceType: 'document',
    postData: null,
  });
  assert.equal(mutationPath.allowed, false);
  const external = policy.decide({
    url: 'https://identity.invalid/login',
    method: 'GET',
    resourceType: 'document',
    postData: null,
  });
  assert.equal(external.allowed, false);
  if (!external.allowed) assert.equal(external.reason, 'origin_denied');
});

void test('offline state machine follows the exact read-only stages and commits after validation', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const archive = new MemoryArchive();
  const cooldowns: number[] = [];
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 10_000,
    },
    {
      browser: await fixtureBrowser(),
      archive,
      selectorContract: contract,
      now: fixedNow,
      sleep: async (milliseconds) => {
        cooldowns.push(milliseconds);
      },
    },
  );

  const result = await worker.runNextBatch({ maxRecords: 10 });
  assert.equal(result.status, 'completed');
  assert.equal(result.committed, 2);
  assert.equal(result.skippedKnown, 0);
  assert.deepEqual(result.visitedStates, [
    'AUTH_CHECK',
    'INDEX_DISCOVERY',
    'OPEN_RECORD',
    'CAPTURE_RAW',
    'PARSE',
    'VALIDATE',
    'COMMIT',
    'COOLDOWN',
    'OPEN_RECORD',
    'CAPTURE_RAW',
    'PARSE',
    'VALIDATE',
    'COMMIT',
    'COOLDOWN',
  ]);
  assert.deepEqual(cooldowns, [10_000, 10_000]);
  assert.equal(archive.records.size, 2);
  assert.equal(archive.checkpoints.length, 2);
  assert.equal(
    archive.records
      .get('chat\0chat_001')
      ?.evidence.snapshot.html.includes('fixture-secret'),
    false,
  );

  const replay = await worker.runNextBatch({ maxRecords: 10 });
  assert.equal(replay.status, 'completed');
  assert.equal(replay.committed, 0);
  assert.equal(replay.skippedKnown, 2);
  assert.equal(archive.records.size, 2);
});

void test('checkpoint never advances when commit fails', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const durableState: { checkpoint: object | null } = { checkpoint: null };
  const archive: ArchivePort = {
    hasRecord: async () => false,
    commitRecord: async (input) => {
      assert.equal(input.checkpoint.cursor, 'chat_001');
      const transactionDraft = { checkpoint: input.checkpoint };
      assert.equal(
        transactionDraft.checkpoint.scope,
        'gray-swan:archive-index',
      );
      throw new Error('simulated transaction failure');
    },
  };
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser: await fixtureBrowser(),
      archive,
      selectorContract: contract,
      now: fixedNow,
    },
  );
  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.stopReason, 'archive_failed');
  // ArchivePort intentionally offers no second checkpoint call. A failed atomic commit leaves
  // the fake store's checkpoint count untouched.
  assert.equal(durableState.checkpoint, null);
});

void test('unchanged atomic commits do not inflate the reconciled commit count', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  let commitCalls = 0;
  const committedEvents: string[] = [];
  const archive: ArchivePort = {
    hasRecord: async () => false,
    commitRecord: async (input) => {
      commitCalls += 1;
      return {
        committed: false,
        canonicalRecordId: `${input.record.kind}:${input.record.externalId}`,
      };
    },
  };
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser: await fixtureBrowser(),
      archive,
      selectorContract: contract,
      now: fixedNow,
      audit: {
        write: (event) => {
          if (event.type === 'record_committed' && event.externalId) {
            committedEvents.push(event.externalId);
          }
        },
      },
    },
  );

  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.status, 'completed');
  assert.equal(result.committed, 0);
  assert.equal(result.skippedKnown, 2);
  assert.equal(commitCalls, 2);
  assert.deepEqual(committedEvents, []);
});

void test('AbortSignal cooperatively pauses an active batch during cooldown', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const controller = new AbortController();
  const archive = new MemoryArchive();
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 10_000,
    },
    {
      browser: await fixtureBrowser(),
      archive,
      selectorContract: contract,
      now: fixedNow,
      sleep: async () => {
        controller.abort();
        await new Promise<void>(() => {});
      },
    },
  );
  const result = await worker.runNextBatch({
    maxRecords: 2,
    signal: controller.signal,
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'user_paused');
  assert.equal(result.committed, 1);
  assert.equal(archive.records.size, 1);
  assert.equal(archive.checkpoints.length, 1);
  assert.equal(result.visitedStates.at(-1), 'COOLDOWN');
});

void test('a runtime shutdown abort keeps its durable cancellation reason', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const controller = new AbortController();
  controller.abort(new Error('runtime_shutdown'));
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser: await fixtureBrowser(),
      archive: new MemoryArchive(),
      selectorContract: contract,
      now: fixedNow,
    },
  );

  const result = await worker.runNextBatch({
    maxRecords: 1,
    signal: controller.signal,
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'runtime_shutdown');
  assert.equal(result.committed, 0);
});

void test('login fixture pauses at AUTH_CHECK', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const loginPage = await fixture(
    'login.html',
    'https://fixture.invalid/arena/archive',
    'Sign in required',
  );
  const worker = new GraySwanBrowserWorker(
    { indexUrl: loginPage.url, minRecordOpenIntervalMs: 0 },
    {
      browser: new OfflineFixtureBrowser([loginPage], fixedNow),
      archive: new MemoryArchive(),
      selectorContract: contract,
      now: fixedNow,
    },
  );
  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.stopReason, 'login_required');
  assert.deepEqual(result.visitedStates, ['AUTH_CHECK']);
});

void test('a denied write stops before any snapshot is parsed', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const violation: NetworkPolicyDecision = {
    allowed: false,
    reason: 'method_denied',
    method: 'PUT',
    origin: 'https://fixture.invalid',
    resourceType: 'fetch',
  };
  let pending: NetworkPolicyDecision | null = null;
  const browser: CollectBrowserPort = {
    mode: 'COLLECT_MODE',
    runtimeKind: 'offline_fixture',
    primaryOrigin: 'https://fixture.invalid',
    navigate: async () => {
      pending = violation;
    },
    snapshot: async () => {
      throw new Error('snapshot must not run after a policy denial');
    },
    consumePolicyViolation: () => {
      const value = pending;
      pending = null;
      return value;
    },
    close: async () => {},
  };
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser,
      archive: new MemoryArchive(),
      selectorContract: contract,
      now: fixedNow,
    },
  );
  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.stopReason, 'unexpected_mutation');
  assert.deepEqual(result.visitedStates, ['AUTH_CHECK']);
});

void test('a denial arriving during validation is consumed synchronously before commit', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const fixturePort = await fixtureBrowser();
  const violation: NetworkPolicyDecision = {
    allowed: false,
    reason: 'graphql_endpoint_denied',
    method: 'POST',
    origin: 'https://fixture.invalid',
    resourceType: 'fetch',
    endpointPath: '/api/unknown',
  };
  let pending: NetworkPolicyDecision | null = null;
  let commitCalls = 0;
  const browser: CollectBrowserPort = {
    mode: 'COLLECT_MODE',
    runtimeKind: 'offline_fixture',
    primaryOrigin: fixturePort.primaryOrigin,
    navigate: (url) => fixturePort.navigate(url),
    snapshot: () => fixturePort.snapshot(),
    consumePolicyViolation: () => {
      const decision = pending;
      pending = null;
      return decision;
    },
    close: () => fixturePort.close(),
  };
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser,
      archive: {
        hasRecord: async () => false,
        commitRecord: async () => {
          commitCalls += 1;
          throw new Error('commit must not run after a policy denial');
        },
      },
      selectorContract: contract,
      now: fixedNow,
      audit: {
        write: (event) => {
          if (event.type === 'state' && event.state === 'VALIDATE') {
            pending = violation;
          }
        },
      },
    },
  );

  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'unexpected_mutation');
  assert.equal(commitCalls, 0);
  assert.equal(result.visitedStates.at(-1), 'COMMIT');
});

void test('a denial arriving at record-commit audit cannot become a completed run', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const fixturePort = await fixtureBrowser();
  const archive = new MemoryArchive();
  const violation: NetworkPolicyDecision = {
    allowed: false,
    reason: 'graphql_operation_denied',
    method: 'POST',
    origin: 'https://fixture.invalid',
    resourceType: 'fetch',
    endpointPath: '/graphql',
  };
  let pending: NetworkPolicyDecision | null = null;
  const browser: CollectBrowserPort = {
    mode: 'COLLECT_MODE',
    runtimeKind: 'offline_fixture',
    primaryOrigin: fixturePort.primaryOrigin,
    navigate: (url) => fixturePort.navigate(url),
    snapshot: () => fixturePort.snapshot(),
    consumePolicyViolation: () => {
      const decision = pending;
      pending = null;
      return decision;
    },
    close: () => fixturePort.close(),
  };
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    {
      browser,
      archive,
      selectorContract: contract,
      now: fixedNow,
      audit: {
        write: (event) => {
          if (event.type === 'record_committed') pending = violation;
        },
      },
    },
  );

  const result = await worker.runNextBatch({ maxRecords: 1 });
  assert.equal(result.status, 'stopped');
  assert.equal(result.stopReason, 'unexpected_mutation');
  assert.equal(result.committed, 1);
  assert.equal(archive.records.size, 1);
  assert.equal(result.visitedStates.at(-1), 'COMMIT');
});

void test('fixture-baseline contracts cannot be attached to a live browser', async () => {
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const liveBrowser: CollectBrowserPort = {
    mode: 'COLLECT_MODE',
    runtimeKind: 'live_browser',
    primaryOrigin: 'https://fixture.invalid',
    navigate: async () => {},
    snapshot: async () => {
      throw new Error('not reached');
    },
    consumePolicyViolation: () => null,
    close: async () => {},
  };
  assert.throws(
    () =>
      new GraySwanBrowserWorker(
        {
          indexUrl: 'https://fixture.invalid/arena/archive',
          minRecordOpenIntervalMs: 0,
        },
        {
          browser: liveBrowser,
          archive: new MemoryArchive(),
          selectorContract: contract,
          now: fixedNow,
        },
      ),
    /verified selector contract/,
  );
});

void test('evidence sanitizer removes scripts, input values, token metadata and bearer values', () => {
  const evidence = createSanitizedEvidence({
    url: 'https://fixture.invalid/archive/chat_001?access_token=url-secret',
    title: 'Fixture',
    html: '<meta name="csrf-token" content="secret"><input value="draft"><script>secret()</script>',
    visibleText: 'Authorization: Bearer abc.def access_token=secret',
    capturedAt: fixedNow().toISOString(),
  });
  assert.equal(evidence.snapshot.html.includes('secret()'), false);
  assert.equal(evidence.snapshot.html.includes('content="secret"'), false);
  assert.equal(evidence.snapshot.html.includes('value="draft"'), false);
  assert.equal(evidence.snapshot.visibleText.includes('abc.def'), false);
  assert.equal(evidence.snapshot.url.includes('url-secret'), false);
  assert.match(evidence.contentHash, /^sha256:[a-f0-9]{64}$/);
});

void test('normal daily browser profiles are rejected', () => {
  assert.throws(() =>
    assertDedicatedProfileDirectory(
      'C:/Users/example/AppData/Local/Google/Chrome/User Data',
    ),
  );
  assert.throws(() => assertDedicatedProfileDirectory('D:/Default'));
  assert.match(
    assertDedicatedProfileDirectory('D:/ArenaArchivist/runtime/chrome-profile'),
    /chrome-profile$/,
  );
});

void test('browser subprocess environment excludes credential-like values', () => {
  assert.deepEqual(
    browserProcessEnvironment({
      PATH: 'C:\\Windows\\System32',
      SESSIONNAME: 'Console',
      NVIDIA_API_KEY: 'secret',
      AWS_SECRET_ACCESS_KEY: 'secret',
      REFRESH_TOKEN: 'secret',
    }),
    {
      PATH: 'C:\\Windows\\System32',
      SESSIONNAME: 'Console',
    },
  );
});

void test('playwright-core launches visible system Chrome by default', async () => {
  const launches: Record<string, unknown>[] = [];
  const page = {
    url: () => 'https://fixture.invalid/archive',
    goto: async () => ({ status: () => 200 }),
    content: async () => '<body>fixture</body>',
    title: async () => 'Fixture',
    locator: () => ({ innerText: async () => 'fixture' }),
    close: async () => {},
  };
  const collectContext = {
    pages: () => [],
    newPage: async () => page,
    addInitScript: async () => {},
    route: async () => {},
    on: () => {},
    close: async () => {},
  };
  const authPages: Array<typeof page> = [];
  const restoredAuthPage = {
    ...page,
    close: async () => {
      const index = authPages.indexOf(restoredAuthPage);
      if (index !== -1) authPages.splice(index, 1);
    },
  };
  authPages.push(restoredAuthPage);
  let authNewPageCalls = 0;
  const authContext = {
    ...collectContext,
    pages: () => authPages,
    newPage: async () => {
      authNewPageCalls += 1;
      const next = {
        ...page,
        close: async () => {
          const index = authPages.indexOf(next);
          if (index !== -1) authPages.splice(index, 1);
        },
      };
      authPages.push(next);
      return next;
    },
    close: async () => {
      authPages.splice(0);
    },
  };
  let launchCount = 0;
  const runtime = {
    chromium: {
      launchPersistentContext: async (
        _directory: string,
        options: Record<string, unknown>,
      ) => {
        launches.push(options);
        launchCount += 1;
        return launchCount === 1 ? collectContext : authContext;
      },
    },
  } as unknown as PlaywrightRuntimeLike;

  const collect = await openCollectBrowser(runtime, {
    profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
    primaryOrigin: 'https://fixture.invalid',
  });
  assert.equal(launches.at(-1)?.channel, 'chrome');
  assert.equal(launches.at(-1)?.headless, false);
  assert.equal(launches.at(-1)?.acceptDownloads, false);
  await collect.close();

  const auth = await openManualAuthBrowser(runtime, {
    profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
    startUrl: 'https://fixture.invalid/',
  });
  assert.equal(launches.at(-1)?.channel, 'chrome');
  assert.equal(auth.pageCount(), 2);
  assert.equal(authNewPageCalls, 1);
  await auth.openLoginPage();
  assert.equal(auth.pageCount(), 3);
  assert.equal(authNewPageCalls, 2);
  await assert.rejects(() => auth.openLoginPage(), /at most 3 login pages/);
  assert.deepEqual(Object.keys(auth).sort(), [
    'browserOpen',
    'close',
    'mode',
    'openLoginPage',
    'pageCount',
    'profileDirectory',
    'waitForClose',
  ]);
  await auth.close();
});

void test('live index preparation only activates the two reviewed read-only controls', async () => {
  const clickOrder: string[] = [];
  const installedScripts: string[] = [];
  const abortedRequests: string[] = [];
  let historyOpen = false;
  let chatsSelected = false;
  let dispatchRequest:
    | ((url: string, method: string, postData?: string) => Promise<void>)
    | undefined;

  function control(
    label: string,
    activate: () => void,
    options: { type?: string | null; formOwned?: boolean } = {},
  ) {
    const attributes = new Map<string, string>();
    if (options.type !== null) {
      attributes.set('type', options.type ?? 'button');
    }
    let formOwned = options.formOwned ?? false;
    let detached = false;
    let afterNextRead: (() => void) | null = null;
    const element = {
      tagName: 'BUTTON',
      innerText: label,
      get form() {
        return formOwned ? {} : null;
      },
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
    };
    const result = {
      all: async () => [result],
      elementHandles: async () => [result],
      click: async () => {
        if (detached) throw new Error('Element is not attached to the DOM');
        assert.ok(
          attributes.get('data-arena-archivist-readonly-action'),
          'reviewed controls require an ephemeral action token',
        );
        clickOrder.push(label);
        activate();
      },
      evaluate: async (
        pageFunction: (target: typeof element, argument?: unknown) => unknown,
        argument?: unknown,
      ) => {
        if (detached) throw new Error('Element is not attached to the DOM');
        return pageFunction(element, argument);
      },
      innerText: async () => {
        if (detached) throw new Error('Element is not attached to the DOM');
        const afterRead = afterNextRead;
        afterNextRead = null;
        afterRead?.();
        return label;
      },
      dispose: async () => undefined,
      marker: () =>
        attributes.get('data-arena-archivist-readonly-action') ?? null,
      setType: (type: string | null) => {
        if (type === null) attributes.delete('type');
        else attributes.set('type', type);
      },
      setFormOwned: (value: boolean) => {
        formOwned = value;
      },
      detachAfterNextRead: (afterDetach: () => void) => {
        afterNextRead = () => {
          detached = true;
          afterDetach();
        };
      },
    };
    return result;
  }

  const historyControl = control('Chats 3793', () => {
    historyOpen = true;
  });
  const chatTabControl = control(
    'Chats (3793)',
    () => {
      chatsSelected = true;
    },
    { type: null, formOwned: false },
  );
  const submitControl = control('Submit Break', () => {
    throw new Error('a replacement submit control must never be clicked');
  });
  let currentHistoryControl = historyControl;
  const readyLink = control('Synthetic chat', () => {});
  const emptyLocator = {
    ...control('', () => {}),
    all: async () => [],
    elementHandles: async () => [],
  };
  const page = {
    url: () => 'https://app.grayswan.invalid/arena/challenge/test',
    goto: async () => ({ status: () => 200 }),
    content: async () => '<main>fixture</main>',
    title: async () => 'Fixture',
    locator: (selector: string) => {
      if (selector === 'body') {
        return { ...emptyLocator, innerText: async () => 'fixture' };
      }
      if (selector === 'button[type=button]') {
        return {
          ...emptyLocator,
          all: async () => [currentHistoryControl],
          elementHandles: async () => [currentHistoryControl],
        };
      }
      if (selector === 'div[role=dialog] button') {
        return {
          ...emptyLocator,
          all: async () => (historyOpen ? [chatTabControl] : []),
          elementHandles: async () => (historyOpen ? [chatTabControl] : []),
        };
      }
      if (selector === 'div[role=dialog] a[href*="chatId="]') {
        return {
          ...emptyLocator,
          all: async () => (chatsSelected ? [readyLink] : []),
          elementHandles: async () => (chatsSelected ? [readyLink] : []),
        };
      }
      if (
        [
          'button[data-behavior-id][class*="bg-secondary"]',
          'div[data-testid="userMessage"]',
          'div[data-testid="assistantMessage"]',
        ].includes(selector)
      ) {
        return {
          ...emptyLocator,
          all: async () => [readyLink],
          elementHandles: async () => [readyLink],
        };
      }
      return emptyLocator;
    },
    close: async () => {},
  };
  const context = {
    pages: () => [],
    newPage: async () => page,
    addInitScript: async (script: string) => installedScripts.push(script),
    route: async (
      _pattern: string,
      handler: (route: {
        request(): {
          url(): string;
          method(): string;
          resourceType(): string;
          postData(): string | null;
          headers(): Record<string, string>;
        };
        abort(errorCode?: string): Promise<void>;
        continue(): Promise<void>;
      }) => Promise<void>,
    ) => {
      dispatchRequest = async (url, method, postData = '{}') =>
        handler({
          request: () => ({
            url: () => url,
            method: () => method,
            resourceType: () => 'fetch',
            postData: () => postData,
            headers: () => ({}),
          }),
          abort: async () => {
            abortedRequests.push(url);
          },
          continue: async () => undefined,
        });
    },
    on: () => {},
    close: async () => {},
  };
  const runtime = {
    chromium: { launchPersistentContext: async () => context },
  } as unknown as PlaywrightRuntimeLike;
  const browser = await openCollectBrowser(runtime, {
    profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
    primaryOrigin: 'https://app.grayswan.invalid',
  });
  const plan: IndexPreparationPlan = {
    steps: [
      {
        intent: 'open_history_panel',
        selector: 'button[type=button]',
        expectedTextPattern: '^Chats\\s+\\d+$',
      },
      {
        intent: 'select_chat_tab',
        selector: 'div[role=dialog] button',
        expectedTextPattern: '^Chats\\s+\\(\\d+\\)$',
      },
    ],
    readySelector: 'div[role=dialog] a[href*="chatId="]',
    timeoutMs: 500,
  };

  await browser.prepareIndex?.(plan);
  await browser.waitForRecordReady?.('chat');
  assert.deepEqual(clickOrder, ['Chats 3793', 'Chats (3793)']);
  assert.equal(historyControl.marker(), null);
  assert.equal(chatTabControl.marker(), null);
  assert.match(installedScripts[0] ?? '', /event\.isTrusted/);
  assert.doesNotMatch(
    installedScripts[0] ?? '',
    /__ARENA_ARCHIVIST_READONLY_TOKEN__/,
  );
  assert.ok(dispatchRequest);
  await dispatchRequest('https://telemetry.invalid/event', 'POST');
  assert.equal(browser.consumePolicyViolation(), null);
  await dispatchRequest('https://app.grayswan.invalid/ingest/flags/', 'POST');
  assert.equal(browser.consumePolicyViolation(), null);
  for (const endpointPath of [
    '/ingest/flags',
    '/ingest/e/',
    '/ingest/archive/',
  ]) {
    await dispatchRequest(
      `https://app.grayswan.invalid${endpointPath}`,
      'POST',
    );
    const ingestViolation = browser.consumePolicyViolation();
    assert.equal(ingestViolation?.allowed, false);
    if (ingestViolation && !ingestViolation.allowed) {
      assert.equal(ingestViolation.endpointPath, endpointPath);
    }
  }
  await dispatchRequest('https://app.grayswan.invalid/api/unknown', 'POST');
  const primaryViolation = browser.consumePolicyViolation();
  assert.equal(primaryViolation?.allowed, false);
  if (primaryViolation && !primaryViolation.allowed) {
    assert.equal(primaryViolation.reason, 'graphql_endpoint_denied');
    assert.equal(primaryViolation.endpointPath, '/api/unknown');
  }
  assert.equal(abortedRequests.length, 6);

  historyControl.setType(null);
  historyControl.setFormOwned(true);
  await assert.rejects(
    () => browser.prepareIndex?.(plan) ?? Promise.resolve(),
    /Read-only index transition denied/,
  );
  historyControl.setFormOwned(false);
  historyControl.setType('SUBMIT');
  await assert.rejects(
    () => browser.prepareIndex?.(plan) ?? Promise.resolve(),
    /Read-only index transition denied/,
  );
  historyControl.setType('button');
  historyControl.detachAfterNextRead(() => {
    currentHistoryControl = submitControl;
  });
  await assert.rejects(
    () => browser.prepareIndex?.(plan) ?? Promise.resolve(),
    /not attached/i,
  );
  assert.equal(
    clickOrder.filter((label) => label === 'Submit Break').length,
    0,
  );
  await assert.rejects(
    () =>
      browser.prepareIndex?.({
        ...plan,
        steps: [
          {
            intent: 'open_history_panel',
            selector: 'button[type=submit]',
            expectedTextPattern: '^Submit Break$',
          },
          plan.steps[1]!,
        ],
      }) ?? Promise.resolve(),
    /Unreviewed read-only index preparation plan/,
  );
  await browser.close();
});

void test('collection launch releases its profile when initialization fails', async () => {
  const initializationError = new Error('route setup failed');
  let closeCalls = 0;
  const page = {
    url: () => 'about:blank',
    goto: async () => null,
    content: async () => '<body></body>',
    title: async () => '',
    locator: () => ({ innerText: async () => '' }),
    close: async () => undefined,
  };
  const context = {
    pages: () => [],
    newPage: async () => page,
    addInitScript: async () => undefined,
    route: async () => {
      throw initializationError;
    },
    on: () => undefined,
    close: async () => {
      closeCalls += 1;
      throw new Error('cleanup failure must not replace initialization error');
    },
  };
  const runtime = {
    chromium: { launchPersistentContext: async () => context },
  } as unknown as PlaywrightRuntimeLike;

  await assert.rejects(
    () =>
      openCollectBrowser(runtime, {
        profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
        primaryOrigin: 'https://app.grayswan.invalid',
      }),
    (error) => error === initializationError,
  );
  assert.equal(closeCalls, 1);
});

void test('startup third-party denials cannot hide a later primary denial', async () => {
  let closeCalls = 0;
  const page = {
    url: () => 'about:blank',
    goto: async () => null,
    content: async () => '<body></body>',
    title: async () => '',
    locator: () => ({
      all: async () => [],
      elementHandles: async () => [],
      innerText: async () => '',
    }),
    close: async () => undefined,
  };
  const requestRoute = (url: string) => ({
    request: () => ({
      url: () => url,
      method: () => 'POST',
      resourceType: () => 'fetch',
      postData: () => '{}',
      headers: () => ({}),
    }),
    abort: async () => undefined,
    continue: async () => undefined,
  });
  const context = {
    pages: () => [],
    newPage: async () => page,
    addInitScript: async () => undefined,
    route: async (
      _pattern: string,
      handler: (route: ReturnType<typeof requestRoute>) => Promise<void>,
    ) => {
      for (let index = 0; index < 40; index += 1) {
        await handler(requestRoute(`https://telemetry-${index}.invalid/event`));
      }
      await handler(requestRoute('https://app.grayswan.invalid/api/unknown'));
    },
    on: () => undefined,
    close: async () => {
      closeCalls += 1;
    },
  };
  const runtime = {
    chromium: { launchPersistentContext: async () => context },
  } as unknown as PlaywrightRuntimeLike;

  await assert.rejects(
    () =>
      openCollectBrowser(runtime, {
        profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
        primaryOrigin: 'https://app.grayswan.invalid',
      }),
    /denied request/,
  );
  assert.equal(closeCalls, 1);
});

void test('collection initialization sweeps a Chromium replacement page', async () => {
  let replacementCloseCalls = 0;
  let contextClosed = false;
  const pages: Array<{
    url(): string;
    goto(): Promise<null>;
    content(): Promise<string>;
    title(): Promise<string>;
    locator(): {
      all(): Promise<never[]>;
      elementHandles(): Promise<never[]>;
      innerText(): Promise<string>;
    };
    close(): Promise<void>;
  }> = [];
  const removePage = (page: (typeof pages)[number]) => {
    const index = pages.indexOf(page);
    if (index >= 0) pages.splice(index, 1);
  };
  const page = (url: string, onClose?: () => void) => {
    const value = {
      url: () => url,
      goto: async () => null,
      content: async () => '<body></body>',
      title: async () => '',
      locator: () => ({
        all: async () => [],
        elementHandles: async () => [],
        innerText: async () => '',
      }),
      close: async () => {
        removePage(value);
        onClose?.();
      },
    };
    return value;
  };
  const replacement = page('about:blank#replacement', () => {
    replacementCloseCalls += 1;
  });
  const restored = page('https://app.grayswan.invalid/old-tab', () => {
    pages.push(replacement);
  });
  const main = page('about:blank');
  pages.push(restored);
  const context = {
    pages: () => [...pages],
    newPage: async () => {
      pages.push(main);
      return main;
    },
    addInitScript: async () => undefined,
    route: async () => undefined,
    on: () => undefined,
    close: async () => {
      contextClosed = true;
      pages.splice(0);
    },
  };
  const runtime = {
    chromium: { launchPersistentContext: async () => context },
  } as unknown as PlaywrightRuntimeLike;

  const browser = await openCollectBrowser(runtime, {
    profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
    primaryOrigin: 'https://app.grayswan.invalid',
  });
  assert.equal(replacementCloseCalls, 1);
  assert.deepEqual(pages, [main]);
  await browser.close();
  assert.equal(contextClosed, true);
});

void test('AUTH_MODE reuses a popup created before the popup event times out', async () => {
  interface FakePage {
    url(): string;
    goto(url: string): Promise<{ status(): number }>;
    content(): Promise<string>;
    title(): Promise<string>;
    locator(): { innerText(): Promise<string> };
    evaluate?: (_pageFunction: unknown, _argument: unknown) => Promise<boolean>;
    waitForEvent?: (
      event: 'popup',
      options: { readonly timeout: number },
    ) => Promise<FakePage>;
    close(): Promise<void>;
  }

  const pages: FakePage[] = [];
  const secondaryNavigations: string[] = [];
  let newPageCalls = 0;
  const removePage = (page: FakePage): void => {
    const index = pages.indexOf(page);
    if (index !== -1) pages.splice(index, 1);
  };
  const secondaryPage: FakePage = {
    url: () => 'about:blank',
    goto: async (url) => {
      secondaryNavigations.push(url);
      return { status: () => 200 };
    },
    content: async () => '<body></body>',
    title: async () => '',
    locator: () => ({ innerText: async () => '' }),
    close: async () => removePage(secondaryPage),
  };
  const primaryPage: FakePage = {
    ...secondaryPage,
    goto: async () => ({ status: () => 200 }),
    evaluate: async () => {
      pages.push(secondaryPage);
      return true;
    },
    waitForEvent: async () => {
      throw new Error('popup event timed out after the Page was created');
    },
    close: async () => removePage(primaryPage),
  };
  pages.push(primaryPage);
  const context = {
    pages: () => pages,
    newPage: async () => {
      newPageCalls += 1;
      pages.push(secondaryPage);
      return secondaryPage;
    },
    addInitScript: async () => {},
    route: async () => {},
    on: () => {},
    close: async () => pages.splice(0),
  };
  const runtime = {
    chromium: {
      launchPersistentContext: async () => context,
    },
  } as unknown as PlaywrightRuntimeLike;

  const auth = await openManualAuthBrowser(runtime, {
    profileDirectory: 'D:/ArenaArchivist/runtime/chrome-profile',
    startUrl: 'https://fixture.invalid/',
  });

  assert.equal(auth.pageCount(), 2);
  assert.equal(newPageCalls, 0);
  assert.deepEqual(secondaryNavigations, ['https://fixture.invalid/']);
  await auth.close();
});
