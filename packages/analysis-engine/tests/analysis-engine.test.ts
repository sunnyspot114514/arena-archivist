import { describe, expect, it } from 'vitest';

import {
  computeDuplicateMetrics,
  computeMetrics,
  renderMarkdownReport,
  type AttemptRecord,
} from '../src/index';

const records: AttemptRecord[] = [
  {
    id: 'a1',
    challengeId: 'challenge-a',
    behavior: 'behavior-a',
    model: 'model-a',
    templateId: 'template-transfer',
    prompt: 'Please summarize the fixture carefully',
    outcome: 'failure',
    createdAt: '2026-08-29T00:00:01.000Z',
  },
  {
    id: 'a2',
    challengeId: 'challenge-a',
    behavior: 'behavior-a',
    model: 'model-a',
    templateId: 'template-transfer',
    prompt: '  PLEASE   summarize the fixture carefully  ',
    outcome: 'success',
    createdAt: '2026-08-29T00:00:02.000Z',
  },
  {
    id: 'b1',
    challengeId: 'challenge-b',
    behavior: 'behavior-b',
    model: 'model-b',
    templateId: 'template-transfer',
    prompt: 'Please summarize this fixture carefully',
    outcome: 'success',
    createdAt: '2026-08-29T00:00:03.000Z',
  },
  {
    id: 'c1',
    challengeId: 'challenge-c',
    behavior: null,
    model: null,
    templateId: null,
    prompt: null,
    outcome: 'unknown',
    createdAt: '2026-08-29T00:00:04.000Z',
  },
];

describe('deterministic metrics', () => {
  it('excludes unknown outcomes from ASR and calculates attempts-to-break', () => {
    const metrics = computeMetrics(
      records,
      new Date('2026-08-29T01:00:00.000Z'),
    );
    expect(metrics.generatedAt).toBe('2026-08-29T01:00:00.000Z');
    expect(metrics.sampleSize).toBe(4);
    expect(metrics.missingOutcomeCount).toBe(1);
    expect(metrics.overall).toMatchObject({
      attempts: 4,
      knownOutcomes: 3,
      successes: 2,
      asr: 2 / 3,
    });
    expect(metrics.attemptsToBreak.samples).toEqual([2, 1]);
    expect(metrics.attemptsToBreak.mean).toBe(1.5);
    expect(metrics.attemptsToBreak.median).toBe(1.5);
    expect(
      metrics.byBehavior.find((group) => group.key === 'unknown'),
    ).toMatchObject({
      attempts: 1,
      knownOutcomes: 0,
      asr: null,
    });
  });

  it('measures successful template transfer across model and behavior', () => {
    const transfer = computeMetrics(records).templateTransfer;
    expect(transfer).toEqual({
      successfulTemplates: 1,
      crossModelTemplates: 1,
      crossBehaviorTemplates: 1,
      crossModelRate: 1,
      crossBehaviorRate: 1,
    });
  });

  it('renders sample and missing-data boundaries in the report', () => {
    const report = renderMarkdownReport(
      computeMetrics(records, new Date('2026-08-29T01:00:00.000Z')),
    );
    expect(report).toContain('Archived attempts: 4');
    expect(report).toContain('Outcomes missing: 1');
    expect(report).toContain(
      'Missing judge results are excluded from ASR denominators',
    );
  });
});

describe('duplicate and near-duplicate detection', () => {
  it('normalizes exact duplicates and clusters similar prompts', () => {
    const duplicates = computeDuplicateMetrics(records, 0.7);
    expect(duplicates.prompts).toBe(3);
    expect(duplicates.exactDuplicatePrompts).toBe(1);
    expect(duplicates.exactDuplicateRate).toBeCloseTo(1 / 3);
    expect(duplicates.nearDuplicateClusters).toHaveLength(1);
    expect(duplicates.nearDuplicateClusters[0]?.recordIds).toEqual([
      'a1',
      'a2',
      'b1',
    ]);
    expect(duplicates.nearDuplicateClusters[0]?.clusterId).toMatch(
      /^[a-f0-9]{16}$/,
    );
  });

  it('returns null rates and no clusters for an empty sample', () => {
    expect(computeDuplicateMetrics([])).toEqual({
      prompts: 0,
      exactDuplicatePrompts: 0,
      exactDuplicateRate: null,
      nearDuplicateClusters: [],
    });
  });
});
