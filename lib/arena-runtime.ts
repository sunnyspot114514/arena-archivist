export type ArenaRuntimeStatus = {
  service: { state: 'ready'; version: string; host: '127.0.0.1' };
  browser: {
    mode: 'PAUSED_HUMAN_AUTH' | 'AUTH_MODE' | 'COLLECT_MODE' | 'DEMO_MODE';
    session: 'unknown' | 'valid' | 'invalid';
    authBrowserOpen: boolean;
    authPageCount: number;
    liveCollectionEnabled: boolean;
    selectorContract: 'fixture-baseline' | 'verified' | 'missing';
    lastValidatedAt: string | null;
  };
  archive: {
    totalRecords: number;
    chats: number;
    submissions: number;
    annotations: number;
    lastCheckpoint: { scope: string; cursor: string; updatedAt: string } | null;
  };
  run: {
    id: string;
    actionId: string | null;
    actionPhase: string | null;
    connectorId: string | null;
    state: 'running' | 'completed' | 'stopped' | 'failed';
    source: 'demo' | 'live';
    requested: number;
    committed: number;
    skippedKnown: number;
    stopReason: string | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
  budget: {
    runsToday: number;
    maxRunsPerDay: number;
    maxRecordsPerRun: number;
    minIntervalSeconds: number;
    maxRunMinutes: number;
  };
  providers: Array<{
    id: string;
    status: 'connected' | 'disconnected';
    activeModel?: string | null;
  }>;
  connectors: Array<{
    id: string;
    displayName: string;
    version: string;
    readOnly: true;
    recordKinds: readonly string[];
    capabilities: readonly string[];
    cursorFormat: string;
  }>;
};

export type NvidiaProviderStatus = {
  id: 'nvidia';
  status: 'connected' | 'disconnected';
  activeModel: string | null;
  baseUrl: 'https://integrate.api.nvidia.com/v1';
  credentialSource: 'managed' | 'environment' | null;
  secretStorage: 'windows_dpapi' | 'memory' | 'environment';
  availableModels: string[];
};

export type ArchiveOffsetListItem = {
  id: string;
  kind: 'chat' | 'submission';
  externalId: string;
  platform: string;
  title: string | null;
  outcome: string | null;
  dataPolicy: string;
  updatedAt: string;
};

export type ArchiveQueryItem = {
  id: string;
  kind: 'chat' | 'submission';
  platform: string;
  title: string | null;
  outcome: string | null;
  dataPolicy: string;
  sourceHash: string;
  updatedAt: string;
};

export type ArchiveQueryPage = {
  items: ArchiveQueryItem[];
  nextCursor: string | null;
  queryHash: string;
  catalogGeneration: number;
};

export type PolicyEvent = {
  id: string;
  occurredAt: string;
  layer: string;
  mode: string;
  allowed: boolean;
  reason: string;
  action: string | null;
  origin: string | null;
};

const RUNTIME_BASE =
  process.env.NEXT_PUBLIC_ARENA_RUNTIME_URL ?? 'http://127.0.0.1:4317';

export class ArenaRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ArenaRuntimeError';
  }
}

export async function runtimeRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json');
  const response = await fetch(`${RUNTIME_BASE}${path}`, {
    ...init,
    headers,
  });
  const payload = (await response.json()) as T & {
    code?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new ArenaRuntimeError(
      payload.code ?? 'runtime_error',
      payload.message ?? '本地运行时请求失败',
    );
  }
  return payload;
}

export const arenaRuntime = {
  status: () => runtimeRequest<ArenaRuntimeStatus>('/v1/status'),
  openAuth: () =>
    runtimeRequest<{ status: string; pageCount: number }>('/v1/auth/open', {
      method: 'POST',
      body: '{}',
    }),
  validateSession: () =>
    runtimeRequest<{ session: 'valid' | 'invalid' }>('/v1/session/validate', {
      method: 'POST',
      body: '{}',
    }),
  sync: (maxRecords: number, source: 'demo' | 'live') =>
    runtimeRequest<{ run: ArenaRuntimeStatus['run'] }>('/v1/sync', {
      method: 'POST',
      body: JSON.stringify({ maxRecords, source }),
    }),
  pause: () =>
    runtimeRequest<{ status: string }>('/v1/pause', {
      method: 'POST',
      body: '{}',
    }),
  nvidiaStatus: () =>
    runtimeRequest<NvidiaProviderStatus>('/v1/providers/nvidia'),
  configureNvidia: (input: { apiKey?: string; model?: string }) =>
    runtimeRequest<NvidiaProviderStatus>('/v1/providers/nvidia/configure', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  refreshNvidiaModels: () =>
    runtimeRequest<NvidiaProviderStatus>(
      '/v1/providers/nvidia/models/refresh',
      { method: 'POST', body: '{}' },
    ),
  disconnectNvidia: () =>
    runtimeRequest<NvidiaProviderStatus>('/v1/providers/nvidia/disconnect', {
      method: 'POST',
      body: '{}',
    }),
  listRecords: (limit = 8) =>
    runtimeRequest<{ items: ArchiveOffsetListItem[]; total: number }>(
      `/v1/records?limit=${limit}&offset=0`,
    ),
  queryRecords: (
    input: {
      limit?: number;
      kind?: 'chat' | 'submission';
      platform?: string;
      cursor?: string;
    } = {},
  ) => {
    const query = new URLSearchParams({
      limit: String(input.limit ?? 8),
    });
    if (input.kind) query.set('kind', input.kind);
    if (input.platform) query.set('platform', input.platform);
    if (input.cursor) query.set('cursor', input.cursor);
    return runtimeRequest<ArchiveQueryPage>(
      `/v1/records/query?${query.toString()}`,
    );
  },
  listPolicyEvents: (limit = 8) =>
    runtimeRequest<{ items: PolicyEvent[]; total: number }>(
      `/v1/policy/events?limit=${limit}&offset=0`,
    ),
  analyze: () =>
    runtimeRequest<{ reportPath: string; metrics: unknown }>('/v1/analyze', {
      method: 'POST',
      body: '{}',
    }),
  exportPack: () =>
    runtimeRequest<{ path: string; sha256: string }>('/v1/export', {
      method: 'POST',
      body: JSON.stringify({ format: 'analysis-pack' }),
    }),
};
