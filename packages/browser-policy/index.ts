import { randomUUID } from 'node:crypto';

export type BrowserMode = 'AUTH_MODE' | 'COLLECT_MODE';
export type BrowserActor = 'worker' | 'human';
export type PolicyLayer = 'semantic' | 'dom' | 'network';

export const allowedSemanticActions = Object.freeze([
  'open_previous_chats',
  'open_submissions',
  'open_profile',
  'read_visible_record',
  'navigate_pagination',
  'save_local_copy',
] as const);

export type AllowedSemanticAction = (typeof allowedSemanticActions)[number];

export interface PolicyDecision {
  id: string;
  occurredAt: string;
  layer: PolicyLayer;
  mode: BrowserMode;
  allowed: boolean;
  reasonCode: string;
  reason: string;
  action: string;
  origin: string | null;
  metadata: Record<string, string | number | boolean | null>;
}

export interface PolicyAuditSink {
  write(decision: PolicyDecision): void;
}

export class MemoryPolicyAuditSink implements PolicyAuditSink {
  readonly decisions: PolicyDecision[] = [];

  write(decision: PolicyDecision): void {
    this.decisions.push(structuredClone(decision));
  }
}

export class PolicyDeniedError extends Error {
  readonly code = 'BROWSER_POLICY_DENIED';
  readonly decision: PolicyDecision;

  constructor(decision: PolicyDecision) {
    super(
      `${decision.layer} policy denied ${JSON.stringify(decision.action)}: ${decision.reason}`,
    );
    this.name = 'PolicyDeniedError';
    this.decision = decision;
  }
}

export interface SemanticActionRequest {
  action: string;
  actor?: BrowserActor;
}

export type DomAction =
  | 'navigate'
  | 'click'
  | 'read'
  | 'snapshot'
  | 'fill'
  | 'press'
  | 'upload'
  | 'evaluate'
  | 'download'
  | 'new_tab';

export interface DomTarget {
  tagName?: string;
  role?: string;
  accessibleName?: string;
  inputType?: string;
  href?: string;
}

