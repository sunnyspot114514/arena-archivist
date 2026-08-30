import { randomUUID } from 'node:crypto';

import {
  ArchiveStore,
  type ArchiveRecord,
  type ArchivedJudgeResult,
  type ArchivedMessage,
  type JsonValue,
} from '../../../packages/archive-store/index';
import type {
  ArchiveCommitInput,
  ArchiveCommitResult,
  ArchivePort,
  AuditPort,
  WorkerAuditEvent,
} from '../../../packages/browser-worker/src/types';
import type {
  ParsedGraySwanRecord,
  RecordKind,
} from '../../../packages/gray-swan-adapter/src/types';

function score(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeOutcome(record: ParsedGraySwanRecord): string | undefined {
  const label = record.judgeResults[0]?.label
    .trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/g, '-');
  if (['successful', 'success', 'passed', 'break'].includes(label ?? ''))
    return 'success';
  if (
    [
      'not-successful',
      'unsuccessful',
      'failure',
      'failed',
      'rejected',
    ].includes(label ?? '')
  ) {
    return 'failure';
  }
  return label || record.status || undefined;
}

function normalizedJson(
  record: ParsedGraySwanRecord,
): Record<string, JsonValue> {
  return {
    externalId: record.externalId,
    title: record.title,
    behavior: record.behavior,
    modelAlias: record.modelAlias,
    status: record.status,
    messages: record.messages.map((message) => ({
      ordinal: message.ordinal,
      role: message.role,
      body: message.body,
    })),
    judgeResults: record.judgeResults.map((judge) => ({
      ordinal: judge.ordinal,
      label: judge.label,
      score: judge.score,
      explanation: judge.explanation,
    })),
    sourceUrl: record.sourceUrl,
    capturedAt: record.capturedAt,
    parserVersion: record.parserVersion,
    selectorContractVersion: record.selectorContractVersion,
    trace: record.trace.map((item) => ({
      field: item.field,
      candidateId: item.candidateId,
      selector: item.selector,
    })),
    redactionVersion: 'v1',
  };
}

function toArchiveRecord(
  record: ParsedGraySwanRecord,
  platform: string,
): ArchiveRecord {
  if (record.kind === 'profile') {
    throw new Error(
      'Profile records are session metadata and are not batch archive records',
    );
  }

  const common = {
    platform,
    externalId: record.externalId,
    normalized: normalizedJson(record),
    dataPolicy: 'local_only' as const,
    externalProcessingAllowed: false,
    embargoUntil: null,
  };

  if (record.kind === 'chat') {
    const messages: ArchivedMessage[] = record.messages.map((message) => ({
      ordinal: message.ordinal,
      role: message.role || 'unknown',
      content: message.body,
    }));
    return {
      ...common,
      kind: 'chat',
      title: record.title,
      status: record.status ?? undefined,
      messages,
    };
  }

  const judgeResults: ArchivedJudgeResult[] = record.judgeResults.map(
    (judge) => ({
      externalId: `judge_${judge.ordinal}`,
      judgeName: 'arena',
      verdict: judge.label || undefined,
      score: score(judge.score),
      explanation: judge.explanation ?? undefined,
    }),
  );
  return {
    ...common,
    kind: 'submission',
    outcome: normalizeOutcome(record),
    judgeResults,
  };
}

export class ArchiveStorePort implements ArchivePort {
  constructor(
    readonly store: ArchiveStore,
    readonly runId: string,
    readonly platform = 'gray-swan',
  ) {}

  async hasRecord(kind: RecordKind, externalId: string): Promise<boolean> {
    if (kind === 'profile') return true;
    return this.store.getRecord(kind, this.platform, externalId) !== null;
  }

  async commitRecord(input: ArchiveCommitInput): Promise<ArchiveCommitResult> {
    const result = this.store.commitRecord({
      runId: this.runId,
      record: toArchiveRecord(input.record, this.platform),
      evidence: [
        {
          artifactType: 'page_html',
          content: input.evidence.snapshot.html,
          mediaType: 'text/html',
          fileExtension: 'html',
          capturedAt: input.evidence.snapshot.capturedAt,
          metadata: {
            sourceUrl: input.evidence.snapshot.url,
            title: input.evidence.snapshot.title,
            sanitizationVersion: input.evidence.sanitizationVersion,
            snapshotHash: input.evidence.contentHash,
            responseStatus: input.evidence.snapshot.responseStatus ?? null,
          },
        },
        {
          artifactType: 'visible_text',
          content: input.evidence.snapshot.visibleText,
          mediaType: 'text/plain',
          fileExtension: 'txt',
          capturedAt: input.evidence.snapshot.capturedAt,
          metadata: {
            sanitizationVersion: input.evidence.sanitizationVersion,
            snapshotHash: input.evidence.contentHash,
          },
        },
      ],
      checkpoint: {
        scope: input.checkpoint.scope,
        cursor: input.checkpoint.cursor,
        state: input.checkpoint.state as Record<string, JsonValue>,
        expectedVersion: input.checkpoint.expectedVersion,
      },
    });
    return {
      committed: result.disposition !== 'unchanged',
      canonicalRecordId: result.recordId,
    };
  }
}

export class ArchiveAuditPort implements AuditPort {
  constructor(
    readonly store: ArchiveStore,
    readonly runId: string,
    readonly actionId: string,
  ) {}

  write(event: WorkerAuditEvent): void {
    this.store.appendPolicyDecision({
      id: `decision_${randomUUID()}`,
      occurredAt: event.at,
      layer: event.type === 'policy_denial' ? 'browser_guardian' : 'worker',
      mode: 'COLLECT_MODE',
      allowed: event.type !== 'policy_denial' && event.type !== 'run_stopped',
      reason: event.reason ?? event.type,
      action: event.state ?? event.type,
      metadata: {
        runId: this.runId,
        actionId: this.actionId,
        ...(event.externalId ? { externalId: event.externalId } : {}),
        ...(event.issueCode ? { issueCode: event.issueCode } : {}),
        ...(event.issueField ? { issueField: event.issueField } : {}),
        ...(event.issueCount === undefined
          ? {}
          : { issueCount: event.issueCount }),
      },
    });
  }
}
