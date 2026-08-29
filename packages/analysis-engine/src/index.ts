import { createHash } from 'node:crypto';

export type AttemptOutcome = 'success' | 'failure' | 'unknown';

export type AttemptRecord = {
  id: string;
  challengeId: string | null;
  behavior: string | null;
  model: string | null;
  templateId: string | null;
  prompt: string | null;
  outcome: AttemptOutcome;
  createdAt: string;
};

export type GroupMetric = {
  key: string;
  attempts: number;
  successes: number;
  knownOutcomes: number;
  asr: number | null;
};

export type AttemptsToBreakMetric = {
  samples: number[];
  mean: number | null;
  median: number | null;
};

export type DuplicateMetrics = {
  prompts: number;
  exactDuplicatePrompts: number;
  exactDuplicateRate: number | null;
  nearDuplicateClusters: Array<{ clusterId: string; recordIds: string[] }>;
};

export type AnalysisMetrics = {
  generatedAt: string;
  sampleSize: number;
  missingOutcomeCount: number;
  overall: GroupMetric;
  byBehavior: GroupMetric[];
  byModel: GroupMetric[];
  attemptsToBreak: AttemptsToBreakMetric;
  templateTransfer: {
    successfulTemplates: number;
    crossModelTemplates: number;
    crossBehaviorTemplates: number;
    crossModelRate: number | null;
    crossBehaviorRate: number | null;
  };
  duplicates: DuplicateMetrics;
};

function metricFor(
  key: string,
  records: readonly AttemptRecord[],
): GroupMetric {
  const known = records.filter((record) => record.outcome !== 'unknown');
  const successes = known.filter(
    (record) => record.outcome === 'success',
  ).length;
  return {
    key,
    attempts: records.length,
    successes,
    knownOutcomes: known.length,
    asr: known.length ? successes / known.length : null,
  };
}

