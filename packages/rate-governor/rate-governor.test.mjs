import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  JsonFileGovernorStateStore,
  MemoryGovernorStateStore,
  RateGovernor,
  RateGovernorDeniedError,
  classifyImmediateStop,
} from './index.ts';

function fixture(config = {}) {
  let now = Date.parse('2026-08-29T00:00:00.000Z');
  const governor = new RateGovernor({
    now: () => now,
    store: new MemoryGovernorStateStore(),
    config,
  });
  return {
    governor,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

test('clamps model-requested batch size and enforces one in-flight record', () => {
  const { governor, advance } = fixture();
  const run = governor.startRun(1_000, 'run_fixture');
  assert.equal(run.maxRecords, 25);

  const first = governor.beginRecord(run.runId);
  assert.equal(first.recordNumber, 1);
  assert.throws(
    () => governor.beginRecord(run.runId),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'RECORD_IN_FLIGHT',
  );
  governor.recordSucceeded(first.leaseId);
  assert.throws(
    () => governor.beginRecord(run.runId),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'MIN_INTERVAL',
  );
  advance(10_000);
  const second = governor.beginRecord(run.runId);
  assert.equal(second.recordNumber, 2);
});

test('backs off for 60s, then 300s, and stops on the third consecutive failure', () => {
  const { governor, advance } = fixture();
  const run = governor.startRun(10, 'run_backoff');

  const first = governor.beginRecord(run.runId);
  const firstOutcome = governor.recordFailed(first.leaseId, 'timeout');
  assert.equal(firstOutcome.stopped, false);
  assert.equal(firstOutcome.consecutiveFailures, 1);
  assert.throws(
    () => governor.beginRecord(run.runId),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'FAILURE_BACKOFF',
  );

  advance(60_000);
  const second = governor.beginRecord(run.runId);
  const secondOutcome = governor.recordFailed(second.leaseId, 'parse_error');
  assert.equal(secondOutcome.stopped, false);
  assert.equal(secondOutcome.consecutiveFailures, 2);

  advance(300_000);
  const third = governor.beginRecord(run.runId);
  const thirdOutcome = governor.recordFailed(
    third.leaseId,
    'unexpected_response',
  );
  assert.equal(thirdOutcome.stopped, true);
  assert.equal(thirdOutcome.consecutiveFailures, 3);
  assert.throws(
    () => governor.beginRecord(run.runId),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'RUN_STOPPED',
  );
});

test('403, 429, CAPTCHA, login, bot challenge, and mutation signals stop immediately', () => {
  for (const reason of [
    'HTTP_429',
    'HTTP_403',
    'captcha',
    'bot_challenge',
    'login_required',
    'unexpected_mutation',
  ]) {
    const { governor } = fixture();
    const run = governor.startRun(2);
    const lease = governor.beginRecord(run.runId);
    assert.equal(governor.recordFailed(lease.leaseId, reason).stopped, true);
  }
  assert.equal(classifyImmediateStop({ httpStatus: 429 }), 'HTTP_429');
  assert.equal(
    classifyImmediateStop({ unexpectedMutation: true }),
    'unexpected_mutation',
  );
  assert.equal(classifyImmediateStop({}), null);
});

test('enforces daily run and elapsed-time budgets', () => {
  const { governor, advance } = fixture({ maxRunsPerDay: 1, maxRunMs: 1_000 });
  const run = governor.startRun(1);
  advance(1_000);
  assert.throws(
    () => governor.beginRecord(run.runId),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'RUN_STOPPED',
  );
  assert.throws(
    () => governor.startRun(1),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'RUNS_PER_DAY_EXHAUSTED',
  );
  advance(24 * 60 * 60_000);
  assert.equal(governor.startRun(1).maxRecords, 1);
});

test('does not issue a permit when budget persistence fails', () => {
  const governor = new RateGovernor({
    store: {
      load: () => null,
      save: () => {
        throw new Error('disk unavailable');
      },
    },
  });
  assert.throws(
    () => governor.startRun(1),
    (error) =>
      error instanceof RateGovernorDeniedError &&
      error.reason === 'STATE_UNAVAILABLE',
  );
  assert.equal(governor.snapshot().activeRun, null);
});

test('durably resumes an active budget from the JSON state store', () => {
  const directory = mkdtempSync(join(tmpdir(), 'arena-rate-governor-'));
  try {
    const path = join(directory, 'governor-state.json');
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    const first = new RateGovernor({
      store: new JsonFileGovernorStateStore(path),
      now: () => now,
    });
    const run = first.startRun(5, 'run_persisted');
    const second = new RateGovernor({
      store: new JsonFileGovernorStateStore(path),
      now: () => now,
    });
    assert.equal(second.resumeRun(run.runId).resumed, true);
    assert.equal(second.snapshot().runsStartedToday, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
