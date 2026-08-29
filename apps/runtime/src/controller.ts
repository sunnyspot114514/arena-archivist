import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  ArchiveStore,
  type StoredActionLedgerAction,
  type StoredSyncRun,
} from '../../../packages/archive-store/index';
import { ArchiveConnectorRegistry } from '../../../packages/archive-connectors/src/index';
import {
  OfflineFixtureBrowser,
  GraySwanBrowserWorker,
  openCollectBrowser,
  openManualAuthBrowser,
  type CollectBrowserPort,
  type ManualAuthSession,
  type NetworkPolicyDecision,
  type PlaywrightRuntimeLike,
  type WorkerRunResult,
  type WorkerStopReason,
} from '../../../packages/browser-worker/src/index';
import {
  computeMetrics,
  renderMarkdownReport,
  type AttemptOutcome,
  type AttemptRecord,
} from '../../../packages/analysis-engine/src/index';
import { exportAnalysisPack } from '../../../packages/exporter/src/index';
import {
  createAuthorizedModelProjection,
  createAuthorizedModelProjectionReceipt,
} from '../../../packages/model-router/src/index';
import {
  graySwanArchiveConnector,
  type GraySwanSelectorContract,
} from '../../../packages/gray-swan-adapter/src/index';
import {
  JsonFileGovernorStateStore,
  RateGovernor,
  type ImmediateStopSignal,
} from '../../../packages/rate-governor/index';
import {
  createLocalSecretStore,
  EnvironmentAuthBroker,
  type AuthStatus,
} from '../../../packages/auth-broker/src/index';
import { ArchiveAuditPort, ArchiveStorePort } from './archive-port';
import type { NvidiaProviderStatus, RuntimeStatus } from './api-types';
import {
  resolveBrowserLaunchTarget,
  type BrowserLaunchTarget,
} from './browser-launch';
import type { RuntimeConfig } from './config';
import type { RuntimeController } from './http-server';
import { openNativeAuthBrowser } from './native-auth';
import {
  classifyNvidiaModelSelection,
  fetchNvidiaModelIds,
  nvidiaBaseUrlFromEnvironment,
  ProviderSettingsStore,
} from './provider-manager';

const VERSION = '0.1.0';
const SYNC_POLICY_VERSION = 'arena-read-only-sync-v1';

class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeError';
  }
}

type ActiveRun = {
  id: string;
  actionId: string;
  connectorId: string;
  connectorVersion: string;
  source: 'demo' | 'live';
  requested: number;
  controller: AbortController;
  promise: Promise<void>;
};

function runSource(run: StoredSyncRun): 'demo' | 'live' {
  return run.metadata.source === 'live' ? 'live' : 'demo';
}

