import type {
  AuthBroker,
  CredentialExecutor,
  OpaqueCredentialHandle,
} from '../../auth-broker/src/index';
import {
  isLocallyGeneratedAuthorizedProjection,
  projectionMessages,
  type AuthorizedModelProjection,
  type ProjectionRecordPolicy,
} from './projection.js';

export * from './projection.js';

export type DataPolicy =
  | 'local_only'
  | 'direct_provider_only'
  | 'zdr_router_allowed'
  | 'public';

export type ModelTask =
  | 'parser_repair'
  | 'offline_review'
  | 'embeddings'
  | 'sampled_cross_check';

export type ProviderRoute = {
  id: string;
  provider: string;
  kind: 'direct' | 'router';
  baseUrl: string;
  model: string;
  connectionId: string;
  allowedTasks: readonly ModelTask[];
  zeroDataRetention: boolean;
  promptLogging: boolean;
  enabled: boolean;
  additionalHeaders?: Readonly<Record<string, string>>;
  additionalBody?: Readonly<Record<string, unknown>>;
};

export type RecordPolicy = ProjectionRecordPolicy;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type CompletionRequest = {
  task: ModelTask;
  routeId: string;
  /** Only a locally generated, hash-verified projection may reach a provider. */
  projection: AuthorizedModelProjection;
  temperature?: number;
  maxTokens?: number;
  responseFormat?: 'text' | 'json_object';
};

export type CompletionResult = {
  routeId: string;
  provider: string;
  model: string;
  content: string;
  requestId: string | null;
};

export type RouteDecision =
  | { allowed: true; reason: 'policy_allowed' }
  | { allowed: false; reason: string };

export function authorizeRoute(
  route: ProviderRoute,
  request: Pick<CompletionRequest, 'task' | 'projection'>,
  now = new Date(),
): RouteDecision {
  if (!route.enabled) {
    return { allowed: false, reason: 'route_disabled' };
  }
  if (!route.allowedTasks.includes(request.task)) {
    return { allowed: false, reason: 'task_not_allowed_on_route' };
  }
  if (!isLocallyGeneratedAuthorizedProjection(request.projection)) {
    return { allowed: false, reason: 'projection_not_locally_authorized' };
  }
  const recordPolicy = request.projection.authorization.policy;
  if (
    !new Set<DataPolicy>([
      'local_only',
      'direct_provider_only',
      'zdr_router_allowed',
      'public',
    ]).has(recordPolicy.level)
  ) {
    return { allowed: false, reason: 'unknown_record_policy' };
  }
  if (recordPolicy.level === 'local_only') {
    return { allowed: false, reason: 'record_is_local_only' };
  }
  if (!recordPolicy.externalProcessingAllowed) {
    return { allowed: false, reason: 'external_processing_not_allowed' };
  }
  if (recordPolicy.embargoUntil) {
    const embargo = new Date(recordPolicy.embargoUntil);
    if (!Number.isFinite(embargo.getTime()) || embargo > now) {
      return { allowed: false, reason: 'record_embargo_active' };
    }
  }
  if (
    recordPolicy.level === 'direct_provider_only' &&
    route.kind !== 'direct'
  ) {
    return { allowed: false, reason: 'router_disallowed_by_record_policy' };
  }
  if (route.kind === 'router') {
    if (
      recordPolicy.level !== 'zdr_router_allowed' &&
      recordPolicy.level !== 'public'
    ) {
      return { allowed: false, reason: 'router_disallowed_by_record_policy' };
    }
    if (!route.zeroDataRetention || route.promptLogging) {
      return { allowed: false, reason: 'router_privacy_requirements_not_met' };
    }
  }

  return { allowed: true, reason: 'policy_allowed' };
}

type OpenAiCompatibleResponse = {
  id?: string;
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function frozenJsonRecord(
  value: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('Model route additional body must be JSON serializable');
  }
  const clone: unknown = JSON.parse(serialized);
  if (!clone || Array.isArray(clone) || typeof clone !== 'object') {
    throw new Error('Model route additional body must be a JSON object');
  }
  return deepFreeze(clone as Record<string, unknown>);
}

function snapshotRoute(route: ProviderRoute): ProviderRoute {
  const {
    id,
    provider,
    kind,
    baseUrl,
    model,
    connectionId,
    allowedTasks,
    zeroDataRetention,
    promptLogging,
    enabled,
    additionalHeaders,
    additionalBody,
  } = route;
  return Object.freeze({
    id,
    provider,
    kind,
    baseUrl,
    model,
    connectionId,
    allowedTasks: Object.freeze([...allowedTasks]),
    zeroDataRetention,
    promptLogging,
    enabled,
    ...(additionalHeaders === undefined
      ? {}
      : { additionalHeaders: Object.freeze({ ...additionalHeaders }) }),
    ...(additionalBody === undefined
      ? {}
      : { additionalBody: frozenJsonRecord(additionalBody) }),
  });
}

