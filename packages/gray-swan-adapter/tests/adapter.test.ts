import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  assertSelectorContract,
  detectBlockingCondition,
  loadSelectorContract,
  parseIndexSnapshot,
  parseRecordSnapshot,
  validateParsedRecord,
} from '../src/index.js';
import type { RawPageSnapshot } from '../src/types.js';

const packageRoot = resolve('packages/gray-swan-adapter');
const fixtureRoot = resolve(packageRoot, 'fixtures/html');
const contractPath = resolve(packageRoot, 'contracts/grayswan.fixture-v1.json');
const liveContractPath = resolve(
  packageRoot,
  'contracts/grayswan.live-v2.json',
);
const syntheticLiveChatId = '0123456789abcdef01234567';

interface MutableLiveContract {
  schemaVersion: number;
  index: {
    preparation: {
      steps: Array<{
        intent: string;
        selector: string;
        expectedTextPattern: string;
      }>;
      readySelector: string;
      timeoutMs: number;
    };
    fields: {
      externalId: {
        candidates: Array<{
          source?: string;
          attribute?: string;
          queryParam?: string;
        }>;
      };
      kind: {
        candidates: Array<{ source?: string; value?: string }>;
      };
    };
  };
}

async function mutableLiveContract(): Promise<MutableLiveContract> {
  return JSON.parse(
    await readFile(liveContractPath, 'utf8'),
  ) as MutableLiveContract;
}

async function snapshot(
  name: string,
  url: string,
  title: string,
  responseStatus?: number,
): Promise<RawPageSnapshot> {
  return {
    url,
    title,
    html: await readFile(resolve(fixtureRoot, name), 'utf8'),
    visibleText: title,
    capturedAt: '2026-08-29T00:00:00.000Z',
    ...(responseStatus === undefined ? {} : { responseStatus }),
  };
}

void test('fixture selector contract parses a deterministic index', async () => {
  const contract = await loadSelectorContract(contractPath);
  const parsed = parseIndexSnapshot(
    await snapshot(
      'index.html',
      'https://fixture.invalid/arena/archive',
      'Archive fixture index',
    ),
    contract,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const expected = JSON.parse(
    await readFile(
      resolve(packageRoot, 'fixtures/expected/index.json'),
      'utf8',
    ),
  ) as { records: unknown[] };
  assert.deepEqual(parsed.value.records, expected.records);
  assert.ok(
    parsed.value.trace.some(
      (entry) => entry.candidateId === 'fixture.index.root',
    ),
  );
});

void test('chat parsing records provenance and does not confuse archived words with a CAPTCHA', async () => {
  const contract = await loadSelectorContract(contractPath);
  const page = await snapshot(
    'chat-001.html',
    'https://fixture.invalid/arena/archive/chat_001',
    'First synthetic chat',
  );
  assert.equal(detectBlockingCondition(page, contract), null);
  const parsed = parseRecordSnapshot(page, 'chat', contract);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.externalId, 'chat_001');
  assert.equal(parsed.value.messages.length, 2);
  assert.equal(parsed.value.dataPolicy, 'local_only');
  assert.ok(
    parsed.value.trace.some(
      (entry) => entry.field === 'record.messages[0].body',
    ),
  );
  assert.equal(validateParsedRecord(parsed.value, 'chat_001').ok, true);
  assert.equal(validateParsedRecord(parsed.value, 'wrong_id').ok, false);
});

void test('submission and profile fixtures parse without live DOM assumptions', async () => {
  const contract = await loadSelectorContract(contractPath);
  const submission = parseRecordSnapshot(
    await snapshot(
      'submission-001.html',
      'https://fixture.invalid/arena/archive/submission_001',
      'Synthetic judged submission',
    ),
    'submission',
    contract,
  );
  assert.equal(submission.ok, true);
  if (submission.ok) {
    assert.equal(submission.value.judgeResults[0]?.label, 'not-successful');
    assert.equal(submission.value.judgeResults[0]?.score, '0.10');
  }

  const profile = parseRecordSnapshot(
    await snapshot(
      'profile-001.html',
      'https://fixture.invalid/arena/archive/profile_001',
      'Synthetic profile',
    ),
    'profile',
    contract,
  );
  assert.equal(profile.ok, true);
  if (profile.ok)
    assert.equal(validateParsedRecord(profile.value, 'profile_001').ok, true);
});

