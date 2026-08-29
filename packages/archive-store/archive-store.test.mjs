import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  ArchiveStore,
  StaleCheckpointError,
  archiveSchema,
  hashCanonicalJson,
  hashRawEvidence,
  resolveEvidencePath,
} from './index.ts';

function workspace() {
  const directory = mkdtempSync(join(tmpdir(), 'arena-archive-store-'));
  return {
    directory,
    databasePath: join(directory, 'normalized', 'arena.sqlite'),
    evidenceDirectory: join(directory, 'raw'),
  };
}

function chatInput(overrides = {}) {
  return {
    record: {
      kind: 'chat',
      platform: 'gray-swan',
      externalId: 'chat_123',
      title: 'Read-only archive fixture',
      status: 'complete',
      normalized: { external_chat_id: 'chat_123', message_count: 1 },
      messages: [
        {
          externalId: 'message_1',
          ordinal: 0,
          role: 'user',
          content: 'fixture',
        },
      ],
    },
    evidence: [
      {
        artifactType: 'page_html',
        content: '<html><body>fixture</body></html>',
        mediaType: 'text/html',
      },
    ],
    checkpoint: {
      scope: 'chats',
      cursor: 'cursor_1',
      state: { last_seen_chat_id: 'chat_123' },
      expectedVersion: 0,
    },
    ...overrides,
  };
}

function evidenceFileCount(directory) {
  return readdirSync(directory, {
    recursive: true,
    withFileTypes: true,
  }).filter((entry) => entry.isFile()).length;
}

