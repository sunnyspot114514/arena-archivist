import type {
  ParsedGraySwanRecord,
  RawPageSnapshot,
  RecordKind,
} from '../../gray-swan-adapter/src/types.js';

export const COLLECT_STATES = [
  'AUTH_CHECK',
  'INDEX_DISCOVERY',
  'OPEN_RECORD',
  'CAPTURE_RAW',
  'PARSE',
  'VALIDATE',
  'COMMIT',
  'COOLDOWN',
] as const;

export type CollectState = (typeof COLLECT_STATES)[number];
export type BrowserMode = 'AUTH_MODE' | 'COLLECT_MODE';

export interface RequestDescriptor {
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly postData: string | null;
  readonly headers?: Readonly<Record<string, string>>;
}

export type PolicyDenialReason =
  | 'invalid_url'
  | 'insecure_scheme'
  | 'origin_denied'
  | 'cross_origin_document'
  | 'method_denied'
  | 'graphql_endpoint_denied'
  | 'graphql_operation_denied';

export type NetworkPolicyDecision =
  | {
      readonly allowed: true;
      readonly reason: 'read_only_request' | 'read_only_graphql';
    }
  | {
      readonly allowed: false;
      readonly reason: PolicyDenialReason;
      readonly method: string;
      readonly origin: string | null;
      readonly resourceType: string;
    };

export interface CollectBrowserPort {
  readonly mode: 'COLLECT_MODE';
  readonly runtimeKind: 'live_browser' | 'offline_fixture';
  readonly primaryOrigin: string;
  navigate(url: string): Promise<void>;
  snapshot(): Promise<RawPageSnapshot>;
  consumePolicyViolation(): NetworkPolicyDecision | null;
  close(): Promise<void>;
}

export interface ManualAuthSession {
  readonly mode: 'AUTH_MODE';
  readonly profileDirectory: string;
  readonly browserOpen: true;
  pageCount(): number;
  openLoginPage(): Promise<void>;
  waitForClose(): Promise<void>;
  close(): Promise<void>;
}

export interface SanitizedEvidence {
  readonly snapshot: RawPageSnapshot;
  readonly contentHash: `sha256:${string}`;
  readonly sanitizationVersion: string;
}

export interface ArchiveCommitInput {
  readonly record: ParsedGraySwanRecord;
  readonly evidence: SanitizedEvidence;
  readonly checkpoint: CheckpointUpdate;
}

export interface ArchiveCommitResult {
  readonly committed: boolean;
  readonly canonicalRecordId: string;
}

export interface CheckpointUpdate {
  readonly scope: string;
  readonly cursor: string;
  readonly state: Readonly<{
    readonly recordKind: RecordKind;
    readonly externalId: string;
    readonly contentHash: `sha256:${string}`;
    readonly committedAt: string;
  }>;
  readonly expectedVersion?: number;
}

export interface ArchivePort {
  hasRecord(kind: RecordKind, externalId: string): Promise<boolean>;
  commitRecord(input: ArchiveCommitInput): Promise<ArchiveCommitResult>;
}

export interface DailyRunBudgetPort {
  tryStart(now: Date): Promise<boolean>;
}

export interface WorkerAuditEvent {
  readonly at: string;
  readonly type: 'state' | 'policy_denial' | 'record_committed' | 'run_stopped';
  readonly state?: CollectState;
  readonly externalId?: string;
  readonly reason?: string;
}

export interface AuditPort {
  write(event: WorkerAuditEvent): void | Promise<void>;
}

export type WorkerStopReason =
  | 'login_required'
  | 'captcha'
  | 'bot_challenge'
  | 'http_403'
  | 'http_429'
  | 'unexpected_mutation'
  | 'origin_denied'
  | 'parser_mismatch'
  | 'validation_failed'
  | 'archive_failed'
  | 'run_budget_exhausted'
  | 'run_time_exhausted'
  | 'navigation_failed'
  | 'user_paused';

export interface WorkerRunResult {
  readonly status: 'completed' | 'stopped';
  readonly stopReason: WorkerStopReason | null;
  readonly committed: number;
  readonly skippedKnown: number;
  readonly visitedStates: readonly CollectState[];
}
