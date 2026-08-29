import {
  createSnapshotDocument,
  type SnapshotDocument,
  type SnapshotElement,
} from './html-snapshot.js';
import type {
  ArchivedJudgeResult,
  ArchivedMessage,
  FieldSelector,
  GraySwanSelectorContract,
  IndexRecordLink,
  ParseIssue,
  ParseResult,
  ParsedGraySwanRecord,
  ParsedIndex,
  RawPageSnapshot,
  RecordKind,
  RepeatedFieldSelector,
  SelectorCandidate,
  SelectorTrace,
} from './types.js';

export const GRAY_SWAN_PARSER_VERSION = '1.0.0';

interface SelectedElement {
  readonly element: SnapshotElement;
  readonly candidate: SelectorCandidate;
}

interface ExtractedValue {
  readonly value: string;
  readonly candidate: SelectorCandidate;
}

function selectFirst(
  scope: SnapshotElement,
  candidates: readonly SelectorCandidate[],
): SelectedElement | null {
  for (const candidate of candidates) {
    const element = scope.queryFirst(candidate.selector);
    if (element) return { element, candidate };
  }
  return null;
}

function selectAll(
  scope: SnapshotElement,
  candidates: readonly SelectorCandidate[],
): {
  readonly elements: readonly SnapshotElement[];
  readonly candidate: SelectorCandidate;
} | null {
  for (const candidate of candidates) {
    const elements = scope.queryAll(candidate.selector);
    if (elements.length > 0) return { elements, candidate };
  }
  return null;
}

function extractValue(
  scope: SnapshotElement,
  field: FieldSelector,
): ExtractedValue | null {
  const selected = selectFirst(scope, field.candidates);
  if (!selected) return null;
  const value =
    selected.candidate.source === 'attribute'
      ? selected.element.attribute(selected.candidate.attribute ?? '')
      : selected.element.text;
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  return normalized
    ? { value: normalized, candidate: selected.candidate }
    : null;
}

function trace(field: string, extracted: ExtractedValue): SelectorTrace {
  return {
    field,
    candidateId: extracted.candidate.id,
    selector: extracted.candidate.selector,
  };
}

function missingField(field: string): ParseIssue {
  return {
    code: 'field_missing',
    field,
    message: `Required field ${field} was not found`,
  };
}

function parseKind(value: string): RecordKind | null {
  return value === 'chat' || value === 'submission' || value === 'profile'
    ? value
    : null;
}

export function parseIndexSnapshot(
  snapshot: RawPageSnapshot,
  contract: GraySwanSelectorContract,
): ParseResult<ParsedIndex> {
  const document = createSnapshotDocument(snapshot.html);
  const root = selectFirst(document, contract.index.root);
  if (!root) {
    return {
      ok: false,
      issues: [{ code: 'root_not_found', message: 'Index root was not found' }],
    };
  }

  const itemSelection = selectAll(root.element, contract.index.item);
  if (!itemSelection) {
    return {
      ok: false,
      issues: [
        { code: 'root_not_found', message: 'Index contained no record items' },
      ],
    };
  }

  const issues: ParseIssue[] = [];
  const traces: SelectorTrace[] = [
    {
      field: 'index.root',
      candidateId: root.candidate.id,
      selector: root.candidate.selector,
    },
    {
      field: 'index.item',
      candidateId: itemSelection.candidate.id,
      selector: itemSelection.candidate.selector,
    },
  ];
  const records: IndexRecordLink[] = [];
  const ids = new Set<string>();

  for (const [ordinal, item] of itemSelection.elements.entries()) {
    const values = {
      externalId: extractValue(item, contract.index.fields.externalId),
      kind: extractValue(item, contract.index.fields.kind),
      href: extractValue(item, contract.index.fields.href),
      title: extractValue(item, contract.index.fields.title),
      updatedAt: contract.index.fields.updatedAt
        ? extractValue(item, contract.index.fields.updatedAt)
        : null,
    };

    for (const fieldName of ['externalId', 'kind', 'href', 'title'] as const) {
      const value = values[fieldName];
      if (!value) issues.push(missingField(`index[${ordinal}].${fieldName}`));
      else traces.push(trace(`index[${ordinal}].${fieldName}`, value));
    }
    if (values.updatedAt)
      traces.push(trace(`index[${ordinal}].updatedAt`, values.updatedAt));
    if (!values.externalId || !values.kind || !values.href || !values.title)
      continue;

    const kind = parseKind(values.kind.value);
    if (!kind) {
      issues.push({
        code: 'kind_unsupported',
        field: `index[${ordinal}].kind`,
        message: `Unsupported record kind: ${values.kind.value}`,
      });
      continue;
    }
    if (
      !new RegExp(contract.index.hrefPatterns[kind], 'u').test(
        values.href.value,
      )
    ) {
      issues.push({
        code: 'field_invalid',
        field: `index[${ordinal}].href`,
        message: `Record href is outside the ${kind} contract allowlist`,
      });
      continue;
    }
    if (ids.has(values.externalId.value)) {
      issues.push({
        code: 'duplicate_id',
        field: `index[${ordinal}].externalId`,
        message: `Duplicate record id: ${values.externalId.value}`,
      });
      continue;
    }
    ids.add(values.externalId.value);
    records.push({
      externalId: values.externalId.value,
      kind,
      href: values.href.value,
      title: values.title.value,
      updatedAt: values.updatedAt?.value ?? null,
    });
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      contractVersion: contract.contractVersion,
      records,
      trace: traces,
    },
    warnings: [],
  };
}