export class ModelRouter {
  readonly #routes: ReadonlyMap<string, ProviderRoute>;
  readonly #auth: AuthBroker & CredentialExecutor;
  readonly #fetch: typeof fetch;

  constructor(options: {
    routes: readonly ProviderRoute[];
    auth: AuthBroker & CredentialExecutor;
    fetchImpl?: typeof fetch;
  }) {
    const protectedBodyKeys = new Set([
      'model',
      'messages',
      'temperature',
      'max_tokens',
      'response_format',
    ]);
    const routes = options.routes.map(snapshotRoute);
    const routeIds = new Set<string>();
    for (const route of routes) {
      if (routeIds.has(route.id)) {
        throw new Error(`Duplicate model route: ${route.id}`);
      }
      routeIds.add(route.id);
      for (const key of Object.keys(route.additionalBody ?? {})) {
        if (protectedBodyKeys.has(key)) {
          throw new Error(
            `Model route ${route.id} cannot override protected body field: ${key}`,
          );
        }
      }
      for (const key of Object.keys(route.additionalHeaders ?? {})) {
        if (['authorization', 'content-type'].includes(key.toLowerCase())) {
          throw new Error(
            `Model route ${route.id} cannot override protected header: ${key}`,
          );
        }
      }
    }
    this.#routes = new Map(routes.map((route) => [route.id, route]));
    this.#auth = options.auth;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  listRoutes(): Array<Omit<ProviderRoute, 'additionalHeaders'>> {
    return [...this.#routes.values()].map(
      ({ additionalHeaders: _headers, ...route }) => route,
    );
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const {
      task,
      routeId,
      projection,
      temperature,
      maxTokens,
      responseFormat,
    } = request;
    const route = this.#routes.get(routeId);
    if (!route) {
      throw new Error(`Unknown model route: ${routeId}`);
    }

    const decision = authorizeRoute(route, { task, projection });
    if (!decision.allowed) {
      throw new Error(`Model route denied: ${decision.reason}`);
    }

    const handle: OpaqueCredentialHandle = await this.#auth.resolveCredential(
      route.connectionId,
    );

    return this.#auth.withCredential(handle, async (credential) => {
      const response = await this.#fetch(
        `${route.baseUrl.replace(/\/$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${credential}`,
            'content-type': 'application/json',
            ...route.additionalHeaders,
          },
          body: JSON.stringify({
            ...route.additionalBody,
            model: route.model,
            messages: projectionMessages(projection),
            temperature: temperature ?? 0,
            max_tokens: maxTokens,
            response_format:
              responseFormat === 'json_object'
                ? { type: 'json_object' }
                : undefined,
          }),
          signal: AbortSignal.timeout(60_000),
        },
      );

      const payload = (await response.json()) as OpenAiCompatibleResponse;
      if (!response.ok) {
        throw new Error(
          `Provider request failed (${response.status}): ${payload.error?.message ?? 'unknown error'}`,
        );
      }

      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('Provider returned no completion content');
      }

      return {
        routeId: route.id,
        provider: route.provider,
        model: route.model,
        content,
        requestId: payload.id ?? null,
      };
    });
  }
}

export function defaultProviderRoutes(): ProviderRoute[] {
  return [
    {
      id: 'deepseek-direct',
      provider: 'deepseek',
      kind: 'direct',
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      connectionId: 'deepseek',
      allowedTasks: ['parser_repair', 'offline_review'],
      zeroDataRetention: false,
      promptLogging: true,
      enabled: Boolean(process.env.DEEPSEEK_API_KEY),
    },
    {
      id: 'minimax-direct',
      provider: 'minimax',
      kind: 'direct',
      baseUrl: process.env.MINIMAX_BASE_URL ?? '',
      model: process.env.MINIMAX_MODEL ?? '',
      connectionId: 'minimax',
      allowedTasks: ['parser_repair', 'offline_review'],
      zeroDataRetention: false,
      promptLogging: true,
      enabled: Boolean(
        process.env.MINIMAX_API_KEY &&
        process.env.MINIMAX_BASE_URL &&
        process.env.MINIMAX_MODEL,
      ),
    },
    {
      id: 'nvidia-direct',
      provider: 'nvidia',
      kind: 'direct',
      baseUrl:
        process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
      model: process.env.NVIDIA_MODEL ?? '',
      connectionId: 'nvidia',
      allowedTasks: ['embeddings', 'parser_repair'],
      zeroDataRetention: false,
      promptLogging: true,
      enabled: Boolean(process.env.NVIDIA_API_KEY && process.env.NVIDIA_MODEL),
    },
    {
      id: 'openrouter-zdr',
      provider: 'openrouter',
      kind: 'router',
      baseUrl:
        process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
      model: process.env.OPENROUTER_MODEL ?? '',
      connectionId: 'openrouter',
      allowedTasks: ['sampled_cross_check'],
      zeroDataRetention: true,
      promptLogging: false,
      enabled: Boolean(
        process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_MODEL,
      ),
      additionalBody: { provider: { data_collection: 'deny' } },
    },
  ];
}
