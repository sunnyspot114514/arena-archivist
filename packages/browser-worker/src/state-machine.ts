import {
  detectBlockingCondition,
  parseIndexSnapshot,
  parseRecordSnapshot,
  validateParsedRecord,
} from '../../gray-swan-adapter/src/index.js';
import type {
  GraySwanSelectorContract,
  IndexRecordLink,
  RawPageSnapshot,
} from '../../gray-swan-adapter/src/types.js';
import { createSanitizedEvidence } from './evidence.js';
import { InMemoryDailyRunBudget } from './run-budget.js';
import type {
  ArchiveCommitResult,
  ArchivePort,
  AuditPort,
  CollectBrowserPort,
  CollectState,
  DailyRunBudgetPort,
  NetworkPolicyDecision,
  WorkerRunResult,
  WorkerStopReason,
} from './types.js';

export interface BrowserWorkerConfig {
  readonly indexUrl: string;
  readonly checkpointScope?: string;
  readonly maxNewRecordsPerRun?: number;
  readonly maxRunMinutes?: number;
  readonly minRecordOpenIntervalMs?: number;
}

export interface BrowserWorkerDependencies {
  readonly browser: CollectBrowserPort;
  readonly archive: ArchivePort;
  readonly selectorContract: GraySwanSelectorContract;
  readonly runBudget?: DailyRunBudgetPort;
  readonly audit?: AuditPort;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface RunNextBatchInput {
  readonly maxRecords: number;
  readonly signal?: AbortSignal;
}

interface RunCounters {
  committed: number;
  skippedKnown: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function policyStopReason(
  decision: NetworkPolicyDecision | null,
): WorkerStopReason | null {
  if (!decision || decision.allowed) return null;
  return decision.reason === 'origin_denied' ||
    decision.reason === 'cross_origin_document'
    ? 'origin_denied'
    : 'unexpected_mutation';
}

function abortStopReason(signal?: AbortSignal): WorkerStopReason {
  const reason = signal?.reason;
  return reason instanceof Error && reason.message === 'runtime_shutdown'
    ? 'runtime_shutdown'
    : 'user_paused';
}

export class GraySwanBrowserWorker {
  private readonly visitedStates: CollectState[] = [];
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly runBudget: DailyRunBudgetPort;
  private readonly maximumRecords: number;
  private readonly maximumRunMs: number;
  private readonly cooldownMs: number;

  constructor(
    private readonly config: BrowserWorkerConfig,
    private readonly dependencies: BrowserWorkerDependencies,
  ) {
    const indexUrl = new URL(config.indexUrl);
    if (indexUrl.origin !== dependencies.browser.primaryOrigin) {
      throw new Error(
        'Index URL must use the collection browser primary origin',
      );
    }
    if (dependencies.selectorContract.contractId !== 'gray-swan-arena') {
      throw new Error(
        'Browser worker requires a Gray Swan Arena selector contract',
      );
    }
    if (
      dependencies.browser.runtimeKind === 'live_browser' &&
      dependencies.selectorContract.compatibility.status !== 'verified'
    ) {
      throw new Error('Live collection requires a verified selector contract');
    }
    this.maximumRecords = config.maxNewRecordsPerRun ?? 25;
    this.maximumRunMs = (config.maxRunMinutes ?? 20) * 60_000;
    this.cooldownMs = config.minRecordOpenIntervalMs ?? 10_000;
    if (!Number.isInteger(this.maximumRecords) || this.maximumRecords < 1) {
      throw new Error('maxNewRecordsPerRun must be a positive integer');
    }
    if (this.maximumRunMs <= 0 || this.cooldownMs < 0)
      throw new Error('Invalid run timing budget');
    this.now = dependencies.now ?? (() => new Date());
    this.sleep = dependencies.sleep ?? defaultSleep;
    this.runBudget = dependencies.runBudget ?? new InMemoryDailyRunBudget(3);
  }

  private async enter(
    state: CollectState,
    signal?: AbortSignal,
    externalId?: string,
  ): Promise<boolean> {
    if (signal?.aborted) return false;
    this.visitedStates.push(state);
    await this.dependencies.audit?.write({
      at: this.now().toISOString(),
      type: 'state',
      state,
      ...(externalId === undefined ? {} : { externalId }),
    });
    return !signal?.aborted;
  }