function parseRepeated(
  root: SnapshotElement,
  repeated: RepeatedFieldSelector | undefined,
  path: string,
): {
  readonly values: readonly Readonly<Record<string, string | null>>[];
  readonly trace: readonly SelectorTrace[];
  readonly issues: readonly ParseIssue[];
} {
  if (!repeated) return { values: [], trace: [], issues: [] };
  const selected = selectAll(root, repeated.item);
  if (!selected) return { values: [], trace: [], issues: [] };
  const values: Readonly<Record<string, string | null>>[] = [];
  const traces: SelectorTrace[] = [
    {
      field: path,
      candidateId: selected.candidate.id,
      selector: selected.candidate.selector,
    },
  ];
  const issues: ParseIssue[] = [];

  for (const [ordinal, item] of selected.elements.entries()) {
    const row: Record<string, string | null> = {};
    for (const [fieldName, field] of Object.entries(repeated.fields)) {
      const extracted = extractValue(item, field);
      row[fieldName] = extracted?.value ?? null;
      if (extracted)
        traces.push(trace(`${path}[${ordinal}].${fieldName}`, extracted));
      else if (field.required)
        issues.push(missingField(`${path}[${ordinal}].${fieldName}`));
    }
    values.push(row);
  }

  return { values, trace: traces, issues };
}

export function parseRecordSnapshot(
  snapshot: RawPageSnapshot,
  kind: RecordKind,
  contract: GraySwanSelectorContract,
): ParseResult<ParsedGraySwanRecord> {
  const recordContract = contract.records[kind];
  const document: SnapshotDocument = createSnapshotDocument(snapshot.html);
  const root = selectFirst(document, recordContract.root);
  if (!root) {
    return {
      ok: false,
      issues: [
        {
          code: 'root_not_found',
          message: `Record root for ${kind} was not found`,
        },
      ],
    };
  }

  const issues: ParseIssue[] = [];
  const traces: SelectorTrace[] = [
    {
      field: 'record.root',
      candidateId: root.candidate.id,
      selector: root.candidate.selector,
    },
  ];
  const fieldValues: Record<string, string | null> = {};

  for (const [fieldName, field] of Object.entries(recordContract.fields)) {
    const extracted = extractValue(root.element, field);
    fieldValues[fieldName] = extracted?.value ?? null;
    if (extracted) traces.push(trace(`record.${fieldName}`, extracted));
    else if (field.required) issues.push(missingField(`record.${fieldName}`));
  }

  const messages = parseRepeated(
    root.element,
    recordContract.messages,
    'record.messages',
  );
  const judgeResults = parseRepeated(
    root.element,
    recordContract.judgeResults,
    'record.judgeResults',
  );
  issues.push(...messages.issues, ...judgeResults.issues);
  traces.push(...messages.trace, ...judgeResults.trace);

  if (issues.length > 0 || !fieldValues.externalId || !fieldValues.title) {
    return { ok: false, issues };
  }

  const archivedMessages: ArchivedMessage[] = messages.values.map(
    (message, ordinal) => ({
      ordinal,
      role: message.role ?? '',
      body: message.body ?? '',
    }),
  );
  const archivedJudgeResults: ArchivedJudgeResult[] = judgeResults.values.map(
    (judge, ordinal) => ({
      ordinal,
      label: judge.label ?? '',
      score: judge.score ?? null,
      explanation: judge.explanation ?? null,
    }),
  );

  return {
    ok: true,
    value: {
      platform: 'gray-swan',
      kind,
      externalId: fieldValues.externalId,
      title: fieldValues.title,
      behavior: fieldValues.behavior ?? null,
      modelAlias: fieldValues.modelAlias ?? null,
      status: fieldValues.status ?? null,
      messages: archivedMessages,
      judgeResults: archivedJudgeResults,
      sourceUrl: snapshot.url,
      capturedAt: snapshot.capturedAt,
      parserVersion: GRAY_SWAN_PARSER_VERSION,
      selectorContractVersion: contract.contractVersion,
      dataPolicy: 'local_only',
      trace: traces,
    },
    warnings: [],
  };
}