void test('auth, CAPTCHA, bot challenge, 403 and 429 stop signals are explicit', async () => {
  const contract = await loadSelectorContract(contractPath);
  assert.equal(
    detectBlockingCondition(
      await snapshot(
        'login.html',
        'https://fixture.invalid/login',
        'Sign in required',
      ),
      contract,
    ),
    'login_required',
  );
  assert.equal(
    detectBlockingCondition(
      await snapshot(
        'captcha.html',
        'https://fixture.invalid/challenge',
        'Verify you are human',
      ),
      contract,
    ),
    'captcha',
  );
  assert.equal(
    detectBlockingCondition(
      await snapshot(
        'bot-challenge.html',
        'https://fixture.invalid/challenge',
        'Security challenge',
      ),
      contract,
    ),
    'bot_challenge',
  );
  assert.equal(
    detectBlockingCondition(
      await snapshot(
        'index.html',
        'https://fixture.invalid/archive',
        'Forbidden',
        403,
      ),
      contract,
    ),
    'http_403',
  );
  assert.equal(
    detectBlockingCondition(
      await snapshot(
        'index.html',
        'https://fixture.invalid/archive',
        'Rate limited',
        429,
      ),
      contract,
    ),
    'http_429',
  );
});

void test('unknown markup fails closed instead of guessing selectors', async () => {
  const contract = await loadSelectorContract(contractPath);
  const parsed = parseIndexSnapshot(
    {
      url: 'https://fixture.invalid/archive',
      title: 'Changed',
      html: '<main><article>unknown build</article></main>',
      visibleText: 'unknown build',
      capturedAt: '2026-08-29T00:00:00.000Z',
    },
    contract,
  );
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.issues[0]?.code, 'root_not_found');
});

void test('same-origin hrefs outside the versioned record allowlist fail closed', async () => {
  const contract = await loadSelectorContract(contractPath);
  const parsed = parseIndexSnapshot(
    {
      url: 'https://fixture.invalid/arena/archive',
      title: 'Changed',
      html: `
        <main data-aa-index>
          <article data-aa-index-item data-record-id="chat_002" data-record-kind="chat">
            <a data-aa-record-link href="/account/delete"><span data-aa-record-title>Bad link</span></a>
          </article>
        </main>`,
      visibleText: 'Bad link',
      capturedAt: '2026-08-29T00:00:00.000Z',
    },
    contract,
  );
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.issues[0]?.code, 'field_invalid');
});

void test('schema v2 contract validates the fixed, ordered index preparation plan', async () => {
  const contract = await loadSelectorContract(liveContractPath);
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(
    contract.index.preparation?.steps.map((step) => step.intent),
    ['open_history_panel', 'select_chat_tab'],
  );

  const mutations: Array<(value: MutableLiveContract) => void> = [
    (value) => {
      value.index.preparation.steps.reverse();
    },
    (value) => {
      value.index.preparation.steps[0]!.selector = 'button';
    },
    (value) => {
      value.index.preparation.steps[1]!.expectedTextPattern = '^Chats';
    },
    (value) => {
      value.index.preparation.readySelector = 'a[href]';
    },
    (value) => {
      value.index.preparation.timeoutMs = 0;
    },
    (value) => {
      value.index.preparation.timeoutMs = 30_001;
    },
  ];
  for (const mutate of mutations) {
    const invalid = await mutableLiveContract();
    mutate(invalid);
    assert.throws(() => assertSelectorContract(invalid));
  }
});

void test('schema v1 behavior stays unchanged and rejects v2 extraction sources', async () => {
  const value = JSON.parse(await readFile(contractPath, 'utf8')) as {
    index: {
      fields: {
        kind: {
          candidates: Array<{
            id: string;
            selector: string;
            source?: string;
            value?: string;
          }>;
        };
      };
    };
  };
  value.index.fields.kind.candidates[0] = {
    ...value.index.fields.kind.candidates[0]!,
    source: 'constant',
    value: 'chat',
  };
  assert.throws(() => assertSelectorContract(value), /text or attribute/);
});

