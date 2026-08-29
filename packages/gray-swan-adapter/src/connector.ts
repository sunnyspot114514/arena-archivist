import type { ArchiveConnector } from '../../archive-connectors/src/index.js';

import { loadSelectorContract } from './contract.js';
import {
  GRAY_SWAN_PARSER_VERSION,
  parseIndexSnapshot,
  parseRecordSnapshot,
} from './parser.js';
import type {
  GraySwanSelectorContract,
  RawPageSnapshot,
  RecordKind,
} from './types.js';
import { detectBlockingCondition, validateParsedRecord } from './validation.js';

export const GRAY_SWAN_CONNECTOR_VERSION = '1.0.0';

/** Thin connector facade over the existing adapter. The worker remains the
 * execution owner; this object supplies registry identity and typed parsing
 * operations without exposing Playwright or a generic browser surface. */
export const graySwanArchiveConnector = Object.freeze({
  metadata: Object.freeze({
    id: 'gray-swan',
    displayName: 'Gray Swan Arena Archive',
    version: GRAY_SWAN_CONNECTOR_VERSION,
    readOnly: true as const,
    recordKinds: Object.freeze(['chat', 'submission', 'profile'] as const),
    capabilities: Object.freeze([
      'structured_page_read',
      'dom_read',
      'offline_fixture_read',
    ] as const),
    cursorFormat: 'gray-swan-index-v1',
  }),
  parserVersion: GRAY_SWAN_PARSER_VERSION,
  loadContract: (path: string): Promise<GraySwanSelectorContract> =>
    loadSelectorContract(path),
  parseIndex: (snapshot: RawPageSnapshot, contract: GraySwanSelectorContract) =>
    parseIndexSnapshot(snapshot, contract),
  parseRecord: (
    snapshot: RawPageSnapshot,
    kind: RecordKind,
    contract: GraySwanSelectorContract,
  ) => parseRecordSnapshot(snapshot, kind, contract),
  detectBlocker: (
    snapshot: RawPageSnapshot,
    contract: GraySwanSelectorContract,
  ) => detectBlockingCondition(snapshot, contract),
  validateRecord: validateParsedRecord,
}) satisfies ArchiveConnector;