function statusRun(
  run: StoredSyncRun | null,
  action: StoredActionLedgerAction | null = null,
): RuntimeStatus['run'] {
  if (!run) return null;
  return {
    id: run.id,
    actionId: action?.actionId ?? null,
    actionPhase: action?.currentPhase ?? null,
    connectorId: action?.connectorId ?? null,
    state: run.status,
    source: runSource(run),
    requested: run.requestedMaxRecords ?? 0,
    committed: run.recordsCommitted,
    skippedKnown:
      typeof run.metadata.skippedKnown === 'number'
        ? run.metadata.skippedKnown
        : 0,
    stopReason: run.stopReason,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

function immediateStop(
  reason: WorkerStopReason | null,
): ImmediateStopSignal | null {
  switch (reason) {
    case 'http_403':
      return 'HTTP_403';
    case 'http_429':
      return 'HTTP_429';
    case 'captcha':
    case 'bot_challenge':
    case 'login_required':
    case 'unexpected_mutation':
      return reason;
    default:
      return null;
  }
}

function outcome(value: string | null): AttemptOutcome {
  const normalized = value
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[\s_]+/g, '-');
  if (['success', 'successful', 'passed', 'break'].includes(normalized ?? '')) {
    return 'success';
  }
  if (
    [
      'failure',
      'failed',
      'not-successful',
      'unsuccessful',
      'rejected',
    ].includes(normalized ?? '')
  ) {
    return 'failure';
  }
  return 'unknown';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function firstUserPrompt(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    if (row.role === 'user')
      return stringValue(row.body) ?? stringValue(row.content);
  }
  return null;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  await rename(temporary, path);
}

export class ArenaRuntimeController implements RuntimeController {
  readonly #store: ArchiveStore;
  readonly #governor: RateGovernor;
  readonly #auth: EnvironmentAuthBroker;
  readonly #providerSettings: ProviderSettingsStore;
  readonly #connectors: ArchiveConnectorRegistry;
  readonly #graySwanConnector: typeof graySwanArchiveConnector;
  readonly #nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1';
  readonly #config: RuntimeConfig;
  readonly #fixtureContract: GraySwanSelectorContract;
  readonly #liveContract: GraySwanSelectorContract | null;
  #authSession: ManualAuthSession | null = null;
  #activeRun: ActiveRun | null = null;
  #session: 'unknown' | 'valid' | 'invalid' = 'unknown';
  #lastValidatedAt: string | null = null;
  #nvidiaModels: string[] = [];
  #browserLaunchTarget: BrowserLaunchTarget | null = null;
  #closed = false;

  private constructor(options: {
    config: RuntimeConfig;
    store: ArchiveStore;
    governor: RateGovernor;
    auth: EnvironmentAuthBroker;
    providerSettings: ProviderSettingsStore;
    connectors: ArchiveConnectorRegistry;
    graySwanConnector: typeof graySwanArchiveConnector;
    nvidiaBaseUrl: 'https://integrate.api.nvidia.com/v1';
    fixtureContract: GraySwanSelectorContract;
    liveContract: GraySwanSelectorContract | null;
  }) {
    this.#config = options.config;
    this.#store = options.store;
    this.#governor = options.governor;
    this.#auth = options.auth;
    this.#providerSettings = options.providerSettings;
    this.#connectors = options.connectors;
    this.#graySwanConnector = options.graySwanConnector;
    this.#nvidiaBaseUrl = options.nvidiaBaseUrl;
    this.#fixtureContract = options.fixtureContract;
    this.#liveContract = options.liveContract;
  }

  static async create(config: RuntimeConfig): Promise<ArenaRuntimeController> {
    const store = new ArchiveStore({
      databasePath: config.databasePath,
      evidenceDirectory: config.evidenceDirectory,
    });
    for (const run of store.listSyncRuns({ status: 'running', limit: 500 })) {
      const action = store.getActionForRun(run.id);
      if (action?.terminal) {
        store.close();
        throw new RuntimeError(
          'CORRUPT_ACTION_LEDGER',
          `Running sync ${run.id} has a terminal action`,
        );
      }
      if (action) {
        store.settleSyncRunAction({
          runId: run.id,
          status: 'failed',
          stopReason: 'process_restarted',
          observation: { recovery: true },
        });
      } else {
        store.finishSyncRun(run.id, 'failed', 'process_restarted');
      }
    }

    const connectors = new ArchiveConnectorRegistry();
    const graySwanConnector = connectors.register(graySwanArchiveConnector);

    const governor = new RateGovernor({
      store: new JsonFileGovernorStateStore(
        resolve(config.checkpointsDirectory, 'rate_governor.json'),
      ),
    });
    const governorState = governor.snapshot();
    if (governorState.activeRun) {
      governor.cancelRun(governorState.activeRun.runId);
    }

    const fixtureContract = await graySwanConnector.loadContract(
      resolve(
        config.workspaceRoot,
        'packages',
        'gray-swan-adapter',
        'contracts',
        'grayswan.fixture-v1.json',
      ),
    );
    const liveContract = config.liveSelectorContractPath
      ? await graySwanConnector.loadContract(config.liveSelectorContractPath)
      : null;
    if (
      config.liveCollectionEnabled &&
      liveContract?.compatibility.status !== 'verified'
    ) {
      throw new RuntimeError(
        'SELECTOR_NOT_VERIFIED',
        'Live selector contract must have compatibility.status=verified',
      );
    }

    const auth = new EnvironmentAuthBroker(
      {
        deepseek: { provider: 'deepseek', envName: 'DEEPSEEK_API_KEY' },
        minimax: { provider: 'minimax', envName: 'MINIMAX_API_KEY' },
        nvidia: { provider: 'nvidia', envName: 'NVIDIA_API_KEY' },
        openrouter: { provider: 'openrouter', envName: 'OPENROUTER_API_KEY' },
      },
      createLocalSecretStore(config.credentialDirectory),
    );
    const providerSettings = await ProviderSettingsStore.open(
      config.providerSettingsPath,
      process.env.NVIDIA_MODEL?.trim() || null,
    );
    const nvidiaBaseUrl = nvidiaBaseUrlFromEnvironment();

    return new ArenaRuntimeController({
      config,
      store,
      governor,
      auth,
      providerSettings,
      connectors,
      graySwanConnector,
      nvidiaBaseUrl,
      fixtureContract,
      liveContract,
    });
  }

  async nvidiaProviderStatus(): Promise<NvidiaProviderStatus> {
    this.#assertOpen();
    const status = await this.#auth.status('nvidia');
    return {
      id: 'nvidia',
      status: status.status,
      activeModel: this.#providerSettings.nvidiaModel,
      baseUrl: this.#nvidiaBaseUrl,
      credentialSource: await this.#auth.credentialSource('nvidia'),
      secretStorage: this.#auth.secretStoreKind,
      availableModels: [...this.#nvidiaModels],
    };
  }

  async configureNvidia(input: {
    apiKey?: string;
    model?: string;
  }): Promise<NvidiaProviderStatus> {
    this.#assertIdle();
    const modelSelection = input.model
      ? classifyNvidiaModelSelection(input.model, this.#nvidiaModels)
      : null;
    if (modelSelection === 'catalog-required') {
      throw new RuntimeError(
        'NVIDIA_CATALOG_REQUIRED',
        'Refresh the NVIDIA model catalog before selecting a model',
      );
    }
    if (modelSelection === 'not-in-catalog') {
      throw new RuntimeError(
        'NVIDIA_MODEL_NOT_IN_CATALOG',
        'The selected model ID is not present in the current NVIDIA catalog',
      );
    }
    if (input.apiKey) {
      await this.#auth.setCredential('nvidia', input.apiKey);
    } else if ((await this.#auth.status('nvidia')).status !== 'connected') {
      throw new RuntimeError(
        'CREDENTIAL_REQUIRED',
        'NVIDIA API Key is required for the first connection',
      );
    }
    if (input.model) {
      await this.#providerSettings.selectNvidiaModel(input.model);
    }
    return this.nvidiaProviderStatus();
  }

  async refreshNvidiaModels(): Promise<NvidiaProviderStatus> {
    this.#assertIdle();
    try {
      this.#nvidiaModels = await fetchNvidiaModelIds({
        auth: this.#auth,
        baseUrl: this.#nvidiaBaseUrl,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'NVIDIA model refresh failed';
      throw new RuntimeError('NVIDIA_CATALOG_FAILED', message);
    }
    return this.nvidiaProviderStatus();
  }

  async disconnectNvidia(): Promise<NvidiaProviderStatus> {
    this.#assertIdle();
    await this.#auth.disconnect('nvidia');
    this.#nvidiaModels = [];
    return this.nvidiaProviderStatus();
  }

  async status(): Promise<RuntimeStatus> {
    this.#assertOpen();
    const stats = this.#store.stats();
    const checkpoints = [
      this.#store.getCheckpoint('gray-swan:archive-index'),
      this.#store.getCheckpoint('demo:gray-swan:archive-index'),
    ].filter((value) => value !== null);
    checkpoints.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
    const lastCheckpoint = checkpoints[0] ?? null;
    const latestRun = this.#store.listSyncRuns({ limit: 1 })[0] ?? null;
    const latestAction = latestRun
      ? this.#store.getActionForRun(latestRun.id)
      : null;
    const governor = this.#governor.snapshot();
    const providerStatuses: AuthStatus[] = await Promise.all(
      ['deepseek', 'minimax', 'nvidia', 'openrouter'].map((id) =>
        this.#auth.status(id),
      ),
    );

    return {
      service: { state: 'ready', version: VERSION, host: '127.0.0.1' },
      browser: {
        mode: this.#activeRun
          ? this.#activeRun.source === 'demo'
            ? 'DEMO_MODE'
            : 'COLLECT_MODE'
          : this.#authSession
            ? 'AUTH_MODE'
            : 'PAUSED_HUMAN_AUTH',
        session: this.#session,
        authBrowserOpen: Boolean(this.#authSession),
        authPageCount: this.#authSession?.pageCount() ?? 0,
        liveCollectionEnabled: this.#config.liveCollectionEnabled,
        selectorContract: this.#liveContract
          ? this.#liveContract.compatibility.status === 'verified'
            ? 'verified'
            : 'fixture-baseline'
          : 'missing',
        lastValidatedAt: this.#lastValidatedAt,
      },
      archive: {
        totalRecords: stats.chats + stats.submissions,
        chats: stats.chats,
        submissions: stats.submissions,
        annotations: 0,
        lastCheckpoint: lastCheckpoint
          ? {
              scope: lastCheckpoint.scope,
              cursor: lastCheckpoint.cursor,
              updatedAt: lastCheckpoint.updatedAt,
            }
          : null,
      },
      run: statusRun(latestRun, latestAction),
      budget: {
        runsToday: governor.runsStartedToday,
        maxRunsPerDay: 3,
        maxRecordsPerRun: 25,
        minIntervalSeconds: 10,
        maxRunMinutes: 20,
      },
      providers: providerStatuses.map((provider) => ({
        id: provider.provider,
        status: provider.status,
        activeModel:
          provider.provider === 'nvidia'
            ? this.#providerSettings.nvidiaModel
            : undefined,
      })),
      connectors: this.#connectors.list(),
    };
  }

  async openAuthBrowser(): Promise<{
    status: 'opened';
    pageCount: number;
  }> {
    this.#assertIdle();
    if (this.#authSession) {
      if (this.#authSession.pageCount() < 3) {
        await this.#authSession.openLoginPage();
      }
      return {
        status: 'opened',
        pageCount: this.#authSession.pageCount(),
      };
    }
    const launchTarget = await this.#resolveBrowserLaunchTarget();
    const profileDirectory = resolve(
      this.#config.browserProfileDirectory,
      launchTarget.profileKey,
    );
    const session = launchTarget.executablePath
      ? await openNativeAuthBrowser({
          executablePath: launchTarget.executablePath,
          profileDirectory,
          startUrl: this.#config.authStartUrl,
        })
      : await (async () => {
          const { chromium } = await import('playwright-core');
          return openManualAuthBrowser(
            { chromium } as unknown as PlaywrightRuntimeLike,
            {
              profileDirectory,
              startUrl: this.#config.authStartUrl,
              ...this.#playwrightLaunchOptions(launchTarget),
            },
          );
        })();
    this.#authSession = session;
    void session.waitForClose().finally(() => {
      if (this.#authSession === session) this.#authSession = null;
    });
    return { status: 'opened', pageCount: session.pageCount() };
  }

  async validateSession(): Promise<{ session: 'valid' | 'invalid' }> {
    this.#assertIdle();
    if (this.#authSession) {
      throw new RuntimeError(
        'CONFLICT',
        'Close the manual auth browser before validation',
      );
    }
    const contract = this.#requireLiveContract();
    const browser = await this.#openLiveBrowser(contract);
    try {
      await browser.navigate(this.#config.liveIndexUrl!);
      const violation = browser.consumePolicyViolation();
      const snapshot = await browser.snapshot();
      const blocker = this.#graySwanConnector.detectBlocker(snapshot, contract);
      const parsed = blocker
        ? null
        : this.#graySwanConnector.parseIndex(snapshot, contract);
      this.#session =
        !violation && !blocker && parsed?.ok ? 'valid' : 'invalid';
      this.#lastValidatedAt = new Date().toISOString();
      return { session: this.#session };
    } finally {
      await browser.close();
    }
  }

  async startSync(input: {
    maxRecords: number;
    source: 'demo' | 'live';
  }): Promise<{ run: RuntimeStatus['run'] }> {
    this.#assertIdle();
    if (this.#authSession) {
      throw new RuntimeError(
        'CONFLICT',
        'Close the manual auth browser before collection',
      );
    }
    if (input.source === 'live') this.#requireLiveContract();

    let runId: string;
    if (input.source === 'live') {
      runId = this.#governor.startRun(input.maxRecords).runId;
    } else {
      runId = `demo_${randomUUID()}`;
    }
    try {
      const created = this.#store.startAuthorizedSyncRun({
        id: runId,
        requestedMaxRecords: input.maxRecords,
        metadata: { source: input.source },
        connectorId: this.#graySwanConnector.metadata.id,
        connectorVersion: this.#graySwanConnector.metadata.version,
        policyVersion: SYNC_POLICY_VERSION,
        request: {
          source: input.source,
          maxRecords: input.maxRecords,
          operation: 'sync_next_batch',
        },
        authorization: {
          principal: 'loopback_runtime_client',
          decisionCode: 'bounded_readonly_policy_allow',
        },
      });
      runId = created.runId;
    } catch (error) {
      if (input.source === 'live') this.#safeCancelGovernor(runId);
      throw error;
    }

    const controller = new AbortController();
    const active: ActiveRun = {
      id: runId,
      actionId: this.#store.getActionForRun(runId)!.actionId,
      connectorId: this.#graySwanConnector.metadata.id,
      connectorVersion: this.#graySwanConnector.metadata.version,
      source: input.source,
      requested: input.maxRecords,
      controller,
      promise: Promise.resolve(),
    };
    this.#activeRun = active;
    active.promise = this.#executeRun(active).finally(() => {
      if (this.#activeRun === active) this.#activeRun = null;
    });
    return {
      run: statusRun(
        this.#store.getSyncRun(runId),
        this.#store.getActionForRun(runId),
      ),
    };
  }

  async pause(): Promise<{ status: 'pausing' | 'idle' }> {
    this.#assertOpen();
    if (!this.#activeRun) return { status: 'idle' };
    this.#activeRun.controller.abort(new Error('user_paused'));
    return { status: 'pausing' };
  }

  listRecords(input: {
    kind?: 'chat' | 'submission';
    limit: number;
    offset: number;
  }): { items: unknown[]; total: number } {
    this.#assertOpen();
    const stats = this.#store.stats();
    const items = this.#store.listRecords(input).map((summary) => {
      const record = this.#store.getRecordById(summary.id);
      return {
        id: summary.id,
        kind: summary.kind,
        externalId: summary.externalId,
        platform: summary.platform,
        title: record?.title ?? stringValue(record?.normalized.title),
        outcome: record?.outcome ?? null,
        dataPolicy: summary.dataPolicy,
        updatedAt: summary.updatedAt,
      };
    });
    const total = input.kind
      ? input.kind === 'chat'
        ? stats.chats
        : stats.submissions
      : stats.chats + stats.submissions;
    return { items, total };
  }

  queryRecords(input: {
    kind?: 'chat' | 'submission';
    platform?: string;
    limit: number;
    cursor?: string;
  }): {
    items: unknown[];
    nextCursor: string | null;
    queryHash: string;
    catalogGeneration: number;
  } {
    this.#assertOpen();
    const page = this.#store.queryRecords(input);
    return {
      ...page,
      items: page.items.map((summary) => {
        const record = this.#store.getRecordById(summary.id);
        return {
          id: summary.id,
          kind: summary.kind,
          platform: summary.platform,
          title: record?.title ?? stringValue(record?.normalized.title),
          outcome: record?.outcome ?? null,
          dataPolicy: summary.dataPolicy,
          sourceHash: summary.sourceHash,
          updatedAt: summary.updatedAt,
        };
      }),
    };
  }

  readRecordProjection(recordId: string): unknown {
    this.#assertOpen();
    const attestation = this.#store.attestRecord(recordId);
    if (!attestation)
      throw new RuntimeError('NOT_FOUND', 'Archive record not found');
    const projection = createAuthorizedModelProjection(attestation);
    return {
      projectionReceipt: createAuthorizedModelProjectionReceipt(projection),
    };
  }

  readAction(actionId: string): unknown {
    this.#assertOpen();
    const action = this.#store.getAction(actionId);
    if (!action)
      throw new RuntimeError('NOT_FOUND', 'Action ledger entry not found');
    return {
      action,
      events: this.#store.listActionEvents(actionId),
      recordCommits: this.#store.listSyncRecordCommits(action.syncRunId),
    };
  }

  listPolicyEvents(input: { limit: number; offset: number }): {
    items: unknown[];
    total: number;
  } {
    this.#assertOpen();
    return {
      items: this.#store.listPolicyDecisions(input),
      total: this.#store.stats().policyDecisions,
    };
  }

  async analyze(): Promise<{ metrics: unknown; reportPath: string }> {
    this.#assertIdle();
    const attempts: AttemptRecord[] = [];
    for (let offset = 0; ; offset += 500) {
      const summaries = this.#store.listRecords({
        kind: 'submission',
        limit: 500,
        offset,
      });
      for (const summary of summaries) {
        const record = this.#store.getRecordById(summary.id);
        if (!record) continue;
        attempts.push({
          id: record.id,
          challengeId: record.challengeId,
          behavior: stringValue(record.normalized.behavior),
          model: stringValue(record.normalized.modelAlias),
          templateId: stringValue(record.normalized.templateId),
          prompt: firstUserPrompt(record.normalized.messages),
          outcome: outcome(
            record.outcome ?? record.judgeResults[0]?.verdict ?? null,
          ),
          createdAt: record.firstSeenAt,
        });
      }
      if (summaries.length < 500) break;
    }

    const metrics = computeMetrics(attempts);
    const metricsPath = resolve(this.#config.analysisDirectory, 'metrics.json');
    const reportPath = resolve(this.#config.analysisDirectory, 'report.md');
    await writeAtomic(metricsPath, `${JSON.stringify(metrics, null, 2)}\n`);
    await writeAtomic(reportPath, renderMarkdownReport(metrics));
    await this.#writeArchiveManifest(metrics.sampleSize);
    return { metrics, reportPath };
  }

  async exportAnalysisPack(): Promise<{
    path: string;
    sha256: string;
    includedPaths: string[];
  }> {
    this.#assertIdle();
    await this.#writeArchiveManifest(this.#store.stats().submissions);
    this.#store.prepareExport();
    const exported = await exportAnalysisPack({
      archiveRoot: this.#config.dataDirectory,
    });
    const bytes = await readFile(exported.outputPath);
    return {
      path: exported.outputPath,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      includedPaths: exported.includedPaths,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#activeRun) {
      this.#activeRun.controller.abort(new Error('runtime_shutdown'));
      await this.#activeRun.promise;
    }
    if (this.#authSession) await this.#authSession.close();
    this.#store.close();
  }

  async #executeRun(run: ActiveRun): Promise<void> {
    let browser: CollectBrowserPort | null = null;
    try {
      this.#store.advanceAction(run.actionId, 'dispatch', {
        source: run.source,
        connectorId: run.connectorId,
        connectorVersion: run.connectorVersion,
        requestedMaxRecords: run.requested,
      });
      const setup =
        run.source === 'demo'
          ? await this.#openDemoBrowser()
          : {
              browser: await this.#openLiveBrowser(this.#requireLiveContract()),
              contract: this.#requireLiveContract(),
              indexUrl: this.#config.liveIndexUrl!,
              checkpointScope: 'gray-swan:archive-index',
              platform: 'gray-swan',
              cooldownMs: 10_000,
            };
      browser = setup.browser;
      const worker = new GraySwanBrowserWorker(
        {
          indexUrl: setup.indexUrl,
          checkpointScope: setup.checkpointScope,
          maxNewRecordsPerRun: 25,
          maxRunMinutes: 20,
          minRecordOpenIntervalMs: setup.cooldownMs,
        },
        {
          browser,
          archive: new ArchiveStorePort(this.#store, run.id, setup.platform),
          selectorContract: setup.contract,
          runBudget: { tryStart: async () => true },
          audit: new ArchiveAuditPort(this.#store, run.id, run.actionId),
        },
      );
      const result = await worker.runNextBatch({
        maxRecords: run.requested,
        signal: run.controller.signal,
      });
      this.#settleRun(run, result);
    } catch (error) {
      const current = this.#store.getSyncRun(run.id);
      if (current?.status === 'running') {
        try {
          this.#store.settleSyncRunAction({
            runId: run.id,
            status: 'failed',
            stopReason: 'runtime_error',
            observation: {
              error: error instanceof Error ? error.name : 'runtime_error',
            },
          });
        } catch {
          // Preserve the running action/run pair for explicit startup recovery.
          // Updating only one side would destroy the durable lifecycle invariant.
        }
      }
      if (run.source === 'live') this.#safeCancelGovernor(run.id);
      this.#store.appendPolicyDecision({
        id: `decision_${randomUUID()}`,
        occurredAt: new Date().toISOString(),
        layer: 'runtime',
        mode: run.source === 'live' ? 'COLLECT_MODE' : 'DEMO_MODE',
        allowed: false,
        reason: error instanceof Error ? error.name : 'runtime_error',
        action: 'run_failed',
      });
    } finally {
      if (browser) await browser.close();
    }
  }

  #settleRun(run: ActiveRun, result: WorkerRunResult): void {
    this.#store.settleSyncRunAction({
      runId: run.id,
      status: result.status === 'completed' ? 'completed' : 'stopped',
      stopReason: result.stopReason ?? undefined,
      terminalPhase:
        result.stopReason === 'user_paused' ? 'cancelled' : 'blocked',
      observation: {
        workerStatus: result.status,
        stopReason: result.stopReason,
        committed: result.committed,
        skippedKnown: result.skippedKnown,
        visitedStates: [...result.visitedStates],
      },
      reconciliation: {
        workerCommitted: result.committed,
        skippedKnown: result.skippedKnown,
      },
    });
    if (run.source !== 'live') return;
    const immediate = immediateStop(result.stopReason);
    try {
      if (immediate) this.#governor.stopImmediately(run.id, immediate);
      else if (result.status === 'completed') this.#governor.finishRun(run.id);
      else this.#governor.cancelRun(run.id);
    } catch {
      // The governor may have expired the run while the worker was settling.
    }
  }

  async #openDemoBrowser(): Promise<{
    browser: CollectBrowserPort;
    contract: GraySwanSelectorContract;
    indexUrl: string;
    checkpointScope: string;
    platform: string;
    cooldownMs: number;
  }> {
    const root = resolve(
      this.#config.workspaceRoot,
      'packages',
      'gray-swan-adapter',
      'fixtures',
      'html',
    );
    const pages = await Promise.all(
      [
        [
          'index.html',
          'https://fixture.invalid/arena/archive',
          'Archive fixture index',
        ],
        [
          'chat-001.html',
          'https://fixture.invalid/arena/archive/chat_001',
          'First synthetic chat',
        ],
        [
          'submission-001.html',
          'https://fixture.invalid/arena/archive/submission_001',
          'Synthetic judged submission',
        ],
      ].map(async ([file, url, title]) => ({
        url,
        title,
        html: await readFile(resolve(root, file), 'utf8'),
        visibleText: title,
      })),
    );
    return {
      browser: new OfflineFixtureBrowser(pages),
      contract: this.#fixtureContract,
      indexUrl: 'https://fixture.invalid/arena/archive',
      checkpointScope: 'demo:gray-swan:archive-index',
      platform: 'gray-swan-fixture',
      cooldownMs: 0,
    };
  }

  async #openLiveBrowser(
    _contract: GraySwanSelectorContract,
  ): Promise<CollectBrowserPort> {
    const { chromium } = await import('playwright-core');
    const launchTarget = await this.#resolveBrowserLaunchTarget();
    const primaryOrigin = new URL(this.#config.liveIndexUrl!).origin;
    return openCollectBrowser(
      { chromium } as unknown as PlaywrightRuntimeLike,
      {
        profileDirectory: resolve(
          this.#config.browserProfileDirectory,
          launchTarget.profileKey,
        ),
        primaryOrigin,
        staticOrigins: this.#config.staticOrigins,
        readOnlyGraphqlEndpoints: this.#config.readOnlyGraphqlEndpoints,
        ...this.#playwrightLaunchOptions(launchTarget),
        onPolicyDecision: (decision) => this.#recordNetworkDecision(decision),
      },
    );
  }

  async #resolveBrowserLaunchTarget(): Promise<BrowserLaunchTarget> {
    this.#browserLaunchTarget ??= await resolveBrowserLaunchTarget();
    return this.#browserLaunchTarget;
  }

  #playwrightLaunchOptions(target: BrowserLaunchTarget): {
    channel?: string;
    executablePath?: string;
  } {
    return { channel: target.channel };
  }

  #recordNetworkDecision(decision: NetworkPolicyDecision): void {
    if (decision.allowed) return;
    this.#store.appendPolicyDecision({
      id: `decision_${randomUUID()}`,
      occurredAt: new Date().toISOString(),
      layer: 'network',
      mode: 'COLLECT_MODE',
      allowed: false,
      reason: decision.reason,
      action: decision.method,
      origin: decision.origin ?? undefined,
      metadata: { resourceType: decision.resourceType },
    });
  }

  #requireLiveContract(): GraySwanSelectorContract {
    if (
      !this.#config.liveCollectionEnabled ||
      !this.#config.liveIndexUrl ||
      !this.#liveContract
    ) {
      throw new RuntimeError(
        'LIVE_COLLECTION_DISABLED',
        'Live collection is disabled until a reviewed selector contract is configured',
      );
    }
    if (this.#liveContract.compatibility.status !== 'verified') {
      throw new RuntimeError(
        'SELECTOR_NOT_VERIFIED',
        'Live selector contract is not verified',
      );
    }
    return this.#liveContract;
  }

  #assertOpen(): void {
    if (this.#closed)
      throw new RuntimeError('RUNTIME_CLOSED', 'Runtime is closed');
  }

  #assertIdle(): void {
    this.#assertOpen();
    if (this.#activeRun)
      throw new RuntimeError('CONFLICT', 'A sync run is already active');
    if (this.#store.stats().activeSyncRuns > 0) {
      throw new RuntimeError(
        'CONFLICT',
        'A durable sync run still requires recovery; restart the runtime',
      );
    }
  }

  #safeCancelGovernor(runId: string): void {
    try {
      this.#governor.cancelRun(runId);
    } catch {
      // A persisted run may already have expired or stopped.
    }
  }

  async #writeArchiveManifest(submissionSampleSize: number): Promise<void> {
    const stats = this.#store.stats();
    const manifest = {
      format: 'arena-archivist-archive',
      version: 1,
      generatedAt: new Date().toISOString(),
      schemaVersion: this.#store.schemaVersion,
      counts: stats,
      analysisSubmissionSampleSize: submissionSampleSize,
      dataPolicyDefault: 'local_only',
      excludes: ['runtime/chrome-profile', 'credentials', 'cookies', '.env'],
    };
    await writeAtomic(
      resolve(this.#config.dataDirectory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
}
