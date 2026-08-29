import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import {
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