test('raw evidence uses a prefixed SHA-256 digest', () => {
  assert.equal(
    hashRawEvidence('abc'),
    'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('migrates, stores raw evidence, and idempotently upserts a record', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });
    const runId = store.startSyncRun({ requestedMaxRecords: 10 });
    const input = chatInput({ runId });
    const first = store.commitRecord(input);
    const retry = store.commitRecord(input);

    assert.equal(archiveSchema.latestVersion, 3);
    assert.equal(first.disposition, 'inserted');
    assert.equal(retry.disposition, 'unchanged');
    assert.equal(first.recordId, retry.recordId);
    assert.equal(first.checkpoint.version, 1);
    assert.equal(retry.checkpoint.version, 1);
    assert.equal(store.countRecords('chat'), 1);
    assert.deepEqual(
      store.getRecord('chat', 'gray-swan', 'chat_123')?.normalized,
      {
        external_chat_id: 'chat_123',
        message_count: 1,
      },
    );
    assert.equal(store.listRecords({ limit: 10 })[0].id, first.recordId);
    assert.equal(
      store.getRecordById(first.recordId)?.messages[0].externalId,
      'message_1',
    );
    assert.deepEqual(store.stats(), {
      chats: 1,
      submissions: 0,
      messages: 1,
      judgeResults: 0,
      sourceArtifacts: 1,
      policyDecisions: 0,
      syncRuns: 1,
      activeSyncRuns: 1,
      checkpoints: 1,
    });
    assert.equal(store.getSyncRun(runId)?.status, 'running');
    assert.equal(store.listSyncRuns({ status: 'running' })[0].id, runId);

    store.appendPolicyDecision({
      id: 'policy_fixture',
      occurredAt: '2026-08-29T00:00:00.000Z',
      layer: 'network',
      mode: 'COLLECT_MODE',
      allowed: false,
      reason: 'NETWORK_MUTATION_DENIED',
      action: 'POST',
      origin: 'https://app.grayswan.ai',
    });
    assert.equal(
      store.listPolicyDecisions({ allowed: false })[0].id,
      'policy_fixture',
    );

    const artifactPath = resolveEvidencePath(
      paths.evidenceDirectory,
      first.artifacts[0].storagePath,
    );
    assert.equal(
      readFileSync(artifactPath, 'utf8'),
      '<html><body>fixture</body></html>',
    );
    assert.ok(
      resolve(artifactPath).startsWith(resolve(paths.evidenceDirectory)),
    );
    store.finishSyncRun(runId, 'completed');
    const preparedExport = store.prepareExport();
    assert.equal(preparedExport.databasePath, resolve(paths.databasePath));
    assert.equal(preparedExport.walCheckpoint.busy, 0);
    const exportedDatabasePath = join(paths.directory, 'exported-arena.sqlite');
    copyFileSync(paths.databasePath, exportedDatabasePath);
    const exportedDatabase = new DatabaseSync(exportedDatabasePath);
    assert.equal(
      Number(
        exportedDatabase.prepare('SELECT COUNT(*) AS count FROM chats').get()
          .count,
      ),
      1,
    );
    assert.equal(
      exportedDatabase.prepare('SELECT status FROM sync_runs').get().status,
      'completed',
    );
    exportedDatabase.close();
    store.close();

    const database = new DatabaseSync(paths.databasePath);
    assert.equal(
      Number(database.prepare('PRAGMA user_version').get().user_version),
      3,
    );
    assert.equal(
      Number(
        database.prepare('SELECT COUNT(*) AS count FROM chats').get().count,
      ),
      1,
    );
    assert.equal(
      Number(
        database.prepare('SELECT COUNT(*) AS count FROM messages').get().count,
      ),
      1,
    );
    assert.equal(
      Number(
        database.prepare('SELECT COUNT(*) AS count FROM source_artifacts').get()
          .count,
      ),
      1,
    );
    assert.equal(
      database.prepare('SELECT records_committed FROM sync_runs').get()
        .records_committed,
      1,
    );
    database.close();

    const reopened = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.equal(reopened.schemaVersion, 3);
    reopened.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('a stale checkpoint rolls the normalized record back', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    store.commitRecord(chatInput());
    assert.equal(evidenceFileCount(paths.evidenceDirectory), 1);

    assert.throws(
      () =>
        store.commitRecord({
          record: {
            kind: 'submission',
            platform: 'gray-swan',
            externalId: 'submission_1',
            normalized: { verdict: 'fixture' },
          },
          evidence: [
            {
              artifactType: 'network_json',
              content: '{}',
              mediaType: 'application/json',
            },
          ],
          checkpoint: {
            scope: 'chats',
            cursor: 'cursor_2',
            expectedVersion: 0,
          },
        }),
      StaleCheckpointError,
    );

    assert.equal(store.countRecords('submission'), 0);
    assert.equal(store.getCheckpoint('chats')?.cursor, 'cursor_1');
    assert.equal(store.getCheckpoint('chats')?.version, 1);
    assert.equal(evidenceFileCount(paths.evidenceDirectory), 1);
    store.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('compensates newly written evidence when a later evidence item fails', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.throws(() =>
      store.commitRecord({
        record: {
          kind: 'chat',
          platform: 'gray-swan',
          externalId: 'chat_compensation',
          normalized: {},
        },
        evidence: [
          {
            artifactType: 'page_html',
            content: 'new evidence',
            mediaType: 'text/plain',
          },
          { artifactType: '   ', content: 'invalid evidence' },
        ],
        checkpoint: {
          scope: 'chats',
          cursor: 'cursor_compensation',
          expectedVersion: 0,
        },
      }),
    );
    assert.equal(evidenceFileCount(paths.evidenceDirectory), 0);
    assert.equal(store.countRecords('chat'), 0);
    store.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('evidence path resolution rejects directory traversal', () => {
  const paths = workspace();
  try {
    assert.throws(
      () => resolveEvidencePath(paths.evidenceDirectory, '../../secret.txt'),
      /escaped/,
    );
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('persists the complete authorized action lifecycle with its sync run', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
      now: () => new Date('2026-08-29T01:00:00.000Z'),
    });
    const created = store.startAuthorizedSyncRun({
      id: 'run_ledger_fixture',
      actionId: 'action_ledger_fixture',
      requestedMaxRecords: 10,
      metadata: { source: 'demo' },
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 10 },
      authorization: {
        principal: 'local_operator',
        decisionCode: 'manual_loopback_request',
      },
    });
    assert.deepEqual(created, {
      runId: 'run_ledger_fixture',
      actionId: 'action_ledger_fixture',
    });
    assert.deepEqual(
      store.listActionEvents(created.actionId).map((event) => event.phase),
      ['proposal', 'validation', 'authorization'],
    );

    store.advanceAction(created.actionId, 'dispatch', {
      requestedMaxRecords: 10,
    });
    const canonical = store.commitRecord(chatInput({ runId: created.runId }));
    const settled = store.settleSyncRunAction({
      runId: created.runId,
      status: 'completed',
      observation: { committed: 1, skippedKnown: 0 },
      reconciliation: { workerCommitted: 1 },
    });
    assert.equal(settled.currentPhase, 'canonical_commit');
    assert.equal(settled.terminal, true);
    assert.equal(store.getSyncRun(created.runId)?.status, 'completed');
    const events = store.listActionEvents(created.actionId);
    assert.deepEqual(
      events.map((event) => event.phase),
      [
        'proposal',
        'validation',
        'authorization',
        'dispatch',
        'observation',
        'reconciliation',
        'canonical_commit',
      ],
    );
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.ok(events.every((event) => event.syncRunId === created.runId));
    assert.ok(
      events.every((event) => /^sha256:[a-f0-9]{64}$/.test(event.payloadHash)),
    );
    assert.ok(
      events.every(
        (event) => event.payloadHash === hashCanonicalJson(event.payload),
      ),
    );
    const [recordCommit] = store.listSyncRecordCommits(created.runId);
    assert.equal(recordCommit.actionId, created.actionId);
    assert.equal(recordCommit.recordId, canonical.recordId);
    assert.equal(recordCommit.sourceHash, canonical.sourceHash);
    assert.equal(recordCommit.disposition, 'inserted');
    assert.throws(
      () => store.advanceAction(created.actionId, 'dispatch'),
      (error) => error?.code === 'INVALID_ACTION_TRANSITION',
    );
    store.close();

    const database = new DatabaseSync(paths.databasePath);
    assert.throws(() =>
      database
        .prepare(
          "UPDATE action_ledger_events SET phase = 'failed' WHERE event_id = ?",
        )
        .run(events[0].eventId),
    );
    assert.throws(() =>
      database
        .prepare('DELETE FROM action_ledger_events WHERE event_id = ?')
        .run(events[0].eventId),
    );
    database.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('fails reconciliation atomically and preserves every terminal action on reopen', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
      now: () => new Date('2026-08-29T01:30:00.000Z'),
    });
    const mismatch = store.startAuthorizedSyncRun({
      id: 'run_mismatch',
      actionId: 'action_mismatch',
      requestedMaxRecords: 1,
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    assert.throws(
      () => store.advanceAction(mismatch.actionId, 'canonical_commit'),
      (error) => error?.code === 'INVALID_INPUT',
    );
    assert.equal(store.getSyncRun(mismatch.runId)?.status, 'running');
    store.advanceAction(mismatch.actionId, 'dispatch');
    assert.throws(
      () =>
        store.settleSyncRunAction({
          runId: mismatch.runId,
          status: 'completed',
          reconciliation: { workerCommitted: 1 },
        }),
      (error) => error?.code === 'RECONCILIATION_MISMATCH',
    );
    assert.equal(store.getSyncRun(mismatch.runId)?.status, 'running');
    assert.equal(store.getAction(mismatch.actionId)?.currentPhase, 'dispatch');
    assert.deepEqual(
      store.listActionEvents(mismatch.actionId).map((event) => event.phase),
      ['proposal', 'validation', 'authorization', 'dispatch'],
    );
    assert.throws(
      () => store.finishSyncRun(mismatch.runId, 'failed'),
      (error) => error?.code === 'ACTION_LEDGER_REQUIRED',
    );
    store.settleSyncRunAction({
      runId: mismatch.runId,
      status: 'failed',
      stopReason: 'reconciliation_mismatch',
      observation: { error: 'RECONCILIATION_MISMATCH' },
    });

    for (const terminalPhase of ['blocked', 'cancelled']) {
      const created = store.startAuthorizedSyncRun({
        id: `run_${terminalPhase}`,
        actionId: `action_${terminalPhase}`,
        requestedMaxRecords: 1,
        connectorId: 'gray-swan',
        connectorVersion: '1.0.0',
        policyVersion: 'arena-read-only-sync-v1',
        request: { source: 'demo', maxRecords: 1 },
        authorization: {
          principal: 'loopback_runtime_client',
          decisionCode: 'bounded_readonly_policy_allow',
        },
      });
      store.advanceAction(created.actionId, 'dispatch');
      store.settleSyncRunAction({
        runId: created.runId,
        status: 'stopped',
        stopReason: terminalPhase === 'cancelled' ? 'user_paused' : 'captcha',
        terminalPhase,
      });
      assert.equal(
        store.getAction(created.actionId)?.currentPhase,
        terminalPhase,
      );
    }
    store.close();

    const reopened = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.equal(reopened.getAction('action_mismatch')?.currentPhase, 'failed');
    assert.equal(reopened.getAction('action_blocked')?.currentPhase, 'blocked');
    assert.equal(
      reopened.getAction('action_cancelled')?.currentPhase,
      'cancelled',
    );
    assert.equal(
      reopened.listActionEvents('action_mismatch').at(-1)?.phase,
      'failed',
    );
    reopened.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('uses generation-bound keyset cursors while preserving offset listing', () => {
  const paths = workspace();
  let clock = '2026-08-29T02:00:00.000Z';
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
      now: () => new Date(clock),
    });
    for (const [index, externalId] of [
      'chat_a',
      'chat_b',
      'chat_c',
    ].entries()) {
      clock = `2026-08-29T02:00:0${index}.000Z`;
      store.commitRecord({
        record: {
          kind: 'chat',
          platform: 'gray-swan',
          externalId,
          title: externalId,
          normalized: { externalId },
        },
        evidence: [
          {
            artifactType: 'page_html',
            content: `<html>${externalId}</html>`,
          },
        ],
        checkpoint: {
          scope: `scope_${externalId}`,
          cursor: `cursor_${externalId}`,
          expectedVersion: 0,
        },
      });
    }

    const first = store.queryRecords({ platform: 'gray-swan', limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    assert.equal(first.items[0].externalId, 'chat_c');
    assert.equal(first.items[1].externalId, 'chat_b');
    const second = store.queryRecords({
      platform: 'gray-swan',
      limit: 2,
      cursor: first.nextCursor,
    });
    assert.deepEqual(
      second.items.map((item) => item.externalId),
      ['chat_a'],
    );
    assert.equal(second.nextCursor, null);
    assert.equal(
      store.listRecords({ limit: 1, offset: 1 })[0].externalId,
      'chat_b',
    );

    assert.throws(
      () =>
        store.queryRecords({
          kind: 'chat',
          platform: 'gray-swan',
          limit: 2,
          cursor: first.nextCursor,
        }),
      (error) => error?.code === 'QUERY_CURSOR_MISMATCH',
    );

    clock = '2026-08-29T02:00:04.000Z';
    store.commitRecord({
      record: {
        kind: 'submission',
        platform: 'gray-swan',
        externalId: 'submission_new',
        normalized: {},
      },
      evidence: [{ artifactType: 'page_html', content: '<html>new</html>' }],
      checkpoint: {
        scope: 'scope_submission_new',
        cursor: 'cursor_submission_new',
        expectedVersion: 0,
      },
    });
    assert.throws(
      () =>
        store.queryRecords({
          platform: 'gray-swan',
          limit: 2,
          cursor: first.nextCursor,
        }),
      (error) => error?.code === 'STALE_QUERY_CURSOR',
    );
    store.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('keyset cursors handle tied timestamps, malformed input, and catalog identity', () => {
  const firstPaths = workspace();
  const secondPaths = workspace();
  const commitFixture = (store, externalId) =>
    store.commitRecord({
      record: {
        kind: 'chat',
        platform: 'gray-swan',
        externalId,
        normalized: { externalId },
      },
      evidence: [
        { artifactType: 'page_html', content: `<html>${externalId}</html>` },
      ],
      checkpoint: {
        scope: `scope_${externalId}`,
        cursor: `cursor_${externalId}`,
        expectedVersion: 0,
      },
    });
  try {
    const now = () => new Date('2026-08-29T03:00:00.000Z');
    const firstStore = new ArchiveStore({
      databasePath: firstPaths.databasePath,
      evidenceDirectory: firstPaths.evidenceDirectory,
      now,
    });
    for (const id of ['tie_a', 'tie_b', 'tie_c']) commitFixture(firstStore, id);
    const expected = firstStore
      .listRecords({ limit: 10 })
      .map((item) => item.id);
    const seen = [];
    let cursor;
    do {
      const page = firstStore.queryRecords({ limit: 1, cursor });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, 3);
    assert.throws(
      () => firstStore.queryRecords({ cursor: 'not+a+cursor' }),
      (error) => error?.code === 'INVALID_CURSOR',
    );

    const stablePage = firstStore.queryRecords({ limit: 1 });
    commitFixture(firstStore, 'tie_a');
    assert.doesNotThrow(() =>
      firstStore.queryRecords({ limit: 1, cursor: stablePage.nextCursor }),
    );

    const secondStore = new ArchiveStore({
      databasePath: secondPaths.databasePath,
      evidenceDirectory: secondPaths.evidenceDirectory,
      now,
    });
    for (const id of ['tie_a', 'tie_b', 'tie_c'])
      commitFixture(secondStore, id);
    assert.throws(
      () =>
        secondStore.queryRecords({
          limit: 1,
          cursor: stablePage.nextCursor,
        }),
      (error) => error?.code === 'STALE_QUERY_CURSOR',
    );
    secondStore.close();
    firstStore.close();
  } finally {
    rmSync(firstPaths.directory, { recursive: true, force: true });
    rmSync(secondPaths.directory, { recursive: true, force: true });
  }
});