function groupedMetrics(
  records: readonly AttemptRecord[],
  select: (record: AttemptRecord) => string | null,
): GroupMetric[] {
  const groups = new Map<string, AttemptRecord[]>();
  for (const record of records) {
    const key = select(record) ?? 'unknown';
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .map(([key, group]) => metricFor(key, group))
    .sort(
      (left, right) =>
        right.attempts - left.attempts || left.key.localeCompare(right.key),
    );
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function attemptsToFirstBreak(
  records: readonly AttemptRecord[],
): AttemptsToBreakMetric {
  const series = new Map<string, AttemptRecord[]>();
  for (const record of records) {
    const key = [record.challengeId, record.behavior, record.model]
      .map((value) => value ?? 'unknown')
      .join('\u001f');
    const group = series.get(key) ?? [];
    group.push(record);
    series.set(key, group);
  }

  const samples: number[] = [];
  for (const group of series.values()) {
    group.sort(
      (left, right) =>
        Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
        left.id.localeCompare(right.id),
    );
    const index = group.findIndex((record) => record.outcome === 'success');
    if (index >= 0) samples.push(index + 1);
  }

  return {
    samples,
    mean: samples.length
      ? samples.reduce((sum, value) => sum + value, 0) / samples.length
      : null,
    median: median(samples),
  };
}

function normalizePrompt(prompt: string): string {
  return prompt
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function ngrams(value: string, size = 3): Set<string> {
  const compact = value.replace(/\s/g, '');
  if (compact.length <= size) return new Set([compact]);
  const output = new Set<string>();
  for (let index = 0; index <= compact.length - size; index += 1) {
    output.add(compact.slice(index, index + size));
  }
  return output;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size && !right.size) return 1;
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

class UnionFind {
  readonly #parents: number[];

  constructor(size: number) {
    this.#parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.#parents[index];
    if (parent !== index) this.#parents[index] = this.find(parent);
    return this.#parents[index];
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.#parents[rightRoot] = leftRoot;
  }
}

export function computeDuplicateMetrics(
  records: readonly AttemptRecord[],
  threshold = 0.88,
): DuplicateMetrics {
  const withPrompts = records
    .filter((record): record is AttemptRecord & { prompt: string } =>
      Boolean(record.prompt),
    )
    .map((record) => ({
      record,
      normalized: normalizePrompt(record.prompt),
    }));

  const exactCounts = new Map<string, number>();
  for (const { normalized } of withPrompts) {
    const digest = createHash('sha256').update(normalized).digest('hex');
    exactCounts.set(digest, (exactCounts.get(digest) ?? 0) + 1);
  }
  const exactDuplicatePrompts = [...exactCounts.values()].reduce(
    (sum, count) => sum + Math.max(0, count - 1),
    0,
  );

  const fingerprints = withPrompts.map(({ normalized }) => ngrams(normalized));
  const union = new UnionFind(withPrompts.length);
  for (let left = 0; left < withPrompts.length; left += 1) {
    for (let right = left + 1; right < withPrompts.length; right += 1) {
      if (jaccard(fingerprints[left], fingerprints[right]) >= threshold) {
        union.union(left, right);
      }
    }
  }

  const clusters = new Map<number, string[]>();
  for (let index = 0; index < withPrompts.length; index += 1) {
    const root = union.find(index);
    const cluster = clusters.get(root) ?? [];
    cluster.push(withPrompts[index].record.id);
    clusters.set(root, cluster);
  }

  const nearDuplicateClusters = [...clusters.values()]
    .filter((recordIds) => recordIds.length > 1)
    .map((recordIds) => ({
      clusterId: createHash('sha256')
        .update(recordIds.join('\u001f'))
        .digest('hex')
        .slice(0, 16),
      recordIds,
    }));

  return {
    prompts: withPrompts.length,
    exactDuplicatePrompts,
    exactDuplicateRate: withPrompts.length
      ? exactDuplicatePrompts / withPrompts.length
      : null,
    nearDuplicateClusters,
  };
}

export function computeMetrics(
  records: readonly AttemptRecord[],
  now = new Date(),
): AnalysisMetrics {
  const successfulByTemplate = new Map<
    string,
    { models: Set<string>; behaviors: Set<string> }
  >();
  for (const record of records) {
    if (record.outcome !== 'success' || !record.templateId) continue;
    const entry = successfulByTemplate.get(record.templateId) ?? {
      models: new Set<string>(),
      behaviors: new Set<string>(),
    };
    if (record.model) entry.models.add(record.model);
    if (record.behavior) entry.behaviors.add(record.behavior);
    successfulByTemplate.set(record.templateId, entry);
  }

  const successfulTemplates = successfulByTemplate.size;
  const crossModelTemplates = [...successfulByTemplate.values()].filter(
    (entry) => entry.models.size > 1,
  ).length;
  const crossBehaviorTemplates = [...successfulByTemplate.values()].filter(
    (entry) => entry.behaviors.size > 1,
  ).length;

  return {
    generatedAt: now.toISOString(),
    sampleSize: records.length,
    missingOutcomeCount: records.filter(
      (record) => record.outcome === 'unknown',
    ).length,
    overall: metricFor('all', records),
    byBehavior: groupedMetrics(records, (record) => record.behavior),
    byModel: groupedMetrics(records, (record) => record.model),
    attemptsToBreak: attemptsToFirstBreak(records),
    templateTransfer: {
      successfulTemplates,
      crossModelTemplates,
      crossBehaviorTemplates,
      crossModelRate: successfulTemplates
        ? crossModelTemplates / successfulTemplates
        : null,
      crossBehaviorRate: successfulTemplates
        ? crossBehaviorTemplates / successfulTemplates
        : null,
    },
    duplicates: computeDuplicateMetrics(records),
  };
}

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdownReport(metrics: AnalysisMetrics): string {
  const groupRows = (groups: readonly GroupMetric[]) =>
    groups.length
      ? groups
          .map(
            (group) =>
              `| ${group.key.replace(/\|/g, '\\|')} | ${group.attempts} | ${group.successes} | ${percent(group.asr)} |`,
          )
          .join('\n')
      : '| — | 0 | 0 | n/a |';

  return `# Arena Archivist analysis report

Generated: ${metrics.generatedAt}

## Sample

- Archived attempts: ${metrics.sampleSize}
- Outcomes missing: ${metrics.missingOutcomeCount}
- Overall ASR: ${percent(metrics.overall.asr)} (${metrics.overall.successes}/${metrics.overall.knownOutcomes})
- Attempts to first break: ${metrics.attemptsToBreak.mean === null ? 'n/a' : metrics.attemptsToBreak.mean.toFixed(2)} mean, ${metrics.attemptsToBreak.median ?? 'n/a'} median

## Behavior results

| Behavior | Attempts | Successes | ASR |
| --- | ---: | ---: | ---: |
${groupRows(metrics.byBehavior)}

## Anonymous model results

| Model | Attempts | Successes | ASR |
| --- | ---: | ---: | ---: |
${groupRows(metrics.byModel)}

## Transfer and repetition

- Successful templates: ${metrics.templateTransfer.successfulTemplates}
- Cross-model transfer: ${percent(metrics.templateTransfer.crossModelRate)}
- Cross-behavior transfer: ${percent(metrics.templateTransfer.crossBehaviorRate)}
- Exact duplicate prompt rate: ${percent(metrics.duplicates.exactDuplicateRate)}
- Near-duplicate clusters: ${metrics.duplicates.nearDuplicateClusters.length}

## Interpretation boundary

These statistics describe the archived sample only. Missing judge results are excluded from ASR denominators. Model annotations, when present, are derived data and do not modify the archive.
`;
}

export const ATTACK_TAXONOMY_V1 = [
  'authority_spoofing',
  'roleplay',
  'context_laundering',
  'instruction_hierarchy_confusion',
  'format_smuggling',
  'semantic_indirection',
  'goal_substitution',
  'multi_turn_escalation',
  'judge_targeting',
  'concealment',
  'indirect_injection',
] as const;
