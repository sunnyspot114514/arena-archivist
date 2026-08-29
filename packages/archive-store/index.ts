import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type DataPolicy =
  | 'local_only'
  | 'direct_provider_only'
  | 'zdr_router_allowed'
  | 'public';

export interface RawEvidence {
  artifactType: string;
  content: string | Uint8Array;
  mediaType?: string;
  fileExtension?: string;
  capturedAt?: string;
  metadata?: Record<string, JsonValue>;
}

export interface ArchivedMessage {
  externalId?: string;
  ordinal: number;
  role: string;
  content: string;
  sourceHash?: string;
  createdAt?: string;
}

export interface ArchivedJudgeResult {
  externalId?: string;
  judgeName?: string;
  verdict?: string;
  score?: number;
  explanation?: string;
  sourceHash?: string;
}

interface RecordBase {
  platform: string;
  externalId: string;
  normalized: Record<string, JsonValue>;
  dataPolicy?: DataPolicy;
  externalProcessingAllowed?: boolean;
  embargoUntil?: string | null;
}

export interface ChatRecord extends RecordBase {
  kind: 'chat';
  title?: string;
  status?: string;
  challengeId?: string;
  messages?: ArchivedMessage[];
}

export interface SubmissionRecord extends RecordBase {
  kind: 'submission';
  outcome?: string;
  challengeId?: string;
  chatId?: string;
  judgeResults?: ArchivedJudgeResult[];
}

export type ArchiveRecord = ChatRecord | SubmissionRecord;

export interface CheckpointAdvance {
  scope: string;
  cursor: string;
  state?: Record<string, JsonValue>;
  expectedVersion?: number;
}

export interface CommitRecordInput {
  record: ArchiveRecord;
  evidence: RawEvidence[];
  checkpoint: CheckpointAdvance;
  runId?: string;
}

export interface StoredArtifact {
  id: string;
  artifactType: string;
  contentHash: string;
  byteLength: number;
  mediaType: string;
  storagePath: string;
  capturedAt: string;
  metadata: Record<string, JsonValue>;
}

interface PreparedArtifact extends StoredArtifact {
  absolutePath: string;
  createdThisCall: boolean;
}

export interface CommitRecordResult {
  recordId: string;
  sourceHash: string;
  disposition: 'inserted' | 'updated' | 'unchanged';
  artifacts: StoredArtifact[];
  checkpoint: StoredCheckpoint;
}

export interface StoredCheckpoint {
  scope: string;
  cursor: string;
  state: Record<string, JsonValue>;
  recordId: string;
  sourceHash: string;
  version: number;
  updatedAt: string;
}

export interface RecordListOptions {
  kind?: ArchiveRecord['kind'];
  limit?: number;
  offset?: number;
}

export interface StoredRecordSummary {
  id: string;
  kind: ArchiveRecord['kind'];
  platform: string;
  externalId: string;
  sourceHash: string;
  dataPolicy: DataPolicy;
  externalProcessingAllowed: boolean;
  embargoUntil: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

export interface StoredArchivedMessage {
  id: string;
  externalId: string | null;
  ordinal: number;
  role: string;
  content: string;
  sourceHash: string;
  createdAt: string | null;
  updatedAt: string;
}

export interface StoredArchivedJudgeResult {
  id: string;
  externalId: string | null;
  judgeName: string | null;
  verdict: string | null;
  score: number | null;
  explanation: string | null;
  sourceHash: string;
  updatedAt: string;
}

export interface StoredArchiveRecord extends StoredRecordSummary {
  title: string | null;
  status: string | null;
  outcome: string | null;
  challengeId: string | null;
  chatId: string | null;
  normalized: Record<string, JsonValue>;
  messages: StoredArchivedMessage[];
  judgeResults: StoredArchivedJudgeResult[];
  artifacts: StoredArtifact[];
}

export type SyncRunStatus = 'running' | 'completed' | 'stopped' | 'failed';

export interface StoredSyncRun {
  id: string;
  startedAt: string;
  completedAt: string | null;
  status: SyncRunStatus;
  requestedMaxRecords: number | null;
  recordsCommitted: number;
  stopReason: string | null;
  metadata: Record<string, JsonValue>;
}

export interface SyncRunListOptions {
  status?: SyncRunStatus;
  limit?: number;
  offset?: number;
}

export interface PolicyDecisionListOptions {
  layer?: string;
  allowed?: boolean;
  limit?: number;
  offset?: number;
}

export interface StoredPolicyDecision {
  id: string;
  occurredAt: string;
  layer: string;
  mode: string;
  allowed: boolean;
  reason: string;
  action: string | null;
  origin: string | null;
  metadata: Record<string, JsonValue>;
}

export interface ArchiveStoreStats {
  chats: number;
  submissions: number;
  messages: number;
  judgeResults: number;
  sourceArtifacts: number;
  policyDecisions: number;
  syncRuns: number;
  activeSyncRuns: number;
  checkpoints: number;
}

export type WalCheckpointMode = 'FULL' | 'TRUNCATE';

export interface WalCheckpointResult {
  mode: WalCheckpointMode;
  busy: number;
  logFrames: number;
  checkpointedFrames: number;
}

export interface PreparedArchiveExport {
  databasePath: string;
  schemaVersion: number;
  preparedAt: string;
  walCheckpoint: WalCheckpointResult;
  stats: ArchiveStoreStats;
}

export interface ArchiveStoreOptions {
  databasePath: string;
  evidenceDirectory: string;
  now?: () => Date;
}

export interface SyncRunInput {
  id?: string;
  requestedMaxRecords?: number;
  metadata?: Record<string, JsonValue>;
}

export interface PolicyDecisionInput {
  id: string;
  occurredAt: string;
  layer: string;
  mode: string;
  allowed: boolean;
  reason: string;
  action?: string;
  origin?: string;
  metadata?: Record<string, JsonValue>;
}

export class ArchiveStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ArchiveStoreError';
    this.code = code;
  }
}

