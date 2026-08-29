import { randomUUID } from 'node:crypto';
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
import { dirname, resolve } from 'node:path';

export type ImmediateStopSignal =
  | 'HTTP_429'
  | 'HTTP_403'
  | 'captcha'
  | 'bot_challenge'
  | 'login_required'
  | 'unexpected_mutation';

export type RecoverableFailure =
  | 'network_error'
  | 'timeout'
  | 'parse_error'
  | 'unexpected_response';
export type FailureReason = ImmediateStopSignal | RecoverableFailure;

export interface RateGovernorConfig {
  minRecordOpenIntervalMs: number;
  maxNewRecordsPerRun: number;
  maxRunMs: number;
  maxRunsPerDay: number;
  firstFailureBackoffMs: number;
  secondFailureBackoffMs: number;
}

export const conservativeRateGovernorConfig: Readonly<RateGovernorConfig> =
  Object.freeze({
    minRecordOpenIntervalMs: 10_000,
    maxNewRecordsPerRun: 25,
    maxRunMs: 20 * 60_000,
    maxRunsPerDay: 3,
    firstFailureBackoffMs: 60_000,
    secondFailureBackoffMs: 5 * 60_000,
  });

export interface RecordLease {
  leaseId: string;
  runId: string;
  recordNumber: number;
  openedAt: string;
}

export interface RunPermit {
  runId: string;
  startedAt: string;
  maxRecords: number;
  endsAt: string;
  resumed: boolean;
}

export type GovernorDenialReason =
  | 'STATE_UNAVAILABLE'
  | 'ALREADY_RUNNING'
  | 'RUN_NOT_ACTIVE'
  | 'RUN_ID_MISMATCH'
  | 'RUNS_PER_DAY_EXHAUSTED'
  | 'RUN_TIME_EXHAUSTED'
  | 'RECORD_BUDGET_EXHAUSTED'
  | 'RECORD_IN_FLIGHT'
  | 'MIN_INTERVAL'
  | 'FAILURE_BACKOFF'
  | 'RUN_STOPPED'
  | 'UNKNOWN_LEASE';

export class RateGovernorDeniedError extends Error {
  readonly code = 'RATE_GOVERNOR_DENIED';
  readonly reason: GovernorDenialReason;
  readonly retryAt: string | null;

  constructor(
    reason: GovernorDenialReason,
    message: string,
    retryAt?: string | null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RateGovernorDeniedError';
    this.reason = reason;
    this.retryAt = retryAt ?? null;
  }
}

export class RateGovernorStateError extends Error {
  readonly code = 'RATE_GOVERNOR_STATE_ERROR';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RateGovernorStateError';
  }
}

type PersistedLease = RecordLease;

interface ActiveRunState {
  runId: string;
  startedAtMs: number;
  maxRecords: number;
  recordsOpened: number;
  leases: PersistedLease[];
}

export interface PersistedGovernorState {
  schemaVersion: 1;
  revision: number;
  dayKey: string;
  runsStartedToday: number;
  activeRun: ActiveRunState | null;
  lastRecordOpenedAtMs: number | null;
  consecutiveFailures: number;
  backoffUntilMs: number | null;
  lastStop: {
    reason: FailureReason | 'completed' | 'cancelled' | 'expired';
    atMs: number;
  } | null;
}

export interface GovernorStateStore {
  load(): unknown;
  save(state: PersistedGovernorState): void;
}

export class MemoryGovernorStateStore implements GovernorStateStore {
  private value: PersistedGovernorState | null;

  constructor(initial?: PersistedGovernorState) {
    this.value = initial ? structuredClone(initial) : null;
  }

  load(): unknown {
    return this.value ? structuredClone(this.value) : null;
  }

  save(state: PersistedGovernorState): void {
    this.value = structuredClone(state);
  }
}

export class JsonFileGovernorStateStore implements GovernorStateStore {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  load(): unknown {
    if (!existsSync(this.path)) return null;
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as unknown;
    } catch (error) {
      throw new RateGovernorStateError(
        'Rate-governor state is unreadable; refusing to issue permits.',
        {
          cause: error,
        },
      );
    }
  }

  save(state: PersistedGovernorState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(state)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporaryPath, this.path);
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The temporary file may not exist or may already have been renamed.
      }
      throw new RateGovernorStateError(
        'Could not durably persist the rate budget; no permit was issued.',
        {
          cause: error,
        },
      );
    }
  }
}

