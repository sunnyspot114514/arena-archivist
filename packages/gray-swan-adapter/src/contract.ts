import { readFile } from 'node:fs/promises';

import {
  RECORD_KINDS,
  type FieldSelector,
  type GraySwanSelectorContract,
  type RecordSelectorContract,
  type SelectorCandidate,
} from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertCandidate(
  value: unknown,
  path: string,
): asserts value is SelectorCandidate {
  if (
    !isObject(value) ||
    typeof value.id !== 'string' ||
    typeof value.selector !== 'string'
  ) {
    throw new Error(`${path} must contain string id and selector fields`);
  }

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
}

function assertCandidates(
  value: unknown,
  path: string,
): asserts value is readonly SelectorCandidate[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must be a non-empty array`);
  }

  value.forEach((candidate, index) =>
    assertCandidate(candidate, `${path}[${index}]`),
  );
}

function assertField(
  value: unknown,
  path: string,
): asserts value is FieldSelector {
  if (!isObject(value) || typeof value.required !== 'boolean') {
    throw new Error(`${path}.required must be a boolean`);
  }
  assertCandidates(value.candidates, `${path}.candidates`);
}

function assertRecord(
  value: unknown,
  path: string,
): asserts value is RecordSelectorContract {
  if (!isObject(value)) throw new Error(`${path} must be an object`);
  assertCandidates(value.root, `${path}.root`);
  if (!isObject(value.fields))
    throw new Error(`${path}.fields must be an object`);
  assertField(value.fields.externalId, `${path}.fields.externalId`);
  assertField(value.fields.title, `${path}.fields.title`);

  for (const optionalField of ['behavior', 'modelAlias', 'status'] as const) {
    if (value.fields[optionalField] !== undefined) {
      assertField(
        value.fields[optionalField],
        `${path}.fields.${optionalField}`,
      );
    }
  }

  for (const repeatedKey of ['messages', 'judgeResults'] as const) {
    const repeated = value[repeatedKey];
    if (repeated === undefined) continue;
    if (!isObject(repeated) || !isObject(repeated.fields)) {
      throw new Error(`${path}.${repeatedKey} must contain item and fields`);
    }
    assertCandidates(repeated.item, `${path}.${repeatedKey}.item`);
    for (const [fieldName, field] of Object.entries(repeated.fields)) {
      assertField(field, `${path}.${repeatedKey}.fields.${fieldName}`);
    }
  }
}

export function assertSelectorContract(
  value: unknown,
): asserts value is GraySwanSelectorContract {
  if (!isObject(value)) throw new Error('selector contract must be an object');
  if (value.schemaVersion !== 1)
    throw new Error('unsupported selector contract schemaVersion');
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
  assertCandidates(value.index.root, 'index.root');
  assertCandidates(value.index.item, 'index.item');
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
    assertField(value.index.fields[fieldName], `index.fields.${fieldName}`);
  }
  if (value.index.fields.updatedAt !== undefined) {
    assertField(value.index.fields.updatedAt, 'index.fields.updatedAt');
  }

  if (!isObject(value.records))
    throw new Error('record selector contracts are required');
  for (const kind of RECORD_KINDS)
    assertRecord(value.records[kind], `records.${kind}`);

  if (!isObject(value.blockers))
    throw new Error('blocker selectors are required');
  for (const blocker of ['loginRequired', 'captcha', 'botChallenge'] as const) {
    assertCandidates(value.blockers[blocker], `blockers.${blocker}`);
  }
}

export async function loadSelectorContract(
  path: string,
): Promise<GraySwanSelectorContract> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  assertSelectorContract(value);
  return value;
}
