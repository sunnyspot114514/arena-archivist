import { readFile } from 'node:fs/promises';

import {
  RECORD_KINDS,
  type FieldSelector,
  type GraySwanSelectorContract,
  type IndexPreparationPlan,
  type RecordSelectorContract,
  type SelectorCandidate,
} from './types.js';

const SAFE_INDEX_PREPARATION_STEPS = [
  {
    intent: 'open_history_panel',
    selector: 'button[type=button]',
    expectedTextPattern: '^Chats\\s+\\d+$',
  },
  {
    intent: 'select_chat_tab',
    selector: 'div[role=dialog] button',
    expectedTextPattern: '^Chats\\s+\\(\\d+\\)$',
  },
] as const;

const SAFE_INDEX_READY_SELECTOR = 'div[role=dialog] a[href*="chatId="]';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCandidate(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): asserts value is SelectorCandidate {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.selector !== 'string'
  ) {
    throw new Error(`${path} must contain string id and selector fields`);
  }

  if (schemaVersion === 1) {
    if (
      value.source !== undefined &&
      value.source !== 'text' &&
      value.source !== 'attribute'
    ) {
      throw new Error(`${path}.source must be text or attribute`);
    }

    if (value.source === 'attribute' && typeof value.attribute !== 'string') {
      throw new Error(`${path}.attribute is required for attribute extraction`);
    }
    return;
  }

  if (
    value.source !== undefined &&
    value.source !== 'text' &&
    value.source !== 'attribute' &&
    value.source !== 'constant' &&
    value.source !== 'url_query'
  ) {
    throw new Error(
      `${path}.source must be text, attribute, constant, or url_query`,
    );
  }

  if (
    value.source === 'attribute' &&
    (typeof value.attribute !== 'string' || value.attribute.length === 0)
  ) {
    throw new Error(`${path}.attribute is required for attribute extraction`);
  }

  if (value.source === 'constant') {
    if (
      typeof value.value !== 'string' ||
      value.value.length === 0 ||
      value.value.length > 256
    ) {
      throw new Error(`${path}.value must be a non-empty short string`);
    }
    if (
      path.startsWith('index.fields.kind') &&
      !RECORD_KINDS.includes(value.value as (typeof RECORD_KINDS)[number])
    ) {
      throw new Error(`${path}.value must be a supported record kind`);
    }
    if (
      path.includes('.messages.fields.role.') &&
      value.value !== 'user' &&
      value.value !== 'assistant'
    ) {
      throw new Error(`${path}.value must be user or assistant`);
    }
  }

  if (value.source === 'url_query') {
    if (
      typeof value.queryParam !== 'string' ||
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(value.queryParam)
    ) {
      throw new Error(`${path}.queryParam must be a safe query parameter`);
    }
    if (
      value.attribute !== undefined &&
      (typeof value.attribute !== 'string' || value.attribute.length === 0)
    ) {
      throw new Error(`${path}.attribute must be a non-empty string`);
    }
  }
}

function assertCandidates(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): asserts value is readonly SelectorCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }

  value.forEach((candidate, index) =>
    assertCandidate(candidate, `${path}[${index}]`, schemaVersion),
  );
}

function assertField(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): asserts value is FieldSelector {
  if (!isObject(value) || typeof value.required !== 'boolean') {
    throw new Error(`${path}.required must be a boolean`);
  }
  assertCandidates(value.candidates, `${path}.candidates`, schemaVersion);
}

function assertRecord(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): asserts value is RecordSelectorContract {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  assertCandidates(value.root, `${path}.root`, schemaVersion);
  if (!isObject(value.fields))
    throw new Error(`${path}.fields must be an object`);
  assertField(
    value.fields.externalId,
    `${path}.fields.externalId`,
    schemaVersion,
  );
  assertField(value.fields.title, `${path}.fields.title`, schemaVersion);

  for (const optionalField of ['behavior', 'modelAlias', 'status'] as const) {
    if (value.fields[optionalField] !== undefined) {
      assertField(
        value.fields[optionalField],
        `${path}.fields.${optionalField}`,
        schemaVersion,
      );
    }
  }

  for (const repeatedKey of ['messages', 'judgeResults'] as const) {
    const repeated = value[repeatedKey];
    if (repeated === undefined) continue;
    if (!isObject(repeated) || !isObject(repeated.fields)) {
      throw new Error(`${path}.${repeatedKey} must contain item and fields`);
    }
    assertCandidates(
      repeated.item,
      `${path}.${repeatedKey}.item`,
      schemaVersion,
    );
    for (const [fieldName, field] of Object.entries(repeated.fields)) {
      assertField(
        field,
        `${path}.${repeatedKey}.fields.${fieldName}`,
        schemaVersion,
      );
    }
  }
}

