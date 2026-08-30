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

export const GRAY_SWAN_PARSER_VERSION = '1.1.0';

interface SelectedElement {
  readonly element: SnapshotElement;
  readonly candidate: SelectorCandidate;
}

interface ExtractedValue {
  readonly value: string;
  readonly candidate: SelectorCandidate;
}

type ExtractionResult =
  | { readonly status: 'found'; readonly extracted: ExtractedValue }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly message: string };

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
  snapshotUrl: string,
): ExtractionResult {
  const selected = selectFirst(scope, field.candidates);
  if (!selected) return { status: 'missing' };

  let value: string | null | undefined;
  if (selected.candidate.source === 'attribute') {
    value = selected.element.attribute(selected.candidate.attribute ?? '');
  } else if (selected.candidate.source === 'constant') {
    value = selected.candidate.value;
  } else if (selected.candidate.source === 'url_query') {
    const urlValue = selected.candidate.attribute
      ? selected.element.attribute(selected.candidate.attribute)
      : snapshotUrl;
    if (!urlValue) {
      return {
        status: 'invalid',
        message: 'URL query extraction source was empty',
      };
    }
    let url: URL;
    try {
      url = new URL(urlValue, snapshotUrl);
    } catch {
      return {
        status: 'invalid',
        message: 'URL query extraction source was not a valid URL',
      };
    }
    const queryParam = selected.candidate.queryParam ?? '';
    const queryValues = url.searchParams.getAll(queryParam);
    if (queryValues.length !== 1) {
      return {
        status: 'invalid',
        message: `URL query parameter ${queryParam} must occur exactly once`,
      };
    }
    value = queryValues[0];
  } else {
    value = selected.element.text;
  }

  const normalized =
    selected.candidate.source === 'url_query'
      ? (value?.trim() ?? '')
      : (value?.replace(/\s+/g, ' ').trim() ?? '');
  if (!normalized) {
    return selected.candidate.source === 'url_query'
      ? {
          status: 'invalid',
          message: 'URL query extraction produced an empty value',
        }
      : { status: 'missing' };
  }
  return {
    status: 'found',
    extracted: { value: normalized, candidate: selected.candidate },
  };
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

function invalidField(field: string, message: string): ParseIssue {
  return { code: 'field_invalid', field, message };
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
    const extractions = {
      externalId: extractValue(
        item,
        contract.index.fields.externalId,
        snapshot.url,
      ),
      kind: extractValue(item, contract.index.fields.kind, snapshot.url),
      href: extractValue(item, contract.index.fields.href, snapshot.url),
      title: extractValue(item, contract.index.fields.title, snapshot.url),
      updatedAt: contract.index.fields.updatedAt
        ? extractValue(item, contract.index.fields.updatedAt, snapshot.url)
        : ({ status: 'missing' } as const),
    };
    const values = {
      externalId:
        extractions.externalId.status === 'found'
          ? extractions.externalId.extracted
          : null,
      kind:
        extractions.kind.status === 'found' ? extractions.kind.extracted : null,
      href:
        extractions.href.status === 'found' ? extractions.href.extracted : null,
      title:
        extractions.title.status === 'found'
          ? extractions.title.extracted
          : null,
      updatedAt:
        extractions.updatedAt.status === 'found'
          ? extractions.updatedAt.extracted
          : null,
    };

    for (const fieldName of ['externalId', 'kind', 'href', 'title'] as const) {
      const value = values[fieldName];
      const fieldPath = `index[${ordinal}].${fieldName}`;
      const extraction = extractions[fieldName];
      if (extraction.status === 'invalid') {
        issues.push(invalidField(fieldPath, extraction.message));
      } else if (!value) issues.push(missingField(fieldPath));
      else traces.push(trace(fieldPath, value));
    }
    if (extractions.updatedAt.status === 'invalid') {
      issues.push(
        invalidField(
          `index[${ordinal}].updatedAt`,
          extractions.updatedAt.message,
        ),
      );
    } else if (values.updatedAt) {
      traces.push(trace(`index[${ordinal}].updatedAt`, values.updatedAt));
    }
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
  snapshotUrl: string,
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
      const extraction = extractValue(item, field, snapshotUrl);
      const fieldPath = `${path}[${ordinal}].${fieldName}`;
      const extracted =
        extraction.status === 'found' ? extraction.extracted : null;
      row[fieldName] = extracted?.value ?? null;
      if (extracted) traces.push(trace(fieldPath, extracted));
      else if (extraction.status === 'invalid') {
        issues.push(invalidField(fieldPath, extraction.message));
      } else if (field.required) issues.push(missingField(fieldPath));
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
    const extraction = extractValue(root.element, field, snapshot.url);
    const fieldPath = `record.${fieldName}`;
    const extracted =
      extraction.status === 'found' ? extraction.extracted : null;
    fieldValues[fieldName] = extracted?.value ?? null;
    if (extracted) traces.push(trace(fieldPath, extracted));
    else if (extraction.status === 'invalid') {
      issues.push(invalidField(fieldPath, extraction.message));
    } else if (field.required) issues.push(missingField(fieldPath));
  }

  const messages = parseRepeated(
    root.element,
    recordContract.messages,
    'record.messages',
    snapshot.url,
  );
  const judgeResults = parseRepeated(
    root.element,
    recordContract.judgeResults,
    'record.judgeResults',
    snapshot.url,
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
