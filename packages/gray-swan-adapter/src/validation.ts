import type {
  BlockingCondition,
  GraySwanSelectorContract,
  ParseIssue,
  ParseResult,
  ParsedGraySwanRecord,
  RawPageSnapshot,
  SelectorCandidate,
} from './types.js';
import {
  createSnapshotDocument,
  type SnapshotDocument,
} from './html-snapshot.js';

function hasAnySelector(
  document: SnapshotDocument,
  candidates: readonly SelectorCandidate[],
): boolean {
  return candidates.some(
    (candidate) => document.queryFirst(candidate.selector) !== null,
  );
}

export function detectBlockingCondition(
  snapshot: RawPageSnapshot,
  contract: GraySwanSelectorContract,
): BlockingCondition | null {
  if (snapshot.responseStatus === 403) return 'http_403';
  if (snapshot.responseStatus === 429) return 'http_429';

  const document = createSnapshotDocument(snapshot.html);
  if (hasAnySelector(document, contract.blockers.captcha)) return 'captcha';
  if (hasAnySelector(document, contract.blockers.botChallenge))
    return 'bot_challenge';
  if (hasAnySelector(document, contract.blockers.loginRequired))
    return 'login_required';

  let url: URL | null = null;
  try {
    url = new URL(snapshot.url);
  } catch {
    // A malformed URL is handled by record validation, not interpreted as an auth signal.
  }
  if (
    url &&
    /\/(?:login|log-in|signin|sign-in|auth)(?:\/|$)/i.test(url.pathname)
  ) {
    return 'login_required';
  }

  // Title checks are intentionally limited to page chrome. Searching record body text could
  // mistake archived red-team content for an active challenge page.
  if (/captcha|verify (?:that )?you are human/i.test(snapshot.title))
    return 'captcha';
  if (
    /just a moment|checking your browser|security challenge/i.test(
      snapshot.title,
    )
  ) {
    return 'bot_challenge';
  }
  if (/sign in|log in|authentication required/i.test(snapshot.title))
    return 'login_required';
  return null;
}

export function validateParsedRecord(
  record: ParsedGraySwanRecord,
  expectedExternalId?: string,
): ParseResult<ParsedGraySwanRecord> {
  const issues: ParseIssue[] = [];
  if (!record.externalId || record.externalId.length > 256) {
    issues.push({
      code: 'field_invalid',
      field: 'externalId',
      message: 'Record id is empty or too long',
    });
  }
  if (
    expectedExternalId !== undefined &&
    record.externalId !== expectedExternalId
  ) {
    issues.push({
      code: 'expected_id_mismatch',
      field: 'externalId',
      message: `Expected ${expectedExternalId}, received ${record.externalId}`,
    });
  }
  if (!record.title || record.title.length > 2_000) {
    issues.push({
      code: 'field_invalid',
      field: 'title',
      message: 'Title is empty or too long',
    });
  }
  try {
    const sourceUrl = new URL(record.sourceUrl);
    if (sourceUrl.protocol !== 'https:' && sourceUrl.protocol !== 'http:')
      throw new Error('bad protocol');
  } catch {
    issues.push({
      code: 'field_invalid',
      field: 'sourceUrl',
      message: 'Source URL is not HTTP(S)',
    });
  }
  if (
    (record.kind === 'chat' || record.kind === 'submission') &&
    record.messages.length === 0
  ) {
    issues.push({
      code: 'field_missing',
      field: 'messages',
      message: 'Conversation record has no messages',
    });
  }
  for (const message of record.messages) {
    if (!message.role || !message.body) {
      issues.push({
        code: 'field_invalid',
        field: `messages[${message.ordinal}]`,
        message: 'Message role and body are required',
      });
    }
  }

  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: record, warnings: [] };
}