export interface RateGovernorOptions {
  store?: GovernorStateStore;
  config?: Partial<RateGovernorConfig>;
  now?: () => number;
  dayKey?: (timestampMs: number) => string;
}

export interface FailureOutcome {
  stopped: boolean;
  reason: FailureReason;
  consecutiveFailures: number;
  retryAt: string | null;
}

const IMMEDIATE_STOPS: ReadonlySet<FailureReason> = new Set([
  'HTTP_429',
  'HTTP_403',
  'captcha',
  'bot_challenge',
  'login_required',
  'unexpected_mutation',
]);

function utcDayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

function dateString(timestampMs: number): string {
  return new Date(timestampMs).toISOString();
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number.`);
  }
  return value;
}

function integerPositive(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function defaultState(dayKey: string): PersistedGovernorState {
  return {
    schemaVersion: 1,
    revision: 0,
    dayKey,
    runsStartedToday: 0,
    activeRun: null,
    lastRecordOpenedAtMs: null,
    consecutiveFailures: 0,
    backoffUntilMs: null,
    lastStop: null,
  };
}

function isFiniteInteger(value: unknown, minimum = 0): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
  );
}

function validateState(value: unknown): PersistedGovernorState {
  if (value === null || value === undefined) {
    throw new RateGovernorStateError(
      'Internal error: a missing state must be initialized before validation.',
    );
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new RateGovernorStateError(
      'Rate-governor state has an invalid shape; refusing to issue permits.',
    );
  }
  const state = value as Partial<PersistedGovernorState>;
  if (
    state.schemaVersion !== 1 ||
    !isFiniteInteger(state.revision) ||
    typeof state.dayKey !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(state.dayKey) ||
    !isFiniteInteger(state.runsStartedToday) ||
    !isFiniteInteger(state.consecutiveFailures) ||
    (state.lastRecordOpenedAtMs !== null &&
      !isFiniteInteger(state.lastRecordOpenedAtMs)) ||
    (state.backoffUntilMs !== null && !isFiniteInteger(state.backoffUntilMs))
  ) {
    throw new RateGovernorStateError(
      'Rate-governor state is invalid; refusing to issue permits.',
    );
  }
  if (state.activeRun !== null) {
    const run = state.activeRun;
    if (
      !run ||
      typeof run.runId !== 'string' ||
      !run.runId ||
      !isFiniteInteger(run.startedAtMs) ||
      !isFiniteInteger(run.maxRecords, 1) ||
      !isFiniteInteger(run.recordsOpened) ||
      run.recordsOpened > run.maxRecords ||
      !Array.isArray(run.leases) ||
      run.leases.length > 1
    ) {
      throw new RateGovernorStateError(
        'Active rate-governor run is invalid; refusing to issue permits.',
      );
    }
    for (const lease of run.leases) {
      if (
        typeof lease?.leaseId !== 'string' ||
        typeof lease.runId !== 'string' ||
        lease.runId !== run.runId ||
        !isFiniteInteger(lease.recordNumber, 1) ||
        typeof lease.openedAt !== 'string'
      ) {
        throw new RateGovernorStateError(
          'Persisted record lease is invalid; refusing to issue permits.',
        );
      }
    }
  }
  if (state.lastStop !== null) {
    if (
      !state.lastStop ||
      typeof state.lastStop.reason !== 'string' ||
      !isFiniteInteger(state.lastStop.atMs)
    ) {
      throw new RateGovernorStateError(
        'Persisted stop state is invalid; refusing to issue permits.',
      );
    }
  }
  return structuredClone(state as PersistedGovernorState);
}

export class RateGovernor {
  readonly config: Readonly<RateGovernorConfig>;

  private readonly store: GovernorStateStore;
  private readonly now: () => number;
  private readonly makeDayKey: (timestampMs: number) => string;
  private state: PersistedGovernorState;

  constructor(options: RateGovernorOptions = {}) {
    const merged: RateGovernorConfig = {
      ...conservativeRateGovernorConfig,
      ...options.config,
    };
    this.config = Object.freeze({
      minRecordOpenIntervalMs: finitePositive(
        merged.minRecordOpenIntervalMs,
        'minRecordOpenIntervalMs',
      ),
      maxNewRecordsPerRun: integerPositive(
        merged.maxNewRecordsPerRun,
        'maxNewRecordsPerRun',
      ),
      maxRunMs: finitePositive(merged.maxRunMs, 'maxRunMs'),
      maxRunsPerDay: integerPositive(merged.maxRunsPerDay, 'maxRunsPerDay'),
      firstFailureBackoffMs: finitePositive(
        merged.firstFailureBackoffMs,
        'firstFailureBackoffMs',
      ),
      secondFailureBackoffMs: finitePositive(
        merged.secondFailureBackoffMs,
        'secondFailureBackoffMs',
      ),
    });
    this.store = options.store ?? new MemoryGovernorStateStore();
    this.now = options.now ?? (() => Date.now());
    this.makeDayKey = options.dayKey ?? utcDayKey;

    const timestamp = this.currentTime();
    const loaded = this.loadState();
    this.state =
      loaded === null
        ? defaultState(this.makeDayKey(timestamp))
        : validateState(loaded);
    this.reconcile(timestamp);
  }

  startRun(
    requestedRecords = this.config.maxNewRecordsPerRun,
    runId = `run_${randomUUID()}`,
  ): RunPermit {
    const now = this.currentTime();
    this.reconcile(now);
    if (this.state.activeRun) {
      throw this.denied(
        'ALREADY_RUNNING',
        'A collection run is already active.',
        this.runEndMs(),
      );
    }
    if (this.state.runsStartedToday >= this.config.maxRunsPerDay) {
      throw this.denied(
        'RUNS_PER_DAY_EXHAUSTED',
        'The daily run budget is exhausted.',
      );
    }
    integerPositive(requestedRecords, 'requestedRecords');
    if (!runId.trim()) throw new TypeError('runId must be non-empty.');

    const maxRecords = Math.min(
      requestedRecords,
      this.config.maxNewRecordsPerRun,
    );
    this.mutate((state) => {
      state.runsStartedToday += 1;
      state.activeRun = {
        runId,
        startedAtMs: now,
        maxRecords,
        recordsOpened: 0,
        leases: [],
      };
      state.consecutiveFailures = 0;
      state.backoffUntilMs = null;
      state.lastStop = null;
    });
    return {
      runId,
      startedAt: dateString(now),
      maxRecords,
      endsAt: dateString(now + this.config.maxRunMs),
      resumed: false,
    };
  }

  resumeRun(runId: string): RunPermit {
    const now = this.currentTime();
    this.reconcile(now);
    const run = this.requireRun(runId);
    return {
      runId: run.runId,
      startedAt: dateString(run.startedAtMs),
      maxRecords: run.maxRecords,
      endsAt: dateString(run.startedAtMs + this.config.maxRunMs),
      resumed: true,
    };
  }

  beginRecord(runId: string): RecordLease {
    const now = this.currentTime();
    this.reconcile(now);
    const run = this.requireRun(runId);
    if (run.leases.length > 0) {
      throw this.denied(
        'RECORD_IN_FLIGHT',
        'Only one high-level record may be open at a time.',
      );
    }
    if (run.recordsOpened >= run.maxRecords) {
      throw this.denied(
        'RECORD_BUDGET_EXHAUSTED',
        'The run record budget is exhausted.',
      );
    }
    if (this.state.backoffUntilMs !== null && now < this.state.backoffUntilMs) {
      throw this.denied(
        'FAILURE_BACKOFF',
        'A failure backoff is active.',
        this.state.backoffUntilMs,
      );
    }
    if (this.state.lastRecordOpenedAtMs !== null) {
      const nextAllowed =
        this.state.lastRecordOpenedAtMs + this.config.minRecordOpenIntervalMs;
      if (now < nextAllowed) {
        throw this.denied(
          'MIN_INTERVAL',
          'The minimum record-open interval has not elapsed.',
          nextAllowed,
        );
      }
    }

    const lease: RecordLease = {
      leaseId: `lease_${randomUUID()}`,
      runId,
      recordNumber: run.recordsOpened + 1,
      openedAt: dateString(now),
    };
    this.mutate((state) => {
      const active = state.activeRun;
      if (!active || active.runId !== runId || active.leases.length > 0) {
        throw this.denied(
          'RECORD_IN_FLIGHT',
          'Record permit state changed before it could be persisted.',
        );
      }
      active.recordsOpened += 1;
      active.leases.push(lease);
      state.lastRecordOpenedAtMs = now;
    });
    return lease;
  }

  recordSucceeded(leaseId: string): void {
    const now = this.currentTime();
    this.reconcile(now);
    this.requireLease(leaseId);
    this.mutate((state) => {
      if (!state.activeRun)
        throw this.denied('RUN_NOT_ACTIVE', 'The run is no longer active.');
      state.activeRun.leases = state.activeRun.leases.filter(
        (lease) => lease.leaseId !== leaseId,
      );
      state.consecutiveFailures = 0;
      state.backoffUntilMs = null;
    });
  }

  recordFailed(leaseId: string, reason: FailureReason): FailureOutcome {
    const now = this.currentTime();
    this.reconcile(now);
    this.requireLease(leaseId);
    if (!isFailureReason(reason))
      throw new TypeError(`Unknown failure reason: ${String(reason)}`);

    const nextFailures = this.state.consecutiveFailures + 1;
    const stopped = IMMEDIATE_STOPS.has(reason) || nextFailures >= 3;
    let retryAtMs: number | null = null;
    if (!stopped) {
      retryAtMs =
        now +
        (nextFailures === 1
          ? this.config.firstFailureBackoffMs
          : this.config.secondFailureBackoffMs);
    }

    this.mutate((state) => {
      if (!state.activeRun)
        throw this.denied('RUN_NOT_ACTIVE', 'The run is no longer active.');
      state.activeRun.leases = state.activeRun.leases.filter(
        (lease) => lease.leaseId !== leaseId,
      );
      state.consecutiveFailures = nextFailures;
      state.backoffUntilMs = retryAtMs;
      if (stopped) {
        state.activeRun = null;
        state.lastStop = { reason, atMs: now };
      }
    });
    return {
      stopped,
      reason,
      consecutiveFailures: nextFailures,
      retryAt: retryAtMs === null ? null : dateString(retryAtMs),
    };
  }

  stopImmediately(runId: string, reason: ImmediateStopSignal): void {
    const now = this.currentTime();
    this.reconcile(now);
    this.requireRun(runId);
    if (!IMMEDIATE_STOPS.has(reason))
      throw new TypeError(`Reason ${reason} is not an immediate-stop signal.`);
    this.mutate((state) => {
      state.activeRun = null;
      state.backoffUntilMs = null;
      state.lastStop = { reason, atMs: now };
    });
  }

  finishRun(runId: string): void {
    const now = this.currentTime();
    this.reconcile(now);
    const run = this.requireRun(runId);
    if (run.leases.length > 0) {
      throw this.denied(
        'RECORD_IN_FLIGHT',
        'Cannot finish a run while a record is in flight.',
      );
    }
    this.mutate((state) => {
      state.activeRun = null;
      state.backoffUntilMs = null;
      state.lastStop = { reason: 'completed', atMs: now };
    });
  }

  cancelRun(runId: string): void {
    const now = this.currentTime();
    this.reconcile(now);
    this.requireRun(runId);
    this.mutate((state) => {
      state.activeRun = null;
      state.backoffUntilMs = null;
      state.lastStop = { reason: 'cancelled', atMs: now };
    });
  }

  snapshot(): Readonly<PersistedGovernorState> {
    const now = this.currentTime();
    this.reconcile(now);
    return Object.freeze(structuredClone(this.state));
  }

  nextRecordAllowedAt(runId: string): string | null {
    const now = this.currentTime();
    this.reconcile(now);
    this.requireRun(runId);
    const interval =
      this.state.lastRecordOpenedAtMs === null
        ? now
        : this.state.lastRecordOpenedAtMs + this.config.minRecordOpenIntervalMs;
    const allowedAt = Math.max(interval, this.state.backoffUntilMs ?? now);
    return allowedAt <= now ? null : dateString(allowedAt);
  }

  private loadState(): unknown {
    try {
      return this.store.load() ?? null;
    } catch (error) {
      if (error instanceof RateGovernorStateError) throw error;
      throw new RateGovernorStateError(
        'Could not load the rate budget; refusing to issue permits.',
        {
          cause: error,
        },
      );
    }
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RateGovernorStateError(
        'Clock returned an invalid timestamp; refusing to issue permits.',
      );
    }
    return value;
  }

  private reconcile(now: number): void {
    const nextDay = this.makeDayKey(now);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDay)) {
      throw new RateGovernorStateError(
        'dayKey returned an invalid value; refusing to issue permits.',
      );
    }
    let dirty = false;
    const next = structuredClone(this.state);
    if (next.dayKey !== nextDay) {
      next.dayKey = nextDay;
      next.runsStartedToday = 0;
      dirty = true;
    }
    if (
      next.activeRun &&
      now >= next.activeRun.startedAtMs + this.config.maxRunMs
    ) {
      next.activeRun = null;
      next.backoffUntilMs = null;
      next.lastStop = { reason: 'expired', atMs: now };
      dirty = true;
    }
    if (dirty) this.persist(next);
  }

  private mutate(change: (draft: PersistedGovernorState) => void): void {
    const draft = structuredClone(this.state);
    change(draft);
    this.persist(draft);
  }

  private persist(draft: PersistedGovernorState): void {
    draft.revision = this.state.revision + 1;
    validateState(draft);
    try {
      this.store.save(draft);
    } catch (error) {
      if (error instanceof RateGovernorDeniedError) throw error;
      throw new RateGovernorDeniedError(
        'STATE_UNAVAILABLE',
        'The rate budget could not be persisted; no permit was issued.',
        null,
        { cause: error },
      );
    }
    this.state = draft;
  }

  private requireRun(runId: string): ActiveRunState {
    const run = this.state.activeRun;
    if (!run) {
      const reason: GovernorDenialReason = this.state.lastStop
        ? 'RUN_STOPPED'
        : 'RUN_NOT_ACTIVE';
      throw this.denied(reason, 'No collection run is active.');
    }
    if (run.runId !== runId) {
      throw this.denied(
        'RUN_ID_MISMATCH',
        'The permit does not belong to the active run.',
      );
    }
    return run;
  }

  private requireLease(leaseId: string): RecordLease {
    const lease = this.state.activeRun?.leases.find(
      (candidate) => candidate.leaseId === leaseId,
    );
    if (!lease)
      throw this.denied(
        'UNKNOWN_LEASE',
        'The record lease is missing or already settled.',
      );
    return lease;
  }

  private runEndMs(): number | null {
    return this.state.activeRun
      ? this.state.activeRun.startedAtMs + this.config.maxRunMs
      : null;
  }

  private denied(
    reason: GovernorDenialReason,
    message: string,
    retryAtMs?: number | null,
  ): RateGovernorDeniedError {
    return new RateGovernorDeniedError(
      reason,
      message,
      retryAtMs === undefined || retryAtMs === null
        ? null
        : dateString(retryAtMs),
    );
  }
}

export function classifyImmediateStop(observation: {
  httpStatus?: number;
  captcha?: boolean;
  botChallenge?: boolean;
  loginRequired?: boolean;
  unexpectedMutation?: boolean;
}): ImmediateStopSignal | null {
  if (observation.unexpectedMutation) return 'unexpected_mutation';
  if (observation.httpStatus === 429) return 'HTTP_429';
  if (observation.httpStatus === 403) return 'HTTP_403';
  if (observation.captcha) return 'captcha';
  if (observation.botChallenge) return 'bot_challenge';
  if (observation.loginRequired) return 'login_required';
  return null;
}

export function isFailureReason(value: unknown): value is FailureReason {
  return (
    typeof value === 'string' &&
    (IMMEDIATE_STOPS.has(value as FailureReason) ||
      value === 'network_error' ||
      value === 'timeout' ||
      value === 'parse_error' ||
      value === 'unexpected_response')
  );
}
