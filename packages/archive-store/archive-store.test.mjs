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

    assert.equal(archiveSchema.latestVersion, 2);
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
      2,
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
    assert.equal(reopened.schemaVersion, 2);
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
