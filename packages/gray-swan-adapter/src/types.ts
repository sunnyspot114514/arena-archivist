export const RECORD_KINDS = ['chat', 'submission', 'profile'] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

export type ExtractionSource = 'text' | 'attribute';

export interface SelectorCandidate {
  readonly id: string;
  readonly selector: string;
  readonly source?: ExtractionSource;
  readonly attribute?: string;
}

export interface FieldSelector {
  readonly required: boolean;
  readonly candidates: readonly SelectorCandidate[];
}

export interface RepeatedFieldSelector {
  readonly item: readonly SelectorCandidate[];
  readonly fields: Readonly<Record<string, FieldSelector>>;
}

export interface IndexSelectorContract {
  readonly root: readonly SelectorCandidate[];
  readonly item: readonly SelectorCandidate[];
  readonly hrefPatterns: Readonly<Record<RecordKind, string>>;
  readonly fields: {
    readonly externalId: FieldSelector;
    readonly kind: FieldSelector;
    readonly href: FieldSelector;
    readonly title: FieldSelector;
    readonly updatedAt?: FieldSelector;
  };
}

export interface RecordSelectorContract {
  readonly root: readonly SelectorCandidate[];
  readonly fields: {
    readonly externalId: FieldSelector;
    readonly title: FieldSelector;
    readonly behavior?: FieldSelector;
    readonly modelAlias?: FieldSelector;
    readonly status?: FieldSelector;
  };
  readonly messages?: RepeatedFieldSelector;
  readonly judgeResults?: RepeatedFieldSelector;
}

export interface BlockerSelectorContract {
  readonly loginRequired: readonly SelectorCandidate[];
  readonly captcha: readonly SelectorCandidate[];
  readonly botChallenge: readonly SelectorCandidate[];
}

export interface GraySwanSelectorContract {
  readonly schemaVersion: 1;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly compatibility: {
    readonly status: 'fixture-baseline' | 'captured' | 'verified' | 'retired';
    readonly capturedAt: string | null;
    readonly pageBuild: string | null;
    readonly notes: string;
  };
  readonly index: IndexSelectorContract;
  readonly records: Readonly<Record<RecordKind, RecordSelectorContract>>;
  readonly blockers: BlockerSelectorContract;
}

export interface RawPageSnapshot {
  readonly url: string;
  readonly title: string;
  readonly html: string;
  readonly visibleText: string;
  readonly capturedAt: string;
  readonly responseStatus?: number;
}

export interface SelectorTrace {
  readonly field: string;
  readonly candidateId: string;
  readonly selector: string;
}

export interface ParseIssue {
  readonly code:
    | 'contract_invalid'
    | 'root_not_found'
    | 'field_missing'
    | 'field_invalid'
    | 'duplicate_id'
    | 'kind_unsupported'
    | 'expected_id_mismatch';
  readonly field?: string;
  readonly message: string;
}

export interface IndexRecordLink {
  readonly externalId: string;
  readonly kind: RecordKind;
  readonly href: string;
  readonly title: string;
  readonly updatedAt: string | null;
}

export interface ParsedIndex {
  readonly contractVersion: string;
  readonly records: readonly IndexRecordLink[];
  readonly trace: readonly SelectorTrace[];
}

export interface ArchivedMessage {
  readonly ordinal: number;
  readonly role: string;
  readonly body: string;
}

export interface ArchivedJudgeResult {
  readonly ordinal: number;
  readonly label: string;
  readonly score: string | null;
  readonly explanation: string | null;
}

export interface ParsedGraySwanRecord {
  readonly platform: 'gray-swan';
  readonly kind: RecordKind;
  readonly externalId: string;
  readonly title: string;
  readonly behavior: string | null;
  readonly modelAlias: string | null;
  readonly status: string | null;
  readonly messages: readonly ArchivedMessage[];
  readonly judgeResults: readonly ArchivedJudgeResult[];
  readonly sourceUrl: string;
  readonly capturedAt: string;
  readonly parserVersion: string;
  readonly selectorContractVersion: string;
  readonly dataPolicy: 'local_only';
  readonly trace: readonly SelectorTrace[];
}

export type ParseResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly warnings: readonly ParseIssue[];
    }
  | { readonly ok: false; readonly issues: readonly ParseIssue[] };

export type BlockingCondition =
  | 'login_required'
  | 'captcha'
  | 'bot_challenge'
  | 'http_403'
  | 'http_429';