  private async waitForCooldown(signal?: AbortSignal): Promise<boolean> {
    if (this.cooldownMs === 0) return !signal?.aborted;
    if (!signal) {
      await this.sleep(this.cooldownMs);
      return true;
    }
    if (signal.aborted) return false;

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<boolean>((resolve) => {
      onAbort = () => resolve(false);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([
        this.sleep(this.cooldownMs).then(() => !signal.aborted),
        aborted,
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  private result(
    status: 'completed' | 'stopped',
    counters: RunCounters,
    reason: WorkerStopReason | null,
  ): WorkerRunResult {
    return {
      status,
      stopReason: reason,
      committed: counters.committed,
      skippedKnown: counters.skippedKnown,
      visitedStates: [...this.visitedStates],
    };
  }

  private async stop(
    reason: WorkerStopReason,
    counters: RunCounters,
    diagnostic?: {
      readonly issueCode?: string;
      readonly issueField?: string;
      readonly issueCount?: number;
    },
  ): Promise<WorkerRunResult> {
    await this.dependencies.audit?.write({
      at: this.now().toISOString(),
      type: 'run_stopped',
      reason,
      ...diagnostic,
    });
    return this.result('stopped', counters, reason);
  }

  private async policyStop(
    counters: RunCounters,
  ): Promise<WorkerRunResult | null> {
    const decision = this.dependencies.browser.consumePolicyViolation();
    return this.stopForPolicyDecision(decision, counters);
  }

  private async stopForPolicyDecision(
    decision: NetworkPolicyDecision | null,
    counters: RunCounters,
  ): Promise<WorkerRunResult | null> {
    const reason = policyStopReason(decision);
    if (!reason || !decision || decision.allowed) return null;
    await this.dependencies.audit?.write({
      at: this.now().toISOString(),
      type: 'policy_denial',
      reason: decision.reason,
    });
    return this.stop(reason, counters);
  }

  private blockingStop(snapshot: RawPageSnapshot): WorkerStopReason | null {
    return detectBlockingCondition(
      snapshot,
      this.dependencies.selectorContract,
    );
  }

  private resolveRecordUrl(
    entry: IndexRecordLink,
    indexSnapshot: RawPageSnapshot,
  ): string | null {
    try {
      const url = new URL(entry.href, indexSnapshot.url);
      return url.origin === this.dependencies.browser.primaryOrigin
        ? url.href
        : null;
    } catch {
      return null;
    }
  }

  async runNextBatch(input: RunNextBatchInput): Promise<WorkerRunResult> {
    this.visitedStates.length = 0;
    const counters: RunCounters = { committed: 0, skippedKnown: 0 };
    if (!Number.isInteger(input.maxRecords) || input.maxRecords < 1) {
      throw new Error('maxRecords must be a positive integer');
    }
    if (input.signal?.aborted) {
      return this.stop(abortStopReason(input.signal), counters);
    }
    const recordLimit = Math.min(input.maxRecords, this.maximumRecords);
    const startedAt = this.now().getTime();
    if (!(await this.runBudget.tryStart(this.now())))
      return this.stop('run_budget_exhausted', counters);

    if (!(await this.enter('AUTH_CHECK', input.signal))) {
      return this.stop(abortStopReason(input.signal), counters);
    }
    try {
      await this.dependencies.browser.navigate(this.config.indexUrl);
    } catch {
      if (input.signal?.aborted) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      const policy = await this.policyStop(counters);
      return policy ?? this.stop('navigation_failed', counters);
    }
    const initialPolicyStop = await this.policyStop(counters);
    if (initialPolicyStop) return initialPolicyStop;

    const preparation = this.dependencies.selectorContract.index.preparation;
    if (preparation) {
      if (!this.dependencies.browser.prepareIndex) {
        return this.stop('navigation_failed', counters);
      }
      try {
        await this.dependencies.browser.prepareIndex(preparation);
      } catch {
        if (input.signal?.aborted) {
          return this.stop(abortStopReason(input.signal), counters);
        }
        const policy = await this.policyStop(counters);
        return policy ?? this.stop('navigation_failed', counters);
      }
      const preparationPolicyStop = await this.policyStop(counters);
      if (preparationPolicyStop) return preparationPolicyStop;
    }

    let indexSnapshot: RawPageSnapshot;
    try {
      indexSnapshot = await this.dependencies.browser.snapshot();
    } catch {
      if (input.signal?.aborted) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      return this.stop('navigation_failed', counters);
    }
    const indexCapturePolicyStop = await this.policyStop(counters);
    if (indexCapturePolicyStop) return indexCapturePolicyStop;
    const authBlocker = this.blockingStop(indexSnapshot);
    if (authBlocker) return this.stop(authBlocker, counters);

    if (!(await this.enter('INDEX_DISCOVERY', input.signal))) {
      return this.stop(abortStopReason(input.signal), counters);
    }
    const parsedIndex = parseIndexSnapshot(
      indexSnapshot,
      this.dependencies.selectorContract,
    );
    if (!parsedIndex.ok) {
      const first = parsedIndex.issues[0];
      return this.stop('parser_mismatch', counters, {
        issueCode: first?.code,
        issueField: first?.field,
        issueCount: parsedIndex.issues.length,
      });
    }

    for (const entry of parsedIndex.value.records) {
      if (input.signal?.aborted) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      if (counters.committed >= recordLimit) break;
      if (this.now().getTime() - startedAt >= this.maximumRunMs) {
        return this.stop('run_time_exhausted', counters);
      }

      let known: boolean;
      try {
        known = await this.dependencies.archive.hasRecord(
          entry.kind,
          entry.externalId,
        );
      } catch {
        if (input.signal?.aborted) {
          return this.stop(abortStopReason(input.signal), counters);
        }
        return this.stop('archive_failed', counters);
      }
      if (known) {
        counters.skippedKnown += 1;
        continue;
      }

      const recordUrl = this.resolveRecordUrl(entry, indexSnapshot);
      if (!recordUrl) return this.stop('origin_denied', counters);

      if (!(await this.enter('OPEN_RECORD', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      try {
        await this.dependencies.browser.navigate(recordUrl);
        await this.dependencies.browser.waitForRecordReady?.(entry.kind);
      } catch {
        if (input.signal?.aborted) {
          return this.stop(abortStopReason(input.signal), counters);
        }
        const policy = await this.policyStop(counters);
        return policy ?? this.stop('navigation_failed', counters);
      }
      const openPolicyStop = await this.policyStop(counters);
      if (openPolicyStop) return openPolicyStop;

      if (!(await this.enter('CAPTURE_RAW', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      let rawSnapshot: RawPageSnapshot;
      try {
        rawSnapshot = await this.dependencies.browser.snapshot();
      } catch {
        if (input.signal?.aborted) {
          return this.stop(abortStopReason(input.signal), counters);
        }
        return this.stop('navigation_failed', counters);
      }
      const capturePolicyStop = await this.policyStop(counters);
      if (capturePolicyStop) return capturePolicyStop;
      const blocker = this.blockingStop(rawSnapshot);
      if (blocker) return this.stop(blocker, counters);
      const evidence = createSanitizedEvidence(rawSnapshot);

      if (!(await this.enter('PARSE', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      const parsedRecord = parseRecordSnapshot(
        evidence.snapshot,
        entry.kind,
        this.dependencies.selectorContract,
      );
      if (!parsedRecord.ok) {
        const first = parsedRecord.issues[0];
        return this.stop('parser_mismatch', counters, {
          issueCode: first?.code,
          issueField: first?.field,
          issueCount: parsedRecord.issues.length,
        });
      }

      if (!(await this.enter('VALIDATE', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      const validated = validateParsedRecord(
        parsedRecord.value,
        entry.externalId,
      );
      if (!validated.ok) return this.stop('validation_failed', counters);

      if (!(await this.enter('COMMIT', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      // This check must be synchronous on the no-denial path. The production archive port starts
      // and completes its SQLite transaction before its async function first yields, so no route
      // callback can interleave between this consume and the canonical record transaction.
      const preCommitDecision =
        this.dependencies.browser.consumePolicyViolation();
      if (policyStopReason(preCommitDecision)) {
        const preCommitStop = await this.stopForPolicyDecision(
          preCommitDecision,
          counters,
        );
        if (preCommitStop) return preCommitStop;
        return this.stop('unexpected_mutation', counters);
      }
      let commitResult: ArchiveCommitResult;
      try {
        // The archive port has no independent checkpoint method: canonical data, evidence, and
        // cursor must commit in one store transaction or all roll back (invariant I5).
        commitResult = await this.dependencies.archive.commitRecord({
          record: validated.value,
          evidence,
          checkpoint: {
            scope: this.config.checkpointScope ?? 'gray-swan:archive-index',
            cursor: entry.externalId,
            state: {
              recordKind: entry.kind,
              externalId: entry.externalId,
              contentHash: evidence.contentHash,
              committedAt: this.now().toISOString(),
            },
          },
        });
      } catch {
        if (input.signal?.aborted) {
          return this.stop(abortStopReason(input.signal), counters);
        }
        return this.stop('archive_failed', counters);
      }
      if (commitResult.committed) {
        counters.committed += 1;
        await this.dependencies.audit?.write({
          at: this.now().toISOString(),
          type: 'record_committed',
          externalId: entry.externalId,
        });
      } else {
        counters.skippedKnown += 1;
      }

      const postCommitPolicyStop = await this.policyStop(counters);
      if (postCommitPolicyStop) return postCommitPolicyStop;

      if (!(await this.enter('COOLDOWN', input.signal, entry.externalId))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      if (!(await this.waitForCooldown(input.signal))) {
        return this.stop(abortStopReason(input.signal), counters);
      }
      const cooldownPolicyStop = await this.policyStop(counters);
      if (cooldownPolicyStop) return cooldownPolicyStop;
    }

    const finalPolicyStop = await this.policyStop(counters);
    if (finalPolicyStop) return finalPolicyStop;
    return this.result('completed', counters, null);
  }
}