function assertIndexPreparation(
  value: unknown,
  path: string,
  schemaVersion: 1 | 2,
): asserts value is IndexPreparationPlan {
  if (schemaVersion !== 2) {
    throw new Error(`${path} requires selector contract schemaVersion 2`);
  }
  if (!isObject(value) || !Array.isArray(value.steps)) {
    throw new Error(`${path} must contain a steps array`);
  }
  if (value.steps.length !== SAFE_INDEX_PREPARATION_STEPS.length) {
    throw new Error(`${path}.steps must contain exactly two safe steps`);
  }
  for (const [index, expected] of SAFE_INDEX_PREPARATION_STEPS.entries()) {
    const step = value.steps[index];
    if (
      !isObject(step) ||
      step.intent !== expected.intent ||
      step.selector !== expected.selector ||
      step.expectedTextPattern !== expected.expectedTextPattern
    ) {
      throw new Error(`${path}.steps[${index}] is not an approved step`);
    }
  }
  if (value.readySelector !== SAFE_INDEX_READY_SELECTOR) {
    throw new Error(`${path}.readySelector is not approved`);
  }
  if (
    typeof value.timeoutMs !== 'number' ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1 ||
    value.timeoutMs > 30_000
  ) {
    throw new Error(`${path}.timeoutMs must be an integer from 1 to 30000`);
  }
}

export function assertSelectorContract(
  value: unknown,
): asserts value is GraySwanSelectorContract {
  if (!isObject(value)) throw new Error('selector contract must be an object');
  if (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    throw new Error('unsupported selector contract schemaVersion');
  const schemaVersion = value.schemaVersion;
  if (
    typeof value.contractId !== 'string' ||
    typeof value.contractVersion !== 'string'
  ) {
    throw new Error(
      'selector contract requires contractId and contractVersion',
    );
  }
  if (!isObject(value.compatibility))
    throw new Error('compatibility metadata is required');
  if (
    value.compatibility.status !== 'fixture-baseline' &&
    value.compatibility.status !== 'captured' &&
    value.compatibility.status !== 'verified' &&
    value.compatibility.status !== 'retired'
  ) {
    throw new Error('compatibility.status is invalid');
  }
  if (
    value.compatibility.capturedAt !== null &&
    typeof value.compatibility.capturedAt !== 'string'
  ) {
    throw new Error('compatibility.capturedAt must be a string or null');
  }
  if (
    value.compatibility.pageBuild !== null &&
    typeof value.compatibility.pageBuild !== 'string'
  ) {
    throw new Error('compatibility.pageBuild must be a string or null');
  }
  if (typeof value.compatibility.notes !== 'string') {
    throw new Error('compatibility.notes must be a string');
  }
  if (!isObject(value.index))
    throw new Error('index selector contract is required');
  assertCandidates(value.index.root, 'index.root', schemaVersion);
  assertCandidates(value.index.item, 'index.item', schemaVersion);
  if (value.index.preparation !== undefined) {
    assertIndexPreparation(
      value.index.preparation,
      'index.preparation',
      schemaVersion,
    );
  }
  if (!isObject(value.index.hrefPatterns))
    throw new Error('index.hrefPatterns must be an object');
  for (const kind of RECORD_KINDS) {
    const pattern = value.index.hrefPatterns[kind];
    if (
      typeof pattern !== 'string' ||
      pattern.length > 512 ||
      !pattern.startsWith('^') ||
      !pattern.endsWith('$')
    ) {
      throw new Error(
        `index.hrefPatterns.${kind} must be a short anchored regular expression`,
      );
    }
    try {
      new RegExp(pattern, 'u');
    } catch {
      throw new Error(
        `index.hrefPatterns.${kind} is not a valid regular expression`,
      );
    }
  }
  if (!isObject(value.index.fields))
    throw new Error('index.fields must be an object');
  for (const fieldName of ['externalId', 'kind', 'href', 'title'] as const) {
    assertField(
      value.index.fields[fieldName],
      `index.fields.${fieldName}`,
      schemaVersion,
    );
  }
  if (value.index.fields.updatedAt !== undefined) {
    assertField(
      value.index.fields.updatedAt,
      'index.fields.updatedAt',
      schemaVersion,
    );
  }

  if (!isObject(value.records))
    throw new Error('record selector contracts are required');
  for (const kind of RECORD_KINDS) {
    assertRecord(value.records[kind], `records.${kind}`, schemaVersion);
  }

  if (!isObject(value.blockers))
    throw new Error('blocker selectors are required');
  for (const blocker of ['loginRequired', 'captcha', 'botChallenge'] as const) {
    assertCandidates(
      value.blockers[blocker],
      `blockers.${blocker}`,
      schemaVersion,
    );
  }
}

export async function loadSelectorContract(
  path: string,
): Promise<GraySwanSelectorContract> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertSelectorContract(value);
  return value;
}
