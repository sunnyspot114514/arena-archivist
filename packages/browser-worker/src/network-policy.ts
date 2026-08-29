import type { NetworkPolicyDecision, RequestDescriptor } from './types.js';

export interface CollectNetworkPolicyConfig {
  readonly primaryOrigin: string;
  readonly staticOrigins?: readonly string[];
  readonly readOnlyGraphqlEndpoints?: readonly string[];
}

interface NormalizedPolicyConfig {
  readonly primaryOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly readOnlyGraphqlEndpoints: ReadonlySet<string>;
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new Error(
      `Collection origins must use HTTPS, received: ${url.protocol}`,
    );
  }
  if (url.username || url.password)
    throw new Error('Collection origins cannot contain credentials');
  return url.origin;
}

function normalizeConfig(
  config: CollectNetworkPolicyConfig,
): NormalizedPolicyConfig {
  const primaryOrigin = normalizeOrigin(config.primaryOrigin);
  const allowedOrigins = new Set([primaryOrigin]);
  for (const origin of config.staticOrigins ?? [])
    allowedOrigins.add(normalizeOrigin(origin));

  const readOnlyGraphqlEndpoints = new Set<string>();
  for (const endpoint of config.readOnlyGraphqlEndpoints ?? []) {
    const url = new URL(endpoint, primaryOrigin);
    if (url.origin !== primaryOrigin) {
      throw new Error(
        'Read-only GraphQL endpoints must use the primary origin',
      );
    }
    url.search = '';
    url.hash = '';
    readOnlyGraphqlEndpoints.add(url.href);
  }
  return { primaryOrigin, allowedOrigins, readOnlyGraphqlEndpoints };
}

function denial(
  request: RequestDescriptor,
  reason: Exclude<NetworkPolicyDecision, { allowed: true }>['reason'],
  origin: string | null,
): NetworkPolicyDecision {
  return {
    allowed: false,
    reason,
    method: request.method.toUpperCase(),
    origin,
    resourceType: request.resourceType,
  };
}

function graphqlDocumentIsReadOnly(document: string): boolean {
  const withoutComments = document.replace(/#[^\r\n]*/g, ' ').trimStart();
  if (!withoutComments) return false;

  // This deliberately rejects subscriptions and every document that contains a mutation
  // operation token. It can produce false denials, but never upgrades an unknown write to read.
  const tokens: string[] =
    withoutComments.match(/[_A-Za-z][_0-9A-Za-z]*|[{}]/g) ?? [];
  if (tokens.includes('mutation') || tokens.includes('subscription'))
    return false;
  return tokens[0] === '{' || tokens.includes('query');
}

function graphqlPayloadIsReadOnly(postData: string | null): boolean {
  if (!postData) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(postData);
  } catch {
    return false;
  }

  const operations = Array.isArray(payload) ? payload : [payload];
  if (operations.length === 0) return false;
  return operations.every((operation) => {
    if (typeof operation !== 'object' || operation === null) return false;
    const query = (operation as Record<string, unknown>).query;
    return typeof query === 'string' && graphqlDocumentIsReadOnly(query);
  });
}

function endpointKey(url: URL): string {
  const normalized = new URL(url.href);
  normalized.search = '';
  normalized.hash = '';
  return normalized.href;
}

function hasMethodOverride(request: RequestDescriptor, url: URL): boolean {
  const headers = new Map(
    Object.entries(request.headers ?? {}).map(([name, value]) => [
      name.toLowerCase(),
      value,
    ]),
  );
  return (
    headers.has('x-http-method-override') ||
    headers.has('x-method-override') ||
    headers.has('x-http-method') ||
    url.searchParams.has('_method') ||
    url.searchParams.has('httpMethod')
  );
}

function hasMutationShapedPath(url: URL): boolean {
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return true;
  }
  return /(?:^|\/)(?:submit(?:-break)?|send|delete|remove|upload|update|save|logout|mutation)(?:\/|$)/iu.test(
    pathname,
  );
}

export class CollectNetworkPolicy {
  private readonly config: NormalizedPolicyConfig;

  constructor(config: CollectNetworkPolicyConfig) {
    this.config = normalizeConfig(config);
  }

  get primaryOrigin(): string {
    return this.config.primaryOrigin;
  }

  decide(request: RequestDescriptor): NetworkPolicyDecision {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return denial(request, 'invalid_url', null);
    }

    if (url.protocol !== 'https:') {
      return denial(
        request,
        'insecure_scheme',
        url.origin === 'null' ? null : url.origin,
      );
    }
    if (url.username || url.password)
      return denial(request, 'invalid_url', url.origin);
    if (!this.config.allowedOrigins.has(url.origin)) {
      return denial(request, 'origin_denied', url.origin);
    }
    if (
      request.resourceType === 'document' &&
      url.origin !== this.config.primaryOrigin
    ) {
      return denial(request, 'cross_origin_document', url.origin);
    }

    const method = request.method.toUpperCase();
    if (hasMethodOverride(request, url) || hasMutationShapedPath(url)) {
      return denial(request, 'method_denied', url.origin);
    }
    const isGraphqlEndpoint = this.config.readOnlyGraphqlEndpoints.has(
      endpointKey(url),
    );
    if (method === 'GET' && isGraphqlEndpoint) {
      const query = url.searchParams.get('query');
      if (!query || !graphqlDocumentIsReadOnly(query)) {
        return denial(request, 'graphql_operation_denied', url.origin);
      }
      return { allowed: true, reason: 'read_only_graphql' };
    }
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return { allowed: true, reason: 'read_only_request' };
    }
    if (method !== 'POST') return denial(request, 'method_denied', url.origin);
    if (!isGraphqlEndpoint) {
      return denial(request, 'graphql_endpoint_denied', url.origin);
    }
    if (!graphqlPayloadIsReadOnly(request.postData)) {
      return denial(request, 'graphql_operation_denied', url.origin);
    }
    return { allowed: true, reason: 'read_only_graphql' };
  }
}
