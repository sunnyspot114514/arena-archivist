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

    assert.equal(archiveSchema.latestVersion, 5);
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
      5,
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
    assert.equal(reopened.schemaVersion, 5);
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
      request: {
        source: 'demo',
        maxRecords: 10,
        operation: 'sync_next_batch',
        rawBody: 'must-not-be-persisted',
      },
      authorization: {
        principal: 'local_operator',
        source: 'loopback_http_policy',
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
    assert.deepEqual(store.getAction(created.actionId)?.requestSummary, {
      maxRecords: 10,
      operation: 'sync_next_batch',
      source: 'demo',
    });
    const authorization = store.getAuthorizationForAction(created.actionId);
    assert.equal(authorization?.actionId, created.actionId);
    assert.equal(authorization?.syncRunId, created.runId);
    assert.equal(
      authorization?.requestHash,
      store.getAction(created.actionId)?.inputHash,
    );
    assert.equal(authorization?.principal, 'local_operator');
    assert.equal(authorization?.source, 'loopback_http_policy');
    assert.match(authorization?.scopeHash ?? '', /^sha256:[a-f0-9]{64}$/);
    assert.match(
      authorization?.authorizationHash ?? '',
      /^sha256:[a-f0-9]{64}$/,
    );

    assert.throws(
      () => store.commitRecord(chatInput({ runId: created.runId })),
      (error) => error?.code === 'ACTION_NOT_DISPATCHED',
    );
    assert.equal(store.countRecords('chat'), 0);
    assert.equal(store.getCheckpoint('chats'), null);
    assert.deepEqual(store.listSyncRecordCommits(created.runId), []);

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
    assert.throws(() =>
      database
        .prepare(
          "UPDATE action_authorizations SET principal = 'changed' WHERE action_id = ?",
        )
        .run(created.actionId),
    );
    assert.throws(() =>
      database
        .prepare('DELETE FROM action_authorizations WHERE action_id = ?')
        .run(created.actionId),
    );
    assert.throws(() =>
      database
        .prepare('DELETE FROM sync_record_commits WHERE sync_run_id = ?')
        .run(created.runId),
    );
    database.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('rejects an authorization scope hash that is not bound to the request', () => {
  const paths = workspace();
  try {
    const store = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.throws(
      () =>
        store.startAuthorizedSyncRun({
          id: 'run_bad_scope',
          actionId: 'action_bad_scope',
          connectorId: 'gray-swan',
          connectorVersion: '1.0.0',
          policyVersion: 'arena-read-only-sync-v1',
          request: { source: 'demo', maxRecords: 1 },
          authorization: {
            principal: 'loopback_runtime_client',
            decisionCode: 'bounded_readonly_policy_allow',
            scopeHash: `sha256:${'0'.repeat(64)}`,
          },
        }),
      (error) => error?.code === 'AUTHORIZATION_SCOPE_MISMATCH',
    );
    assert.equal(store.getSyncRun('run_bad_scope'), null);
    assert.equal(store.getAction('action_bad_scope'), null);
    store.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('upgrades a v3 database, scrubs legacy request bodies, and creates new authorization rows', () => {
  const paths = workspace();
  try {
    const initial = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    initial.startAuthorizedSyncRun({
      id: 'run_legacy_v3',
      actionId: 'action_legacy_v3',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    const legacyDispatched = initial.startAuthorizedSyncRun({
      id: 'run_legacy_dispatch_v3',
      actionId: 'action_legacy_dispatch_v3',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'live', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    initial.advanceAction(legacyDispatched.actionId, 'dispatch');
    initial.close();

    const legacy = new DatabaseSync(paths.databasePath);
    for (const trigger of [
      'action_authorizations_append_only_update',
      'action_authorizations_append_only_delete',
      'action_authorizations_action_binding',
      'sync_record_commits_action_run_match',
      'sync_record_commits_authorization_required',
      'sync_record_commits_append_only_update',
      'sync_record_commits_append_only_delete',
    ]) {
      legacy.exec(`DROP TRIGGER ${trigger}`);
    }
    legacy.exec('DROP INDEX action_authorizations_run_idx');
    legacy.exec('DROP TABLE action_authorizations');
    legacy.prepare('DELETE FROM schema_migrations WHERE version >= 4').run();
    legacy
      .prepare('UPDATE action_ledger_actions SET request_json = ?')
      .run('{"rawBody":"legacy-sensitive-body"}');
    legacy.exec('PRAGMA user_version = 3');
    legacy.close();

    const upgraded = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.equal(upgraded.schemaVersion, 5);
    assert.deepEqual(
      upgraded.getAction('action_legacy_v3')?.requestSummary,
      {},
    );
    assert.equal(upgraded.getAuthorizationForAction('action_legacy_v3'), null);
    assert.equal(
      upgraded.getAuthorizationForAction('action_legacy_dispatch_v3'),
      null,
    );
    assert.throws(
      () => upgraded.advanceAction('action_legacy_v3', 'dispatch'),
      (error) => error?.code === 'ACTION_AUTHORIZATION_REQUIRED',
    );
    const forgedDatabase = new DatabaseSync(paths.databasePath);
    const legacyAction = forgedDatabase
      .prepare(
        `SELECT action_id, sync_run_id, input_hash, policy_version,
                connector_id, connector_version
         FROM action_ledger_actions WHERE action_id = ?`,
      )
      .get('action_legacy_v3');
    const forgedAuthorization = {
      authorizationId: 'authorization_forged_scope',
      actionId: legacyAction.action_id,
      syncRunId: legacyAction.sync_run_id,
      requestHash: legacyAction.input_hash,
      scopeHash: `sha256:${'0'.repeat(64)}`,
      policyVersion: legacyAction.policy_version,
      connectorId: legacyAction.connector_id,
      connectorVersion: legacyAction.connector_version,
      principal: 'forged_principal',
      source: 'forged_source',
      decisionCode: 'forged_decision',
      authorizedAt: '2026-08-29T00:00:00.000Z',
    };
    const forgedAuthorizationHash = hashCanonicalJson({
      version: 'action_authorization_v1',
      ...forgedAuthorization,
    });
    forgedDatabase
      .prepare(
        `INSERT INTO action_authorizations
          (authorization_id, action_id, sync_run_id, request_hash, scope_hash,
           policy_version, connector_id, connector_version, principal, source,
           decision_code, authorized_at, authorization_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        forgedAuthorization.authorizationId,
        forgedAuthorization.actionId,
        forgedAuthorization.syncRunId,
        forgedAuthorization.requestHash,
        forgedAuthorization.scopeHash,
        forgedAuthorization.policyVersion,
        forgedAuthorization.connectorId,
        forgedAuthorization.connectorVersion,
        forgedAuthorization.principal,
        forgedAuthorization.source,
        forgedAuthorization.decisionCode,
        forgedAuthorization.authorizedAt,
        forgedAuthorizationHash,
      );
    forgedDatabase.close();
    assert.throws(
      () => upgraded.getAuthorizationForAction('action_legacy_v3'),
      (error) => error?.code === 'CORRUPT_DATABASE',
    );
    assert.throws(
      () => upgraded.advanceAction('action_legacy_v3', 'dispatch'),
      (error) => error?.code === 'CORRUPT_DATABASE',
    );
    assert.throws(
      () =>
        upgraded.commitRecord({
          runId: 'run_legacy_dispatch_v3',
          record: {
            kind: 'chat',
            platform: 'gray-swan',
            externalId: 'legacy_unbound_chat',
            normalized: {},
          },
          evidence: [
            { artifactType: 'page_html', content: '<html>legacy</html>' },
          ],
          checkpoint: {
            scope: 'legacy_unbound_scope',
            cursor: 'legacy_unbound_cursor',
            expectedVersion: 0,
          },
        }),
      (error) => error?.code === 'ACTION_AUTHORIZATION_REQUIRED',
    );
    assert.equal(
      upgraded.getRecord('chat', 'gray-swan', 'legacy_unbound_chat'),
      null,
    );
    assert.equal(upgraded.getCheckpoint('legacy_unbound_scope'), null);
    assert.throws(
      () =>
        upgraded.settleSyncRunAction({
          runId: 'run_legacy_dispatch_v3',
          status: 'completed',
          reconciliation: { workerCommitted: 0 },
        }),
      (error) => error?.code === 'ACTION_AUTHORIZATION_REQUIRED',
    );
    assert.equal(
      upgraded.getAction('action_legacy_dispatch_v3')?.currentPhase,
      'dispatch',
    );
    assert.equal(
      upgraded.getSyncRun('run_legacy_dispatch_v3')?.status,
      'running',
    );
    upgraded.settleSyncRunAction({
      runId: 'run_legacy_v3',
      status: 'failed',
      stopReason: 'authorization_binding_missing',
    });
    upgraded.settleSyncRunAction({
      runId: 'run_legacy_dispatch_v3',
      status: 'failed',
      stopReason: 'authorization_binding_missing',
    });
    const created = upgraded.startAuthorizedSyncRun({
      id: 'run_after_v4',
      actionId: 'action_after_v4',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    assert.equal(
      upgraded.getAuthorizationForAction(created.actionId)?.syncRunId,
      created.runId,
    );
    upgraded.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('upgrades an existing v4 database without rewriting its migration checksum', () => {
  const paths = workspace();
  try {
    const initial = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    const created = initial.startAuthorizedSyncRun({
      id: 'run_existing_v4',
      actionId: 'action_existing_v4',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    initial.close();

    const versionFour = new DatabaseSync(paths.databasePath);
    versionFour.exec('DROP TRIGGER action_authorizations_action_binding');
    versionFour.exec('DROP TRIGGER sync_record_commits_authorization_required');
    versionFour
      .prepare('DELETE FROM schema_migrations WHERE version = 5')
      .run();
    versionFour.exec('PRAGMA user_version = 4');
    versionFour.close();

    const upgraded = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    assert.equal(upgraded.schemaVersion, 5);
    assert.equal(
      upgraded.getAuthorizationForAction(created.actionId)?.syncRunId,
      created.runId,
    );
    upgraded.advanceAction(created.actionId, 'dispatch');
    upgraded.settleSyncRunAction({
      runId: created.runId,
      status: 'stopped',
      stopReason: 'user_paused',
      terminalPhase: 'cancelled',
    });
    upgraded.close();
  } finally {
    rmSync(paths.directory, { recursive: true, force: true });
  }
});

test('fails a legacy upgrade atomically when an action/run commit link is mismatched', () => {
  const paths = workspace();
  try {
    const initial = new ArchiveStore({
      databasePath: paths.databasePath,
      evidenceDirectory: paths.evidenceDirectory,
    });
    const first = initial.startAuthorizedSyncRun({
      id: 'run_migration_link_first',
      actionId: 'action_migration_link_first',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    const second = initial.startAuthorizedSyncRun({
      id: 'run_migration_link_second',
      actionId: 'action_migration_link_second',
      connectorId: 'gray-swan',
      connectorVersion: '1.0.0',
      policyVersion: 'arena-read-only-sync-v1',
      request: { source: 'demo', maxRecords: 1 },
      authorization: {
        principal: 'loopback_runtime_client',
        decisionCode: 'bounded_readonly_policy_allow',
      },
    });
    initial.advanceAction(first.actionId, 'dispatch');
    initial.commitRecord({
      runId: first.runId,
      record: {
        kind: 'chat',
        platform: 'gray-swan',
        externalId: 'migration_link_chat',
        normalized: {},
      },
      evidence: [
        { artifactType: 'page_html', content: '<html>migration</html>' },
      ],
      checkpoint: {
        scope: 'migration_link_scope',
        cursor: 'migration_link_cursor',
        expectedVersion: 0,
      },
    });
    initial.close();

    const legacy = new DatabaseSync(paths.databasePath);
    for (const trigger of [
      'action_authorizations_action_binding',
      'action_authorizations_append_only_update',
      'action_authorizations_append_only_delete',
      'sync_record_commits_action_run_match',
      'sync_record_commits_authorization_required',
      'sync_record_commits_append_only_update',
      'sync_record_commits_append_only_delete',
    ]) {
      legacy.exec(`DROP TRIGGER ${trigger}`);
    }
    legacy.exec('DROP INDEX action_authorizations_run_idx');
    legacy.exec('DROP TABLE action_authorizations');
    legacy.prepare('DELETE FROM schema_migrations WHERE version >= 4').run();
    legacy
      .prepare(
        'UPDATE sync_record_commits SET sync_run_id = ? WHERE action_id = ?',
      )
      .run(second.runId, first.actionId);
    legacy.exec('PRAGMA user_version = 3');
    legacy.close();

    assert.throws(
      () =>
        new ArchiveStore({
          databasePath: paths.databasePath,
          evidenceDirectory: paths.evidenceDirectory,
        }),
      (error) => error?.code === 'CORRUPT_SCHEMA',
    );
    const unchanged = new DatabaseSync(paths.databasePath);
    assert.equal(
      Number(unchanged.prepare('PRAGMA user_version').get().user_version),
      3,
    );
    assert.equal(
      unchanged
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'action_authorizations'",
        )
        .get().count,
      0,
    );
    unchanged.close();
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
