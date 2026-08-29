export type RuntimeMode =
  | 'PAUSED_HUMAN_AUTH'
  | 'AUTH_MODE'
  | 'COLLECT_MODE'
  | 'DEMO_MODE';

export type RuntimeStatus = {
  service: {
    state: 'ready';
    version: string;
    host: '127.0.0.1';
  };
  browser: {
    mode: RuntimeMode;
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
    lastCheckpoint: {
      scope: string;
      cursor: string;
      updatedAt: string;
    } | null;
  };
  run: {
    id: string;
    actionId: string | null;
    actionPhase:
      | 'proposal'
      | 'validation'
      | 'authorization'
      | 'dispatch'
      | 'observation'
      | 'reconciliation'
      | 'canonical_commit'
      | 'blocked'
      | 'failed'
      | 'cancelled'
      | null;
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
    maxRunsPerDay: 3;
    maxRecordsPerRun: 25;
    minIntervalSeconds: 10;
    maxRunMinutes: 20;
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