export class StaleCheckpointError extends ArchiveStoreError {
  constructor(scope: string, expected: number, actual: number) {
    super(
      'STALE_CHECKPOINT',
      `Checkpoint ${JSON.stringify(scope)} expected version ${expected}, current version is ${actual}.`,
    );
    this.name = 'StaleCheckpointError';
  }
}

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_archive_schema',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE sync_runs (
        id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'stopped', 'failed')),
        requested_max_records INTEGER CHECK (requested_max_records IS NULL OR requested_max_records > 0),
        records_committed INTEGER NOT NULL DEFAULT 0 CHECK (records_committed >= 0),
        stop_reason TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE TABLE behaviors (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_behavior_id TEXT NOT NULL,
        name TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, external_behavior_id)
      ) STRICT;

      CREATE TABLE challenges (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_challenge_id TEXT NOT NULL,
        behavior_id TEXT REFERENCES behaviors(id),
        title TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, external_challenge_id)
      ) STRICT;

      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_chat_id TEXT NOT NULL,
        challenge_id TEXT REFERENCES challenges(id),
        title TEXT,
        status TEXT,
        source_hash TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        data_policy TEXT NOT NULL DEFAULT 'local_only'
          CHECK (data_policy IN ('local_only', 'direct_provider_only', 'zdr_router_allowed', 'public')),
        external_processing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (external_processing_allowed IN (0, 1)),
        embargo_until TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, external_chat_id)
      ) STRICT;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        external_message_id TEXT,
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE (chat_id, external_message_id),
        UNIQUE (chat_id, ordinal, source_hash)
      ) STRICT;

      CREATE TABLE submissions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        external_submission_id TEXT NOT NULL,
        challenge_id TEXT REFERENCES challenges(id),
        chat_id TEXT REFERENCES chats(id),
        outcome TEXT,
        source_hash TEXT NOT NULL,
        normalized_json TEXT NOT NULL,
        data_policy TEXT NOT NULL DEFAULT 'local_only'
          CHECK (data_policy IN ('local_only', 'direct_provider_only', 'zdr_router_allowed', 'public')),
        external_processing_allowed INTEGER NOT NULL DEFAULT 0 CHECK (external_processing_allowed IN (0, 1)),
        embargo_until TEXT,
        first_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (platform, external_submission_id)
      ) STRICT;

      CREATE TABLE judge_results (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
        external_judge_id TEXT,
        judge_name TEXT,
        verdict TEXT,
        score REAL,
        explanation TEXT,
        source_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (submission_id, external_judge_id, source_hash)
      ) STRICT;

      CREATE TABLE source_artifacts (
        id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL CHECK (record_type IN ('chat', 'submission', 'challenge', 'behavior', 'profile')),
        record_id TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
        media_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE (record_type, record_id, content_hash)
      ) STRICT;

      CREATE TABLE parser_events (
        id TEXT PRIMARY KEY,
        record_type TEXT,
        record_id TEXT,
        parser_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'warning', 'failure', 'proposal')),
        details_json TEXT NOT NULL DEFAULT '{}',
        occurred_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE model_annotations (
        id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL,
        record_id TEXT NOT NULL,
        taxonomy_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        labels_json TEXT NOT NULL,
        confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
        review_status TEXT NOT NULL DEFAULT 'unreviewed',
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE policy_decisions (
        id TEXT PRIMARY KEY,
        occurred_at TEXT NOT NULL,
        layer TEXT NOT NULL,
        mode TEXT NOT NULL,
        allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
        reason TEXT NOT NULL,
        action TEXT,
        origin TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;

      CREATE TABLE checkpoints (
        scope TEXT PRIMARY KEY,
        cursor TEXT NOT NULL,
        state_json TEXT NOT NULL DEFAULT '{}',
        record_id TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX chats_updated_at_idx ON chats(updated_at);
      CREATE INDEX submissions_updated_at_idx ON submissions(updated_at);
      CREATE INDEX messages_chat_ordinal_idx ON messages(chat_id, ordinal);
      CREATE INDEX artifacts_record_idx ON source_artifacts(record_type, record_id);
      CREATE INDEX policy_decisions_occurred_idx ON policy_decisions(occurred_at);
    `,
  },
  {
    version: 2,
    name: 'checkpoint_monotonicity',
    sql: `
      CREATE TRIGGER checkpoints_version_must_advance
      BEFORE UPDATE ON checkpoints
      WHEN NEW.version <= OLD.version
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint version must advance');
      END;
    `,
  },
];

const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

function sha256Bytes(content: Uint8Array): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function hashRawEvidence(content: string | Uint8Array): string {
  return sha256Bytes(
    typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
  );
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256')
    .update(parts.join('\u0000'))
    .digest('hex')
    .slice(0, 32);
  return `${prefix}_${digest}`;
}

function iso(date: Date): string {
  const value = date.toISOString();
  if (Number.isNaN(Date.parse(value))) {
    throw new ArchiveStoreError(
      'INVALID_TIME',
      'Clock returned an invalid date.',
    );
  }
  return value;
}

function requiredText(value: string, label: string, maxLength = 2048): string {
  const result = value.trim();
  if (!result || result.length > maxLength || result.includes('\u0000')) {
    throw new ArchiveStoreError(
      'INVALID_INPUT',
      `${label} must be non-empty and at most ${maxLength} characters.`,
    );
  }
  return result;
}

function pageBounds(limit = 50, offset = 0): { limit: number; offset: number } {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new ArchiveStoreError(
      'INVALID_INPUT',
      'limit must be an integer from 1 through 500.',
    );
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new ArchiveStoreError(
      'INVALID_INPUT',
      'offset must be a non-negative integer.',
    );
  }
  return { limit, offset };
}

function nullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  ) {
    return `${value}`;
  }
  throw new ArchiveStoreError(
    'CORRUPT_DATABASE',
    'A stored text value has an invalid type.',
  );
}

function assertSha256(value: string, label: string): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new ArchiveStoreError(
      'INVALID_INPUT',
      `${label} must be a lowercase prefixed SHA-256 digest.`,
    );
  }
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ArchiveStoreError(
      'INVALID_INPUT',
      `${label} must be an ISO-compatible timestamp.`,
    );
  }
}

function normalizeJsonValue(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ArchiveStoreError(
        'INVALID_JSON',
        'Archive JSON cannot contain NaN or infinity.',
      );
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new ArchiveStoreError(
      'INVALID_JSON',
      'Archive metadata must contain only JSON values.',
    );
  }
  if (seen.has(value)) {
    throw new ArchiveStoreError(
      'INVALID_JSON',
      'Archive metadata cannot contain cycles.',
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => normalizeJsonValue(item, seen));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ArchiveStoreError(
        'INVALID_JSON',
        'Archive metadata must use plain JSON objects.',
      );
    }
    const result = Object.create(null) as Record<string, JsonValue>;
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = normalizeJsonValue(
        (value as Record<string, unknown>)[key],
        seen,
      );
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function json(value: JsonValue | Record<string, JsonValue>): string {
  try {
    const result = JSON.stringify(normalizeJsonValue(value, new WeakSet()));
    if (result === undefined)
      throw new Error('Value is not JSON serializable.');
    return result;
  } catch (error) {
    if (error instanceof ArchiveStoreError) throw error;
    throw new ArchiveStoreError(
      'INVALID_JSON',
      'Archive metadata must be finite JSON data.',
      {
        cause: error,
      },
    );
  }
}

function parseObject(value: unknown): Record<string, JsonValue> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed === 'object'
      ? (parsed as Record<string, JsonValue>)
      : {};
  } catch {
    throw new ArchiveStoreError('CORRUPT_DATABASE', 'Stored JSON is invalid.');
  }
}

function safeSegment(value: string): string {
  const normalized = value
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^\.+/, '');
  return (normalized || stableId('record', value)).slice(0, 100);
}

function safeExtension(evidence: RawEvidence): string {
  const supplied = evidence.fileExtension?.replace(/^\./, '').toLowerCase();
  if (supplied && /^[a-z0-9]{1,12}$/.test(supplied)) return supplied;
  const mediaType = evidence.mediaType?.toLowerCase();
  if (mediaType === 'text/html') return 'html';
  if (mediaType === 'text/plain') return 'txt';
  if (mediaType === 'application/json') return 'json';
  if (mediaType === 'image/png') return 'png';
  return 'bin';
}

function assertWithin(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new ArchiveStoreError(
      'UNSAFE_PATH',
      'Evidence path escaped the configured evidence directory.',
    );
  }
}

function migrationChecksum(migration: Migration): string {
  return hashRawEvidence(
    `${migration.version}\n${migration.name}\n${migration.sql}`,
  );
}

export class ArchiveStore {
  readonly databasePath: string;
  readonly evidenceDirectory: string;
  readonly schemaVersion = LATEST_SCHEMA_VERSION;

  private readonly database: DatabaseSync;
  private readonly now: () => Date;
  private closed = false;

  constructor(options: ArchiveStoreOptions) {
    this.databasePath =
      options.databasePath === ':memory:'
        ? ':memory:'
        : resolve(options.databasePath);
    this.evidenceDirectory = resolve(options.evidenceDirectory);
    this.now = options.now ?? (() => new Date());

    if (this.databasePath !== ':memory:')
      mkdirSync(dirname(this.databasePath), { recursive: true });
    mkdirSync(this.evidenceDirectory, { recursive: true });

    this.database = new DatabaseSync(this.databasePath);
    this.database.exec(
      'PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;',
    );
    if (this.databasePath !== ':memory:')
      this.database.exec('PRAGMA journal_mode = WAL;');
    this.applyMigrations();
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  startSyncRun(input: SyncRunInput = {}): string {
    this.assertOpen();
    const id = requiredText(input.id ?? `run_${randomUUID()}`, 'run.id');
    const requested = input.requestedMaxRecords ?? null;
    if (
      requested !== null &&
      (!Number.isSafeInteger(requested) || requested <= 0)
    ) {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'requestedMaxRecords must be a positive integer.',
      );
    }
    this.database
      .prepare(
        `INSERT INTO sync_runs
          (id, started_at, status, requested_max_records, metadata_json)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(id, iso(this.now()), requested, json(input.metadata ?? {}));
    return id;
  }

  finishSyncRun(
    runId: string,
    status: 'completed' | 'stopped' | 'failed',
    stopReason?: string,
  ): void {
    this.assertOpen();
    const result = this.database
      .prepare(
        `UPDATE sync_runs
         SET completed_at = ?, status = ?, stop_reason = ?
         WHERE id = ? AND status = 'running'`,
      )
      .run(
        iso(this.now()),
        status,
        stopReason ?? null,
        requiredText(runId, 'runId'),
      );
    if (Number(result.changes) !== 1) {
      throw new ArchiveStoreError(
        'RUN_NOT_ACTIVE',
        'Sync run does not exist or is already finished.',
      );
    }
  }

  commitRecord(input: CommitRecordInput): CommitRecordResult {
    this.assertOpen();
    this.validateCommit(input);

    const recordId = stableId(
      input.record.kind,
      input.record.platform,
      input.record.externalId,
    );
    const prepared: PreparedArtifact[] = [];
    try {
      for (const item of input.evidence) {
        prepared.push(this.persistEvidence(input.record.kind, recordId, item));
      }
    } catch (error) {
      this.compensateOrThrow(prepared, error);
    }
    try {
      const artifacts = prepared.map((artifact) =>
        this.publicArtifact(artifact),
      );
      const sourceHash = this.combinedSourceHash(artifacts);
      const now = iso(this.now());
      return this.transaction(() => {
        const disposition = this.upsertRecord(
          input.record,
          recordId,
          sourceHash,
          now,
        );
        if (disposition !== 'unchanged') {
          this.replaceChildren(input.record, recordId, sourceHash, now);
        }
        this.upsertArtifacts(input.record.kind, recordId, artifacts);

        if (input.runId) {
          const active = this.database
            .prepare('SELECT status FROM sync_runs WHERE id = ?')
            .get(input.runId) as { status?: unknown } | undefined;
          if (active?.status !== 'running') {
            throw new ArchiveStoreError(
              'RUN_NOT_ACTIVE',
              'Cannot commit a record to an inactive sync run.',
            );
          }
          if (disposition !== 'unchanged') {
            this.database
              .prepare(
                'UPDATE sync_runs SET records_committed = records_committed + 1 WHERE id = ?',
              )
              .run(input.runId);
          }
        }

        // This is intentionally the final write in the transaction. Any parse, record,
        // artifact, run, or checkpoint failure rolls the entire canonical commit back.
        const checkpoint = this.advanceCheckpoint(
          input.checkpoint,
          recordId,
          sourceHash,
          now,
        );
        return { recordId, sourceHash, disposition, artifacts, checkpoint };
      });
    } catch (error) {
      this.compensateOrThrow(prepared, error);
    }
  }

  getCheckpoint(scope: string): StoredCheckpoint | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT scope, cursor, state_json, record_id, source_hash, version, updated_at
         FROM checkpoints WHERE scope = ?`,
      )
      .get(requiredText(scope, 'scope')) as Record<string, unknown> | undefined;
    return row ? this.checkpointFromRow(row) : null;
  }

  listRecords(options: RecordListOptions = {}): StoredRecordSummary[] {
    this.assertOpen();
    if (
      options.kind !== undefined &&
      options.kind !== 'chat' &&
      options.kind !== 'submission'
    ) {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'Unknown archive record kind.',
      );
    }
    const { limit, offset } = pageBounds(options.limit, options.offset);
    let sql: string;
    if (options.kind === 'chat') {
      sql = `
        SELECT id, 'chat' AS kind, platform, external_chat_id AS external_id, source_hash,
               data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at
        FROM chats ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`;
    } else if (options.kind === 'submission') {
      sql = `
        SELECT id, 'submission' AS kind, platform, external_submission_id AS external_id, source_hash,
               data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at
        FROM submissions ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`;
    } else {
      sql = `
        SELECT * FROM (
          SELECT id, 'chat' AS kind, platform, external_chat_id AS external_id, source_hash,
                 data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at
          FROM chats
          UNION ALL
          SELECT id, 'submission' AS kind, platform, external_submission_id AS external_id, source_hash,
                 data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at
          FROM submissions
        ) ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?`;
    }
    const rows = this.database.prepare(sql).all(limit, offset) as Record<
      string,
      unknown
    >[];
    return rows.map((row) => this.summaryFromRow(row));
  }

  getRecordById(recordId: string): StoredArchiveRecord | null {
    this.assertOpen();
    const id = requiredText(recordId, 'recordId');
    const row = this.database
      .prepare(
        `SELECT * FROM (
           SELECT id, 'chat' AS kind, platform, external_chat_id AS external_id,
                  challenge_id, NULL AS chat_id, title, status, NULL AS outcome,
                  source_hash, normalized_json, data_policy, external_processing_allowed,
                  embargo_until, first_seen_at, updated_at
           FROM chats
           UNION ALL
           SELECT id, 'submission' AS kind, platform, external_submission_id AS external_id,
                  challenge_id, chat_id, NULL AS title, NULL AS status, outcome,
                  source_hash, normalized_json, data_policy, external_processing_allowed,
                  embargo_until, first_seen_at, updated_at
           FROM submissions
         ) WHERE id = ? LIMIT 1`,
      )
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;

    const kind = row.kind === 'chat' ? 'chat' : 'submission';
    const messages: StoredArchivedMessage[] =
      kind === 'chat'
        ? (
            this.database
              .prepare(
                `SELECT id, external_message_id, ordinal, role, content, source_hash, created_at, updated_at
               FROM messages WHERE chat_id = ? ORDER BY ordinal ASC, id ASC`,
              )
              .all(id) as Record<string, unknown>[]
          ).map((message) => ({
            id: String(message.id),
            externalId: nullableString(message.external_message_id),
            ordinal: Number(message.ordinal),
            role: String(message.role),
            content: String(message.content),
            sourceHash: String(message.source_hash),
            createdAt: nullableString(message.created_at),
            updatedAt: String(message.updated_at),
          }))
        : [];
    const judgeResults: StoredArchivedJudgeResult[] =
      kind === 'submission'
        ? (
            this.database
              .prepare(
                `SELECT id, external_judge_id, judge_name, verdict, score, explanation, source_hash, updated_at
               FROM judge_results WHERE submission_id = ? ORDER BY id ASC`,
              )
              .all(id) as Record<string, unknown>[]
          ).map((result) => ({
            id: String(result.id),
            externalId: nullableString(result.external_judge_id),
            judgeName: nullableString(result.judge_name),
            verdict: nullableString(result.verdict),
            score:
              result.score === null || result.score === undefined
                ? null
                : Number(result.score),
            explanation: nullableString(result.explanation),
            sourceHash: String(result.source_hash),
            updatedAt: String(result.updated_at),
          }))
        : [];
    const artifacts = (
      this.database
        .prepare(
          `SELECT id, artifact_type, content_hash, byte_length, media_type, storage_path,
                  captured_at, metadata_json
           FROM source_artifacts WHERE record_type = ? AND record_id = ?
           ORDER BY captured_at ASC, id ASC`,
        )
        .all(kind, id) as Record<string, unknown>[]
    ).map((artifact) => this.artifactFromRow(artifact));
    return {
      ...this.summaryFromRow(row),
      title: nullableString(row.title),
      status: nullableString(row.status),
      outcome: nullableString(row.outcome),
      challengeId: nullableString(row.challenge_id),
      chatId: nullableString(row.chat_id),
      normalized: parseObject(row.normalized_json),
      messages,
      judgeResults,
      artifacts,
    };
  }

  getRecord(
    kind: ArchiveRecord['kind'],
    platform: string,
    externalId: string,
  ): StoredArchiveRecord | null {
    this.assertOpen();
    if (kind !== 'chat' && kind !== 'submission') {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'Unknown archive record kind.',
      );
    }
    const table = kind === 'chat' ? 'chats' : 'submissions';
    const externalColumn =
      kind === 'chat' ? 'external_chat_id' : 'external_submission_id';
    const row = this.database
      .prepare(
        `SELECT id FROM ${table} WHERE platform = ? AND ${externalColumn} = ?`,
      )
      .get(
        requiredText(platform, 'platform'),
        requiredText(externalId, 'externalId'),
      ) as { id?: unknown } | undefined;
    return typeof row?.id === 'string' && row.id
      ? this.getRecordById(row.id)
      : null;
  }

  stats(): ArchiveStoreStats {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM chats) AS chats,
           (SELECT COUNT(*) FROM submissions) AS submissions,
           (SELECT COUNT(*) FROM messages) AS messages,
           (SELECT COUNT(*) FROM judge_results) AS judge_results,
           (SELECT COUNT(*) FROM source_artifacts) AS source_artifacts,
           (SELECT COUNT(*) FROM policy_decisions) AS policy_decisions,
           (SELECT COUNT(*) FROM sync_runs) AS sync_runs,
           (SELECT COUNT(*) FROM sync_runs WHERE status = 'running') AS active_sync_runs,
           (SELECT COUNT(*) FROM checkpoints) AS checkpoints`,
      )
      .get() as Record<string, unknown>;
    return {
      chats: Number(row.chats),
      submissions: Number(row.submissions),
      messages: Number(row.messages),
      judgeResults: Number(row.judge_results),
      sourceArtifacts: Number(row.source_artifacts),
      policyDecisions: Number(row.policy_decisions),
      syncRuns: Number(row.sync_runs),
      activeSyncRuns: Number(row.active_sync_runs),
      checkpoints: Number(row.checkpoints),
    };
  }

  checkpointWal(mode: WalCheckpointMode = 'TRUNCATE'): WalCheckpointResult {
    this.assertOpen();
    if (mode !== 'FULL' && mode !== 'TRUNCATE') {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'WAL checkpoint mode must be FULL or TRUNCATE.',
      );
    }
    const row = this.database
      .prepare(`PRAGMA wal_checkpoint(${mode})`)
      .get() as
      | {
          busy?: number | bigint;
          log?: number | bigint;
          checkpointed?: number | bigint;
        }
      | undefined;
    const result: WalCheckpointResult = {
      mode,
      busy: Number(row?.busy ?? 1),
      logFrames: Number(row?.log ?? -1),
      checkpointedFrames: Number(row?.checkpointed ?? -1),
    };
    if (
      result.busy !== 0 ||
      (result.logFrames >= 0 && result.checkpointedFrames < result.logFrames)
    ) {
      throw new ArchiveStoreError(
        'WAL_CHECKPOINT_INCOMPLETE',
        'SQLite WAL could not be fully checkpointed; refusing to prepare a stale export.',
      );
    }
    return result;
  }

  prepareExport(): PreparedArchiveExport {
    this.assertOpen();
    if (this.databasePath === ':memory:') {
      throw new ArchiveStoreError(
        'EXPORT_UNAVAILABLE',
        'An in-memory archive has no database file to export.',
      );
    }
    const walCheckpoint = this.checkpointWal('TRUNCATE');
    return {
      databasePath: this.databasePath,
      schemaVersion: this.schemaVersion,
      preparedAt: iso(this.now()),
      walCheckpoint,
      stats: this.stats(),
    };
  }

  getSyncRun(runId: string): StoredSyncRun | null {
    this.assertOpen();
    const row = this.database
      .prepare(
        `SELECT id, started_at, completed_at, status, requested_max_records,
                records_committed, stop_reason, metadata_json
         FROM sync_runs WHERE id = ?`,
      )
      .get(requiredText(runId, 'runId')) as Record<string, unknown> | undefined;
    return row ? this.syncRunFromRow(row) : null;
  }

  listSyncRuns(options: SyncRunListOptions = {}): StoredSyncRun[] {
    this.assertOpen();
    const { limit, offset } = pageBounds(options.limit, options.offset);
    if (
      options.status !== undefined &&
      !(['running', 'completed', 'stopped', 'failed'] as const).includes(
        options.status,
      )
    ) {
      throw new ArchiveStoreError('INVALID_INPUT', 'Unknown sync run status.');
    }
    const rows = options.status
      ? (this.database
          .prepare(
            `SELECT id, started_at, completed_at, status, requested_max_records,
                    records_committed, stop_reason, metadata_json
             FROM sync_runs WHERE status = ? ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`,
          )
          .all(options.status, limit, offset) as Record<string, unknown>[])
      : (this.database
          .prepare(
            `SELECT id, started_at, completed_at, status, requested_max_records,
                    records_committed, stop_reason, metadata_json
             FROM sync_runs ORDER BY started_at DESC, id ASC LIMIT ? OFFSET ?`,
          )
          .all(limit, offset) as Record<string, unknown>[]);
    return rows.map((row) => this.syncRunFromRow(row));
  }

  listPolicyDecisions(
    options: PolicyDecisionListOptions = {},
  ): StoredPolicyDecision[] {
    this.assertOpen();
    const { limit, offset } = pageBounds(options.limit, options.offset);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (options.layer !== undefined) {
      clauses.push('layer = ?');
      parameters.push(requiredText(options.layer, 'layer', 128));
    }
    if (options.allowed !== undefined) {
      clauses.push('allowed = ?');
      parameters.push(options.allowed ? 1 : 0);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .prepare(
        `SELECT id, occurred_at, layer, mode, allowed, reason, action, origin, metadata_json
         FROM policy_decisions${where}
         ORDER BY occurred_at DESC, id ASC LIMIT ? OFFSET ?`,
      )
      .all(...parameters, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      occurredAt: String(row.occurred_at),
      layer: String(row.layer),
      mode: String(row.mode),
      allowed: row.allowed === 1,
      reason: String(row.reason),
      action: nullableString(row.action),
      origin: nullableString(row.origin),
      metadata: parseObject(row.metadata_json),
    }));
  }

  countRecords(kind: ArchiveRecord['kind']): number {
    this.assertOpen();
    if (kind !== 'chat' && kind !== 'submission') {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'Unknown archive record kind.',
      );
    }
    const table = kind === 'chat' ? 'chats' : 'submissions';
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
      .get() as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  }

  appendPolicyDecision(decision: PolicyDecisionInput): void {
    this.assertOpen();
    this.database
      .prepare(
        `INSERT INTO policy_decisions
          (id, occurred_at, layer, mode, allowed, reason, action, origin, metadata_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        requiredText(decision.id, 'decision.id'),
        requiredText(decision.occurredAt, 'decision.occurredAt'),
        requiredText(decision.layer, 'decision.layer'),
        requiredText(decision.mode, 'decision.mode'),
        decision.allowed ? 1 : 0,
        requiredText(decision.reason, 'decision.reason', 4096),
        decision.action ?? null,
        decision.origin ?? null,
        json(decision.metadata ?? {}),
      );
  }

  private assertOpen(): void {
    if (this.closed)
      throw new ArchiveStoreError('STORE_CLOSED', 'Archive store is closed.');
  }

  private applyMigrations(): void {
    const row = this.database.prepare('PRAGMA user_version').get() as
      | { user_version?: number }
      | undefined;
    const current = Number(row?.user_version ?? 0);
    if (current > LATEST_SCHEMA_VERSION) {
      throw new ArchiveStoreError(
        'SCHEMA_TOO_NEW',
        `Database schema version ${current} is newer than supported version ${LATEST_SCHEMA_VERSION}.`,
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= current) {
        if (current >= 1) this.verifyAppliedMigration(migration);
        continue;
      }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(migration.sql);
        this.database
          .prepare(
            'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
          )
          .run(
            migration.version,
            migration.name,
            migrationChecksum(migration),
            iso(this.now()),
          );
        this.database.exec(`PRAGMA user_version = ${migration.version}`);
        this.database.exec('COMMIT');
      } catch (error) {
        try {
          this.database.exec('ROLLBACK');
        } catch {
          // Preserve the migration error; SQLite may already have rolled back.
        }
        throw new ArchiveStoreError(
          'MIGRATION_FAILED',
          `Failed to apply archive migration ${migration.version} (${migration.name}).`,
          { cause: error },
        );
      }
    }
  }

  private verifyAppliedMigration(migration: Migration): void {
    const table = this.database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
      )
      .get() as { present?: number } | undefined;
    if (!table) {
      throw new ArchiveStoreError(
        'CORRUPT_SCHEMA',
        'schema_migrations is missing from a migrated database.',
      );
    }
    const row = this.database
      .prepare('SELECT name, checksum FROM schema_migrations WHERE version = ?')
      .get(migration.version) as
      | { name?: unknown; checksum?: unknown }
      | undefined;
    if (
      row?.name !== migration.name ||
      row.checksum !== migrationChecksum(migration)
    ) {
      throw new ArchiveStoreError(
        'MIGRATION_DRIFT',
        `Applied migration ${migration.version} does not match this runtime.`,
      );
    }
  }

  private transaction<T>(work: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the original error.
      }
      throw error;
    }
  }

  private validateCommit(input: CommitRecordInput): void {
    requiredText(input.record.platform, 'record.platform');
    requiredText(input.record.externalId, 'record.externalId');
    requiredText(input.checkpoint.scope, 'checkpoint.scope');
    requiredText(input.checkpoint.cursor, 'checkpoint.cursor');
    json(input.record.normalized);
    json(input.checkpoint.state ?? {});
    const dataPolicy = input.record.dataPolicy ?? 'local_only';
    if (
      dataPolicy !== 'local_only' &&
      dataPolicy !== 'direct_provider_only' &&
      dataPolicy !== 'zdr_router_allowed' &&
      dataPolicy !== 'public'
    ) {
      throw new ArchiveStoreError(
        'INVALID_INPUT',
        'record.dataPolicy is invalid.',
      );
    }
    if (
      dataPolicy === 'local_only' &&
      input.record.externalProcessingAllowed === true
    ) {
      throw new ArchiveStoreError(
        'DATA_POLICY_CONFLICT',
        'A local_only record cannot allow external processing.',
      );
    }
    if (
      input.record.embargoUntil !== undefined &&
      input.record.embargoUntil !== null
    ) {
      assertTimestamp(input.record.embargoUntil, 'record.embargoUntil');
    }
    if (input.evidence.length === 0) {
      throw new ArchiveStoreError(
        'MISSING_EVIDENCE',
        'A canonical record commit requires raw evidence.',
      );
    }
    if (input.checkpoint.expectedVersion !== undefined) {
      if (
        !Number.isInteger(input.checkpoint.expectedVersion) ||
        input.checkpoint.expectedVersion < 0
      ) {
        throw new ArchiveStoreError(
          'INVALID_INPUT',
          'checkpoint.expectedVersion must be a non-negative integer.',
        );
      }
    }
    if (input.record.kind === 'chat') {
      for (const message of input.record.messages ?? []) {
        if (!Number.isInteger(message.ordinal) || message.ordinal < 0) {
          throw new ArchiveStoreError(
            'INVALID_INPUT',
            'Message ordinal must be a non-negative integer.',
          );
        }
        requiredText(message.role, 'message.role');
        if (message.sourceHash)
          assertSha256(message.sourceHash, 'message.sourceHash');
        if (message.createdAt)
          assertTimestamp(message.createdAt, 'message.createdAt');
      }
    }
    if (input.record.kind === 'submission') {
      for (const result of input.record.judgeResults ?? []) {
        if (result.score !== undefined && !Number.isFinite(result.score)) {
          throw new ArchiveStoreError(
            'INVALID_INPUT',
            'Judge score must be finite.',
          );
        }
        if (result.sourceHash)
          assertSha256(result.sourceHash, 'judgeResult.sourceHash');
      }
    }
    for (const evidence of input.evidence) {
      if (evidence.capturedAt)
        assertTimestamp(evidence.capturedAt, 'evidence.capturedAt');
      json(evidence.metadata ?? {});
    }
  }

  private persistEvidence(
    recordType: ArchiveRecord['kind'],
    recordId: string,
    evidence: RawEvidence,
  ): PreparedArtifact {
    const artifactType = requiredText(
      evidence.artifactType,
      'evidence.artifactType',
      128,
    );
    const bytes =
      typeof evidence.content === 'string'
        ? Buffer.from(evidence.content, 'utf8')
        : Buffer.from(evidence.content);
    const contentHash = hashRawEvidence(bytes);
    const hashHex = contentHash.slice('sha256:'.length);
    const directory = resolve(
      this.evidenceDirectory,
      `${recordType}s`,
      safeSegment(recordId),
    );
    const finalPath = resolve(
      directory,
      `${hashHex}.${safeExtension(evidence)}`,
    );
    assertWithin(this.evidenceDirectory, finalPath);
    mkdirSync(directory, { recursive: true });
    let createdThisCall = false;

    if (existsSync(finalPath)) {
      if (hashRawEvidence(readFileSync(finalPath)) !== contentHash) {
        throw new ArchiveStoreError(
          'EVIDENCE_COLLISION',
          'Existing evidence content does not match its SHA-256 path.',
        );
      }
    } else {
      const temporaryPath = join(directory, `.${hashHex}.${randomUUID()}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporaryPath, 'wx', 0o600);
        writeFileSync(descriptor, bytes);
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporaryPath, finalPath);
        createdThisCall = true;
      } catch (error) {
        if (descriptor !== undefined) closeSync(descriptor);
        try {
          unlinkSync(temporaryPath);
        } catch {
          // The file may already have been atomically renamed or never created.
        }
        if (
          existsSync(finalPath) &&
          hashRawEvidence(readFileSync(finalPath)) === contentHash
        ) {
          // A concurrent content-addressed writer won the race.
        } else {
          throw new ArchiveStoreError(
            'EVIDENCE_WRITE_FAILED',
            'Could not durably store raw evidence.',
            {
              cause: error,
            },
          );
        }
      }
    }

    const storagePath = relative(this.evidenceDirectory, finalPath)
      .split(sep)
      .join('/');
    return {
      id: stableId('artifact', recordType, recordId, contentHash),
      artifactType,
      contentHash,
      byteLength: bytes.byteLength,
      mediaType: evidence.mediaType ?? 'application/octet-stream',
      storagePath,
      capturedAt: evidence.capturedAt ?? iso(this.now()),
      metadata: evidence.metadata ?? {},
      absolutePath: finalPath,
      createdThisCall,
    };
  }

  private publicArtifact(artifact: PreparedArtifact): StoredArtifact {
    return {
      id: artifact.id,
      artifactType: artifact.artifactType,
      contentHash: artifact.contentHash,
      byteLength: artifact.byteLength,
      mediaType: artifact.mediaType,
      storagePath: artifact.storagePath,
      capturedAt: artifact.capturedAt,
      metadata: artifact.metadata,
    };
  }

  private compensateOrThrow(
    prepared: readonly PreparedArtifact[],
    originalError: unknown,
  ): never {
    const compensationErrors: unknown[] = [];
    for (const artifact of prepared) {
      if (!artifact.createdThisCall) continue;
      try {
        const referenced = this.database
          .prepare(
            'SELECT 1 AS present FROM source_artifacts WHERE storage_path = ? LIMIT 1',
          )
          .get(artifact.storagePath) as { present?: number } | undefined;
        if (!referenced && existsSync(artifact.absolutePath))
          unlinkSync(artifact.absolutePath);
      } catch (error) {
        compensationErrors.push(error);
      }
    }
    if (compensationErrors.length > 0) {
      throw new ArchiveStoreError(
        'COMPENSATION_FAILED',
        'The archive commit failed and one or more unreferenced evidence files could not be removed.',
        { cause: new AggregateError([originalError, ...compensationErrors]) },
      );
    }
    throw originalError;
  }

  private combinedSourceHash(artifacts: StoredArtifact[]): string {
    const canonical = [...artifacts]
      .sort((left, right) =>
        `${left.artifactType}\u0000${left.contentHash}`.localeCompare(
          `${right.artifactType}\u0000${right.contentHash}`,
        ),
      )
      .map((item) => `${item.artifactType}\u0000${item.contentHash}`)
      .join('\n');
    return hashRawEvidence(canonical);
  }

  private upsertRecord(
    record: ArchiveRecord,
    recordId: string,
    sourceHash: string,
    now: string,
  ): CommitRecordResult['disposition'] {
    const table = record.kind === 'chat' ? 'chats' : 'submissions';
    const externalColumn =
      record.kind === 'chat' ? 'external_chat_id' : 'external_submission_id';
    const normalizedJson = json(record.normalized);
    const dataPolicy = record.dataPolicy ?? 'local_only';
    const external = record.externalProcessingAllowed ? 1 : 0;
    const embargo = record.embargoUntil ?? null;
    const kindProjection =
      record.kind === 'chat'
        ? 'challenge_id, title, status, NULL AS outcome, NULL AS chat_id'
        : 'challenge_id, NULL AS title, NULL AS status, outcome, chat_id';
    const existing = this.database
      .prepare(
        `SELECT id, source_hash, normalized_json, data_policy, external_processing_allowed,
                embargo_until, ${kindProjection}
         FROM ${table} WHERE platform = ? AND ${externalColumn} = ?`,
      )
      .get(record.platform, record.externalId) as
      | Record<string, unknown>
      | undefined;
    const sameCommon =
      existing?.source_hash === sourceHash &&
      existing.normalized_json === normalizedJson &&
      existing.data_policy === dataPolicy &&
      existing.external_processing_allowed === external &&
      nullableString(existing.embargo_until) === embargo &&
      nullableString(existing.challenge_id) === (record.challengeId ?? null);
    const sameKind =
      record.kind === 'chat'
        ? nullableString(existing?.title) === (record.title ?? null) &&
          nullableString(existing?.status) === (record.status ?? null)
        : nullableString(existing?.outcome) === (record.outcome ?? null) &&
          nullableString(existing?.chat_id) === (record.chatId ?? null);
    const disposition = !existing
      ? 'inserted'
      : sameCommon && sameKind
        ? 'unchanged'
        : 'updated';
    if (disposition === 'unchanged') return disposition;

    if (record.kind === 'chat') {
      this.database
        .prepare(
          `INSERT INTO chats
            (id, platform, external_chat_id, challenge_id, title, status, source_hash, normalized_json,
             data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, external_chat_id) DO UPDATE SET
             challenge_id = excluded.challenge_id,
             title = excluded.title,
             status = excluded.status,
             source_hash = excluded.source_hash,
             normalized_json = excluded.normalized_json,
             data_policy = excluded.data_policy,
             external_processing_allowed = excluded.external_processing_allowed,
             embargo_until = excluded.embargo_until,
             updated_at = excluded.updated_at`,
        )
        .run(
          recordId,
          record.platform,
          record.externalId,
          record.challengeId ?? null,
          record.title ?? null,
          record.status ?? null,
          sourceHash,
          normalizedJson,
          dataPolicy,
          external,
          embargo,
          now,
          now,
        );
    } else {
      this.database
        .prepare(
          `INSERT INTO submissions
            (id, platform, external_submission_id, challenge_id, chat_id, outcome, source_hash, normalized_json,
             data_policy, external_processing_allowed, embargo_until, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(platform, external_submission_id) DO UPDATE SET
             challenge_id = excluded.challenge_id,
             chat_id = excluded.chat_id,
             outcome = excluded.outcome,
             source_hash = excluded.source_hash,
             normalized_json = excluded.normalized_json,
             data_policy = excluded.data_policy,
             external_processing_allowed = excluded.external_processing_allowed,
             embargo_until = excluded.embargo_until,
             updated_at = excluded.updated_at`,
        )
        .run(
          recordId,
          record.platform,
          record.externalId,
          record.challengeId ?? null,
          record.chatId ?? null,
          record.outcome ?? null,
          sourceHash,
          normalizedJson,
          dataPolicy,
          external,
          embargo,
          now,
          now,
        );
    }
    return disposition;
  }

  private replaceChildren(
    record: ArchiveRecord,
    recordId: string,
    sourceHash: string,
    now: string,
  ): void {
    if (record.kind === 'chat') {
      this.database
        .prepare('DELETE FROM messages WHERE chat_id = ?')
        .run(recordId);
      const insert = this.database.prepare(
        `INSERT INTO messages
          (id, chat_id, external_message_id, ordinal, role, content, source_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const message of record.messages ?? []) {
        const messageHash = message.sourceHash ?? sourceHash;
        const identity =
          message.externalId ?? `${message.ordinal}:${messageHash}`;
        insert.run(
          stableId('message', recordId, identity),
          recordId,
          message.externalId ?? null,
          message.ordinal,
          message.role,
          message.content,
          messageHash,
          message.createdAt ?? null,
          now,
        );
      }
      return;
    }

    this.database
      .prepare('DELETE FROM judge_results WHERE submission_id = ?')
      .run(recordId);
    const insert = this.database.prepare(
      `INSERT INTO judge_results
        (id, submission_id, external_judge_id, judge_name, verdict, score, explanation, source_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const result of record.judgeResults ?? []) {
      const resultHash = result.sourceHash ?? sourceHash;
      const identity =
        result.externalId ?? `${result.judgeName ?? 'judge'}:${resultHash}`;
      insert.run(
        stableId('judge', recordId, identity),
        recordId,
        result.externalId ?? null,
        result.judgeName ?? null,
        result.verdict ?? null,
        result.score ?? null,
        result.explanation ?? null,
        resultHash,
        now,
      );
    }
  }

  private upsertArtifacts(
    recordType: ArchiveRecord['kind'],
    recordId: string,
    artifacts: StoredArtifact[],
  ): void {
    const insert = this.database.prepare(
      `INSERT INTO source_artifacts
        (id, record_type, record_id, artifact_type, content_hash, byte_length, media_type,
         storage_path, captured_at, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_type, record_id, content_hash) DO NOTHING`,
    );
    for (const artifact of artifacts) {
      insert.run(
        artifact.id,
        recordType,
        recordId,
        artifact.artifactType,
        artifact.contentHash,
        artifact.byteLength,
        artifact.mediaType,
        artifact.storagePath,
        artifact.capturedAt,
        json(artifact.metadata),
      );
    }
  }

  private advanceCheckpoint(
    advance: CheckpointAdvance,
    recordId: string,
    sourceHash: string,
    now: string,
  ): StoredCheckpoint {
    const scope = requiredText(advance.scope, 'checkpoint.scope');
    const cursor = requiredText(advance.cursor, 'checkpoint.cursor');
    const state = advance.state ?? {};
    const existingRow = this.database
      .prepare(
        `SELECT scope, cursor, state_json, record_id, source_hash, version, updated_at
         FROM checkpoints WHERE scope = ?`,
      )
      .get(scope) as Record<string, unknown> | undefined;
    const existing = existingRow ? this.checkpointFromRow(existingRow) : null;

    if (
      existing &&
      existing.cursor === cursor &&
      existing.recordId === recordId &&
      existing.sourceHash === sourceHash &&
      json(existing.state) === json(state)
    ) {
      return existing;
    }

    const actualVersion = existing?.version ?? 0;
    if (
      advance.expectedVersion !== undefined &&
      advance.expectedVersion !== actualVersion
    ) {
      throw new StaleCheckpointError(
        scope,
        advance.expectedVersion,
        actualVersion,
      );
    }
    const nextVersion = actualVersion + 1;
    this.database
      .prepare(
        `INSERT INTO checkpoints
          (scope, cursor, state_json, record_id, source_hash, version, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           cursor = excluded.cursor,
           state_json = excluded.state_json,
           record_id = excluded.record_id,
           source_hash = excluded.source_hash,
           version = excluded.version,
           updated_at = excluded.updated_at`,
      )
      .run(scope, cursor, json(state), recordId, sourceHash, nextVersion, now);

    return {
      scope,
      cursor,
      state,
      recordId,
      sourceHash,
      version: nextVersion,
      updatedAt: now,
    };
  }

  private summaryFromRow(row: Record<string, unknown>): StoredRecordSummary {
    const kind =
      row.kind === 'chat'
        ? 'chat'
        : row.kind === 'submission'
          ? 'submission'
          : null;
    if (!kind)
      throw new ArchiveStoreError(
        'CORRUPT_DATABASE',
        'Stored record kind is invalid.',
      );
    const dataPolicy = row.data_policy;
    if (
      dataPolicy !== 'local_only' &&
      dataPolicy !== 'direct_provider_only' &&
      dataPolicy !== 'zdr_router_allowed' &&
      dataPolicy !== 'public'
    ) {
      throw new ArchiveStoreError(
        'CORRUPT_DATABASE',
        'Stored record data policy is invalid.',
      );
    }
    return {
      id: String(row.id),
      kind,
      platform: String(row.platform),
      externalId: String(row.external_id),
      sourceHash: String(row.source_hash),
      dataPolicy,
      externalProcessingAllowed: row.external_processing_allowed === 1,
      embargoUntil: nullableString(row.embargo_until),
      firstSeenAt: String(row.first_seen_at),
      updatedAt: String(row.updated_at),
    };
  }

  private artifactFromRow(row: Record<string, unknown>): StoredArtifact {
    return {
      id: String(row.id),
      artifactType: String(row.artifact_type),
      contentHash: String(row.content_hash),
      byteLength: Number(row.byte_length),
      mediaType: String(row.media_type),
      storagePath: String(row.storage_path),
      capturedAt: String(row.captured_at),
      metadata: parseObject(row.metadata_json),
    };
  }

  private syncRunFromRow(row: Record<string, unknown>): StoredSyncRun {
    const status = row.status;
    if (
      status !== 'running' &&
      status !== 'completed' &&
      status !== 'stopped' &&
      status !== 'failed'
    ) {
      throw new ArchiveStoreError(
        'CORRUPT_DATABASE',
        'Stored sync run status is invalid.',
      );
    }
    return {
      id: String(row.id),
      startedAt: String(row.started_at),
      completedAt: nullableString(row.completed_at),
      status,
      requestedMaxRecords:
        row.requested_max_records === null ||
        row.requested_max_records === undefined
          ? null
          : Number(row.requested_max_records),
      recordsCommitted: Number(row.records_committed),
      stopReason: nullableString(row.stop_reason),
      metadata: parseObject(row.metadata_json),
    };
  }

  private checkpointFromRow(row: Record<string, unknown>): StoredCheckpoint {
    return {
      scope: String(row.scope),
      cursor: String(row.cursor),
      state: parseObject(row.state_json),
      recordId: String(row.record_id),
      sourceHash: String(row.source_hash),
      version: Number(row.version),
      updatedAt: String(row.updated_at),
    };
  }
}

export const archiveSchema = Object.freeze({
  latestVersion: LATEST_SCHEMA_VERSION,
  migrations: MIGRATIONS.map(({ version, name }) => ({ version, name })),
});

export function resolveEvidencePath(
  evidenceDirectory: string,
  storagePath: string,
): string {
  const root = resolve(evidenceDirectory);
  const candidate = resolve(root, storagePath);
  assertWithin(root, candidate);
  return candidate;
}

export function inferEvidenceExtension(fileName: string): string | undefined {
  const extension = extname(fileName).replace(/^\./, '');
  return extension || undefined;
}