export interface DomActionRequest {
  action: string;
  actor?: BrowserActor;
  pageUrl: string;
  intent?: string;
  target?: DomTarget;
  key?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  actor?: BrowserActor;
  resourceType?: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface EndpointRule {
  origin: string;
  pathname: string;
}

export interface BrowserPolicyConfig {
  mode?: BrowserMode;
  collectOrigins?: string[];
  staticOrigins?: string[];
  authOrigins?: string[];
  graphQlEndpoints?: EndpointRule[];
  readOnlyPostEndpoints?: EndpointRule[];
  allowedPersistedQueryHashes?: string[];
  auditSink?: PolicyAuditSink;
  now?: () => Date;
}

interface NormalizedEndpointRule {
  origin: string;
  pathname: string;
}

const SAFE_INTENTS: ReadonlySet<string> = new Set(allowedSemanticActions);
const DOM_NAVIGATION_INTENTS: ReadonlySet<string> = new Set([
  'open_previous_chats',
  'open_submissions',
  'open_profile',
  'read_visible_record',
  'navigate_pagination',
]);
const DANGEROUS_LABEL =
  /(?:\bsend\b|\bsubmit(?:\s+break)?\b|\bdelete\b|\bupload\b|\bsave\s+(?:changes|profile)\b|\bupdate\s+(?:account|profile|settings)\b|\bnew\s+chat\b|发送|提交|删除|上传|保存|修改(?:账户|账号|资料|设置))/iu;
const INPUT_TAGS: ReadonlySet<string> = new Set([
  'input',
  'textarea',
  'select',
  'option',
]);
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
const WRITE_METHODS: ReadonlySet<string> = new Set([
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
]);

function exactOrigin(value: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError(`${label} contains an invalid URL origin.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.origin === 'null'
  ) {
    throw new TypeError(
      `${label} must contain exact credential-free HTTPS origins.`,
    );
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError(`${label} entries must be origins, not paths.`);
  }
  return parsed.origin;
}

function normalizeRule(
  rule: EndpointRule,
  label: string,
): NormalizedEndpointRule {
  const origin = exactOrigin(rule.origin, `${label}.origin`);
  if (
    !rule.pathname.startsWith('/') ||
    rule.pathname.includes('?') ||
    rule.pathname.includes('#')
  ) {
    throw new TypeError(
      `${label}.pathname must be an exact absolute pathname.`,
    );
  }
  return { origin, pathname: rule.pathname };
}

function parseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.origin === 'null'
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function endpointMatches(
  url: URL,
  rules: readonly NormalizedEndpointRule[],
): boolean {
  let decodedPathname = url.pathname;
  try {
    decodedPathname = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  return rules.some(
    (rule) =>
      rule.origin === url.origin &&
      (rule.pathname === url.pathname || rule.pathname === decodedPathname),
  );
}

function normalizeHeaders(
  headers: NetworkRequest['headers'],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value !== undefined) result.set(name.toLowerCase(), value);
  }
  return result;
}

function isUploadRequest(request: NetworkRequest): boolean {
  const headers = normalizeHeaders(request.headers);
  const contentType = headers.get('content-type')?.toLowerCase() ?? '';
  const resourceType = request.resourceType?.toLowerCase() ?? '';
  return (
    contentType.includes('multipart/form-data') ||
    contentType.includes('application/octet-stream') ||
    resourceType === 'upload'
  );
}

function hasMethodOverride(url: URL, headers: Map<string, string>): boolean {
  const headerOverride =
    headers.get('x-http-method-override') ??
    headers.get('x-method-override') ??
    headers.get('x-http-method');
  if (headerOverride) return true;
  return url.searchParams.has('_method') || url.searchParams.has('httpMethod');
}

function hasMutationShapedPath(url: URL): boolean {
  let pathname = url.pathname;
  try {
    pathname = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return /(?:^|\/)(?:submit(?:-break)?|send|delete|remove|upload|update|save|logout|mutation)(?:\/|$)/iu.test(
    pathname,
  );
}

function bodyAsJson(body: unknown): unknown {
  if (body instanceof Uint8Array) {
    try {
      return JSON.parse(new TextDecoder().decode(body)) as unknown;
    } catch {
      return null;
    }
  }
  if (typeof body === 'string') {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
  return body;
}

function stripGraphQlStringsAndComments(document: string): string | null {
  let output = '';
  for (let index = 0; index < document.length; index += 1) {
    const character = document[index];
    if (character === '#') {
      while (
        index < document.length &&
        document[index] !== '\n' &&
        document[index] !== '\r'
      ) {
        output += ' ';
        index += 1;
      }
      output += document[index] ?? '';
      continue;
    }
    if (character !== '"') {
      output += character;
      continue;
    }

    const block = document.slice(index, index + 3) === '"""';
    output += block ? '   ' : ' ';
    index += block ? 3 : 1;
    let closed = false;
    for (; index < document.length; index += 1) {
      if (block && document.slice(index, index + 3) === '"""') {
        output += '   ';
        index += 2;
        closed = true;
        break;
      }
      if (!block && document[index] === '"') {
        output += ' ';
        closed = true;
        break;
      }
      if (!block && document[index] === '\\') {
        output += ' ';
        index += 1;
        if (index < document.length) output += ' ';
        continue;
      }
      output +=
        document[index] === '\n' || document[index] === '\r'
          ? document[index]
          : ' ';
    }
    if (!closed) return null;
  }
  return output;
}

interface GraphQlInspection {
  allowed: boolean;
  reasonCode: string;
  reason: string;
  operationCount: number;
}

function inspectGraphQlDocument(document: string): GraphQlInspection {
  if (!document.trim() || document.length > 2_000_000) {
    return {
      allowed: false,
      reasonCode: 'GRAPHQL_QUERY_INVALID',
      reason: 'GraphQL request is empty or exceeds the inspection limit.',
      operationCount: 0,
    };
  }
  const stripped = stripGraphQlStringsAndComments(document);
  if (stripped === null) {
    return {
      allowed: false,
      reasonCode: 'GRAPHQL_QUERY_INVALID',
      reason: 'GraphQL request contains an unterminated string.',
      operationCount: 0,
    };
  }

  const tokenPattern = /[_A-Za-z][_0-9A-Za-z]*|[{}]/g;
  let depth = 0;
  let operationCount = 0;
  let hasQuery = false;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(stripped)) !== null) {
    const token = match[0];
    if (token === '{') {
      if (depth === 0) {
        const prefix = stripped.slice(0, match.index).trim();
        if (!prefix) {
          operationCount += 1;
          hasQuery = true;
        }
      }
      depth += 1;
      continue;
    }
    if (token === '}') {
      depth -= 1;
      if (depth < 0) {
        return {
          allowed: false,
          reasonCode: 'GRAPHQL_QUERY_INVALID',
          reason: 'GraphQL request has unbalanced braces.',
          operationCount,
        };
      }
      continue;
    }
    if (depth !== 0) continue;
    if (token === 'mutation' || token === 'subscription') {
      return {
        allowed: false,
        reasonCode:
          token === 'mutation' ? 'GRAPHQL_MUTATION' : 'GRAPHQL_SUBSCRIPTION',
        reason: `GraphQL ${token} operations are not read-only.`,
        operationCount: operationCount + 1,
      };
    }
    if (token === 'query') {
      operationCount += 1;
      hasQuery = true;
    }
  }
  if (depth !== 0 || !hasQuery) {
    return {
      allowed: false,
      reasonCode: 'GRAPHQL_QUERY_UNPROVEN',
      reason:
        'The request could not be proven to contain a read-only GraphQL query.',
      operationCount,
    };
  }
  return {
    allowed: true,
    reasonCode: 'GRAPHQL_QUERY',
    reason: 'GraphQL document contains only read-only query operations.',
    operationCount,
  };
}

function persistedHash(payload: Record<string, unknown>): string | null {
  const extensions = payload.extensions;
  if (
    !extensions ||
    typeof extensions !== 'object' ||
    Array.isArray(extensions)
  )
    return null;
  const persisted = (extensions as Record<string, unknown>).persistedQuery;
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted))
    return null;
  const hash = (persisted as Record<string, unknown>).sha256Hash;
  return typeof hash === 'string' ? hash.toLowerCase() : null;
}

function inspectGraphQlPayload(
  payload: unknown,
  allowedPersistedHashes: ReadonlySet<string>,
): GraphQlInspection {
  if (Array.isArray(payload)) {
    if (payload.length === 0 || payload.length > 50) {
      return {
        allowed: false,
        reasonCode: 'GRAPHQL_BATCH_INVALID',
        reason: 'GraphQL batch is empty or exceeds the inspection limit.',
        operationCount: 0,
      };
    }
    let operations = 0;
    for (const item of payload) {
      const inspection = inspectGraphQlPayload(item, allowedPersistedHashes);
      if (!inspection.allowed) return inspection;
      operations += inspection.operationCount;
    }
    return {
      allowed: true,
      reasonCode: 'GRAPHQL_QUERY_BATCH',
      reason: 'Every GraphQL batch item is a proven read-only query.',
      operationCount: operations,
    };
  }
  if (!payload || typeof payload !== 'object') {
    return {
      allowed: false,
      reasonCode: 'GRAPHQL_BODY_INVALID',
      reason: 'GraphQL request body is not a JSON object.',
      operationCount: 0,
    };
  }
  const object = payload as Record<string, unknown>;
  if (typeof object.query === 'string')
    return inspectGraphQlDocument(object.query);
  const hash = persistedHash(object);
  if (hash && allowedPersistedHashes.has(hash)) {
    return {
      allowed: true,
      reasonCode: 'GRAPHQL_PERSISTED_QUERY',
      reason: 'Persisted GraphQL query hash is explicitly allowlisted.',
      operationCount: 1,
    };
  }
  return {
    allowed: false,
    reasonCode: 'GRAPHQL_PERSISTED_QUERY_UNKNOWN',
    reason:
      'A persisted GraphQL operation is not on the read-only hash allowlist.',
    operationCount: 0,
  };
}

function graphQlGetPayload(url: URL): unknown {
  const query = url.searchParams.get('query');
  if (query !== null) return { query };
  const extensions = url.searchParams.get('extensions');
  if (extensions !== null) {
    try {
      return { extensions: JSON.parse(extensions) as unknown };
    } catch {
      return null;
    }
  }
  return null;
}

export class BrowserGuardian {
  private modeValue: BrowserMode;
  private readonly collectOrigins: ReadonlySet<string>;
  private readonly staticOrigins: ReadonlySet<string>;
  private readonly authOrigins: ReadonlySet<string>;
  private readonly graphQlEndpoints: readonly NormalizedEndpointRule[];
  private readonly readOnlyPostEndpoints: readonly NormalizedEndpointRule[];
  private readonly allowedPersistedHashes: ReadonlySet<string>;
  private readonly auditSink: PolicyAuditSink;
  private readonly now: () => Date;

  constructor(config: BrowserPolicyConfig = {}) {
    this.modeValue = config.mode ?? 'COLLECT_MODE';
    if (this.modeValue !== 'AUTH_MODE' && this.modeValue !== 'COLLECT_MODE') {
      throw new TypeError('Browser policy mode is invalid.');
    }
    const collect = config.collectOrigins ?? ['https://app.grayswan.ai'];
    this.collectOrigins = new Set(
      collect.map((origin) => exactOrigin(origin, 'collectOrigins')),
    );
    if (this.collectOrigins.size === 0)
      throw new TypeError('At least one collection origin is required.');
    this.staticOrigins = new Set(
      (config.staticOrigins ?? []).map((origin) =>
        exactOrigin(origin, 'staticOrigins'),
      ),
    );
    this.authOrigins = new Set(
      (config.authOrigins ?? collect).map((origin) =>
        exactOrigin(origin, 'authOrigins'),
      ),
    );
    this.graphQlEndpoints = (config.graphQlEndpoints ?? []).map((rule) =>
      normalizeRule(rule, 'graphQlEndpoints'),
    );
    this.readOnlyPostEndpoints = (config.readOnlyPostEndpoints ?? []).map(
      (rule) => normalizeRule(rule, 'readOnlyPostEndpoints'),
    );
    this.allowedPersistedHashes = new Set(
      (config.allowedPersistedQueryHashes ?? []).map((hash) => {
        const normalized = hash.toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(normalized)) {
          throw new TypeError(
            'Persisted GraphQL hashes must be 64 hexadecimal characters.',
          );
        }
        return normalized;
      }),
    );
    this.auditSink = config.auditSink ?? new MemoryPolicyAuditSink();
    this.now = config.now ?? (() => new Date());
  }

  get mode(): BrowserMode {
    return this.modeValue;
  }

  setMode(mode: BrowserMode): void {
    if (mode !== 'AUTH_MODE' && mode !== 'COLLECT_MODE')
      throw new TypeError('Browser mode is invalid.');
    this.modeValue = mode;
  }

  evaluateSemantic(request: SemanticActionRequest): PolicyDecision {
    const actor = request.actor ?? 'worker';
    if (actor !== 'worker') {
      return this.decision(
        'semantic',
        false,
        'WORKER_ACTION_REQUIRED',
        'Semantic tools are worker-only.',
        request.action,
      );
    }
    if (this.modeValue === 'AUTH_MODE') {
      return this.decision(
        'semantic',
        false,
        'HUMAN_AUTH_ONLY',
        'No automated semantic action is allowed during human authentication.',
        request.action,
      );
    }
    if (!SAFE_INTENTS.has(request.action)) {
      return this.decision(
        'semantic',
        false,
        'SEMANTIC_ACTION_NOT_ALLOWLISTED',
        'The semantic action is not on the read-only allowlist.',
        request.action,
      );
    }
    return this.decision(
      'semantic',
      true,
      'SEMANTIC_READ_ONLY',
      'The semantic action is explicitly allowlisted as read-only.',
      request.action,
    );
  }

  assertSemantic(request: SemanticActionRequest): PolicyDecision {
    return this.assertAllowed(this.evaluateSemantic(request));
  }

  evaluateDom(request: DomActionRequest): PolicyDecision {
    const actor = request.actor ?? 'worker';
    const page = parseUrl(request.pageUrl);
    if (!page) {
      return this.decision(
        'dom',
        false,
        'INVALID_PAGE_URL',
        'The page URL is not valid HTTPS.',
        request.action,
      );
    }

    if (this.modeValue === 'AUTH_MODE') {
      if (actor !== 'human') {
        return this.decision(
          'dom',
          false,
          'HUMAN_AUTH_ONLY',
          'Only explicitly human-initiated browser actions are allowed in AUTH_MODE.',
          request.action,
          page.origin,
        );
      }
      if (!this.authOrigins.has(page.origin)) {
        return this.decision(
          'dom',
          false,
          'AUTH_ORIGIN_DENIED',
          'The authentication page origin is not explicitly allowlisted.',
          request.action,
          page.origin,
        );
      }
      if (
        request.action === 'evaluate' ||
        request.action === 'upload' ||
        request.action === 'download'
      ) {
        return this.decision(
          'dom',
          false,
          'AUTH_CAPABILITY_DENIED',
          'Script evaluation, file upload, and download are unavailable in the authentication surface.',
          request.action,
          page.origin,
        );
      }
      return this.decision(
        'dom',
        true,
        'HUMAN_AUTH_ACTION',
        'The action is human-initiated on an explicit authentication origin.',
        request.action,
        page.origin,
      );
    }

    if (actor !== 'worker') {
      return this.decision(
        'dom',
        false,
        'COLLECT_WORKER_ONLY',
        'COLLECT_MODE accepts only policy-bound worker actions.',
        request.action,
        page.origin,
      );
    }
    if (!this.collectOrigins.has(page.origin)) {
      return this.decision(
        'dom',
        false,
        'COLLECT_ORIGIN_DENIED',
        'DOM access is outside the collection origin allowlist.',
        request.action,
        page.origin,
      );
    }
    if (request.action === 'read' || request.action === 'snapshot') {
      return this.decision(
        'dom',
        true,
        'DOM_READ_ONLY',
        'Reading the current allowlisted page does not mutate remote state.',
        request.action,
        page.origin,
      );
    }
    if (request.action !== 'navigate' && request.action !== 'click') {
      const enterSuffix =
        request.action === 'press' && request.key?.toLowerCase() === 'enter'
          ? ' Enter may trigger a submission.'
          : '';
      return this.decision(
        'dom',
        false,
        'DOM_MUTATION_CAPABILITY_DENIED',
        `Fill, key press, upload, evaluation, downloads, new tabs, and other raw capabilities are unavailable.${enterSuffix}`,
        request.action,
        page.origin,
      );
    }
    if (!request.intent || !DOM_NAVIGATION_INTENTS.has(request.intent)) {
      return this.decision(
        'dom',
        false,
        'DOM_INTENT_NOT_ALLOWLISTED',
        'Navigation and clicks require an explicit read-only semantic intent.',
        request.action,
        page.origin,
      );
    }
    const target = request.target;
    if (
      request.action === 'click' &&
      (!target ||
        (!target.accessibleName?.trim() &&
          !target.href &&
          !target.role &&
          !target.tagName))
    ) {
      return this.decision(
        'dom',
        false,
        'DOM_TARGET_UNPROVEN',
        'A click target must expose enough DOM or accessibility metadata to prove it is read-only.',
        request.action,
        page.origin,
      );
    }
    const tag = target?.tagName?.toLowerCase();
    const role = target?.role?.toLowerCase();
    const label = target?.accessibleName ?? '';
    if (
      (tag && INPUT_TAGS.has(tag)) ||
      role === 'textbox' ||
      role === 'combobox' ||
      role === 'spinbutton' ||
      DANGEROUS_LABEL.test(label)
    ) {
      return this.decision(
        'dom',
        false,
        'DOM_DANGEROUS_TARGET',
        'The target is writable or has a submission/account-mutation label.',
        request.action,
        page.origin,
      );
    }
    if (target?.href) {
      const destination = parseUrl(target.href);
      if (!destination || !this.collectOrigins.has(destination.origin)) {
        return this.decision(
          'dom',
          false,
          'DOM_DESTINATION_DENIED',
          'The target destination leaves the collection origin allowlist.',
          request.action,
          destination?.origin ?? null,
        );
      }
    }
    return this.decision(
      'dom',
      true,
      'DOM_READ_NAVIGATION',
      'The target and semantic intent are both explicitly read-only.',
      request.action,
      page.origin,
      { intent: request.intent },
    );
  }

  assertDom(request: DomActionRequest): PolicyDecision {
    return this.assertAllowed(this.evaluateDom(request));
  }

  evaluateNetwork(request: NetworkRequest): PolicyDecision {
    const actor = request.actor ?? 'worker';
    const url = parseUrl(request.url);
    const method =
      typeof request.method === 'string'
        ? request.method.toUpperCase().trim()
        : '';
    if (!url || !method) {
      return this.decision(
        'network',
        false,
        'INVALID_NETWORK_REQUEST',
        'Network URL or method is invalid.',
        method || 'UNKNOWN',
      );
    }

    if (this.modeValue === 'AUTH_MODE') {
      if (actor !== 'human') {
        return this.decision(
          'network',
          false,
          'HUMAN_AUTH_ONLY',
          'Automated network activity is unavailable during authentication.',
          method,
          url.origin,
        );
      }
      if (!this.authOrigins.has(url.origin)) {
        return this.decision(
          'network',
          false,
          'AUTH_ORIGIN_DENIED',
          'Authentication traffic left the explicit auth-origin allowlist.',
          method,
          url.origin,
        );
      }
      return this.decision(
        'network',
        true,
        'HUMAN_AUTH_NETWORK',
        'Human-initiated authentication traffic is allowed on an explicit origin.',
        method,
        url.origin,
      );
    }

    if (actor !== 'worker') {
      return this.decision(
        'network',
        false,
        'COLLECT_WORKER_ONLY',
        'COLLECT_MODE accepts only policy-bound worker traffic.',
        method,
        url.origin,
      );
    }
    const originAllowed =
      this.collectOrigins.has(url.origin) || this.staticOrigins.has(url.origin);
    if (!originAllowed) {
      return this.decision(
        'network',
        false,
        'NETWORK_ORIGIN_DENIED',
        'Network origin is not needed for collection or static assets.',
        method,
        url.origin,
      );
    }
    if (isUploadRequest(request)) {
      return this.decision(
        'network',
        false,
        'UPLOAD_DENIED',
        'Upload-shaped network requests are always denied.',
        method,
        url.origin,
      );
    }
    const headers = normalizeHeaders(request.headers);
    if (hasMethodOverride(url, headers)) {
      return this.decision(
        'network',
        false,
        'HTTP_METHOD_OVERRIDE_DENIED',
        'HTTP method tunneling cannot be proven read-only.',
        method,
        url.origin,
      );
    }
    if (hasMutationShapedPath(url)) {
      return this.decision(
        'network',
        false,
        'MUTATION_PATH_DENIED',
        'The request pathname names a remote mutation capability.',
        method,
        url.origin,
      );
    }

    const graphQl = endpointMatches(url, this.graphQlEndpoints);
    const graphQlShapedGet =
      method === 'GET' &&
      (url.searchParams.has('query') || url.searchParams.has('extensions'));
    if (
      (graphQl || graphQlShapedGet) &&
      (method === 'GET' || method === 'POST')
    ) {
      const payload =
        method === 'GET' ? graphQlGetPayload(url) : bodyAsJson(request.body);
      const inspection = inspectGraphQlPayload(
        payload,
        this.allowedPersistedHashes,
      );
      return this.decision(
        'network',
        inspection.allowed,
        inspection.reasonCode,
        inspection.reason,
        method,
        url.origin,
        { graphQlOperations: inspection.operationCount },
      );
    }

    if (SAFE_METHODS.has(method)) {
      return this.decision(
        'network',
        true,
        'SAFE_HTTP_METHOD',
        'The request uses a read-only HTTP method on an allowlisted origin.',
        method,
        url.origin,
      );
    }
    if (method === 'POST' && endpointMatches(url, this.readOnlyPostEndpoints)) {
      return this.decision(
        'network',
        true,
        'KNOWN_READ_ONLY_POST',
        'The exact POST endpoint is explicitly registered as read-only.',
        method,
        url.origin,
      );
    }
    if (WRITE_METHODS.has(method)) {
      return this.decision(
        'network',
        false,
        'NETWORK_MUTATION_DENIED',
        'Unknown or mutating HTTP endpoints are denied in COLLECT_MODE.',
        method,
        url.origin,
      );
    }
    return this.decision(
      'network',
      false,
      'HTTP_METHOD_UNKNOWN',
      'The HTTP method is not proven read-only.',
      method,
      url.origin,
    );
  }

  assertNetwork(request: NetworkRequest): PolicyDecision {
    return this.assertAllowed(this.evaluateNetwork(request));
  }

  private assertAllowed(decision: PolicyDecision): PolicyDecision {
    if (!decision.allowed) throw new PolicyDeniedError(decision);
    return decision;
  }

  private decision(
    layer: PolicyLayer,
    allowed: boolean,
    reasonCode: string,
    reason: string,
    action: string,
    origin: string | null = null,
    metadata: Record<string, string | number | boolean | null> = {},
  ): PolicyDecision {
    let occurredAt: string;
    try {
      occurredAt = this.now().toISOString();
    } catch {
      allowed = false;
      reasonCode = 'POLICY_CLOCK_FAILED';
      reason = 'Policy clock failed; the action was denied.';
      occurredAt = new Date(0).toISOString();
    }
    const decision: PolicyDecision = {
      id: `policy_${randomUUID()}`,
      occurredAt,
      layer,
      mode: this.modeValue,
      allowed,
      reasonCode,
      reason,
      action,
      origin,
      metadata,
    };
    try {
      this.auditSink.write(decision);
      return decision;
    } catch {
      // Audit durability is part of authorization. If an allowed decision cannot be
      // audited, turn it into a denial and do not expose request bodies or DOM values.
      return {
        ...decision,
        allowed: false,
        reasonCode: 'POLICY_AUDIT_FAILED',
        reason: 'Policy audit could not be persisted; the action was denied.',
        metadata: {},
      };
    }
  }
}

export function toArchivePolicyDecision(decision: PolicyDecision): {
  id: string;
  occurredAt: string;
  layer: string;
  mode: string;
  allowed: boolean;
  reason: string;
  action: string;
  origin?: string;
  metadata: Record<string, string | number | boolean | null>;
} {
  return {
    id: decision.id,
    occurredAt: decision.occurredAt,
    layer: decision.layer,
    mode: decision.mode,
    allowed: decision.allowed,
    reason: `${decision.reasonCode}: ${decision.reason}`,
    action: decision.action,
    ...(decision.origin ? { origin: decision.origin } : {}),
    metadata: decision.metadata,
  };
}

export const browserPolicyDefaults = Object.freeze({
  mode: 'COLLECT_MODE' as const,
  collectOrigins: ['https://app.grayswan.ai'] as const,
  maxTabs: 1,
  concurrency: 1,
});