void test('schema v2 validates constant and URL-query candidate metadata', async () => {
  const missingConstant = await mutableLiveContract();
  delete missingConstant.index.fields.kind.candidates[0]!.value;
  assert.throws(
    () => assertSelectorContract(missingConstant),
    /non-empty short string/,
  );

  const badKind = await mutableLiveContract();
  badKind.index.fields.kind.candidates[0]!.value = 'unknown';
  assert.throws(() => assertSelectorContract(badKind), /supported record kind/);

  const missingQueryParam = await mutableLiveContract();
  delete missingQueryParam.index.fields.externalId.candidates[0]!.queryParam;
  assert.throws(
    () => assertSelectorContract(missingQueryParam),
    /safe query parameter/,
  );
});

void test('live v2 index derives one chat id from an href query and uses a constant kind', async () => {
  const contract = await loadSelectorContract(liveContractPath);
  const parsed = parseIndexSnapshot(
    await snapshot(
      'live-index-v2.html',
      'https://fixture.invalid/arena/challenge/hazard-hunt-q3',
      'Synthetic challenge archive',
    ),
    contract,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.records, [
    {
      externalId: syntheticLiveChatId,
      kind: 'chat',
      href: `/arena/challenge/hazard-hunt-q3?chatId=${syntheticLiveChatId}`,
      title: 'Synthetic archived chat',
      updatedAt: null,
    },
  ]);
  assert.ok(
    parsed.value.trace.some(
      (entry) => entry.candidateId === 'live.index.chat-kind',
    ),
  );
});

void test('URL-query extraction fails closed for missing, empty, duplicate, or malformed sources', async () => {
  const contract = await loadSelectorContract(liveContractPath);
  const invalidHrefs = [
    '/arena/challenge/hazard-hunt-q3#chatId=',
    '/arena/challenge/hazard-hunt-q3?chatId=',
    `/arena/challenge/hazard-hunt-q3?chatId=${syntheticLiveChatId}&chatId=abcdefabcdefabcdefabcdef`,
    'http://[::1?chatId=abcdefabcdefabcdefabcdef',
  ];

  for (const href of invalidHrefs) {
    const parsed = parseIndexSnapshot(
      {
        url: 'https://fixture.invalid/arena/challenge/hazard-hunt-q3',
        title: 'Synthetic challenge archive',
        html: `<div role="dialog" data-dialog-content><a href="${href}">Synthetic chat</a></div>`,
        visibleText: 'Synthetic chat',
        capturedAt: '2026-08-30T00:00:00.000Z',
      },
      contract,
    );
    assert.equal(parsed.ok, false);
    if (!parsed.ok) {
      assert.ok(
        parsed.issues.some(
          (issue) =>
            issue.code === 'field_invalid' &&
            issue.field === 'index[0].externalId',
        ),
        `expected invalid externalId issue for ${href}: ${JSON.stringify(parsed.issues)}`,
      );
    }
  }
});

void test('data-testid detail parsing keeps comma-union DOM order and selector-fixed roles', async () => {
  const contract = await loadSelectorContract(liveContractPath);
  const parsed = parseRecordSnapshot(
    await snapshot(
      'live-chat-v2.html',
      `https://fixture.invalid/arena/challenge/hazard-hunt-q3?chatId=${syntheticLiveChatId}`,
      'Synthetic archived chat',
    ),
    'chat',
    contract,
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.externalId, syntheticLiveChatId);
  assert.equal(parsed.value.title, 'synthetic-hazard-behavior');
  assert.equal(parsed.value.behavior, 'synthetic-hazard-behavior');
  assert.equal(
    parsed.value.modelAlias,
    'Synthetic local fixture configuration',
  );
  assert.deepEqual(
    parsed.value.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  assert.deepEqual(
    parsed.value.messages.map((message) => message.body),
    [
      'Harmless synthetic request one.',
      'Harmless synthetic response.',
      'Harmless synthetic request two.',
    ],
  );
  assert.ok(
    parsed.value.trace.some(
      (entry) => entry.candidateId === 'live.chat.assistant-role',
    ),
  );
  assert.equal(
    validateParsedRecord(parsed.value, syntheticLiveChatId).ok,
    true,
  );
});
