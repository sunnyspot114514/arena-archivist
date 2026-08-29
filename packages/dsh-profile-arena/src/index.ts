import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const inject = ['tools'];

export type Config = {
  runtimeBaseUrl?: string;
};

export const ARENA_TOOL_NAME_LIST = [
  'arena_session_status',
  'arena_sync_next_batch',
  'arena_query_archive',
  'arena_read_archived_record',
  'arena_export',
] as const;

const ARENA_TOOL_NAMES = new Set<string>(ARENA_TOOL_NAME_LIST);

function jsonObject(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && !Array.isArray(value) && typeof value === 'object'
    ? value
    : null;
}

export function toArchiveHandlePage(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const sourceItems = Array.isArray(payload.items) ? payload.items : [];
  const items = sourceItems.flatMap((value) => {
    const item = jsonObject(value);
    if (
      !item ||
      typeof item.id !== 'string' ||
      typeof item.kind !== 'string' ||
      typeof item.platform !== 'string' ||
      typeof item.updatedAt !== 'string'
    ) {
      return [];
    }
    return [
      {
        id: item.id,
        kind: item.kind,
        platform: item.platform,
        dataPolicy:
          typeof item.dataPolicy === 'string' ? item.dataPolicy : 'local_only',
        sourceHash:
          typeof item.sourceHash === 'string' ? item.sourceHash : null,
        updatedAt: item.updatedAt,
      },
    ];
  });
  return {
    items,
    nextCursor:
      typeof payload.nextCursor === 'string' ? payload.nextCursor : null,
    queryHash: typeof payload.queryHash === 'string' ? payload.queryHash : null,
    catalogGeneration:
      typeof payload.catalogGeneration === 'number'
        ? payload.catalogGeneration
        : null,
  };
}

function stringOrNull(value: JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function numberOrZero(value: JsonValue | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function toArenaStatus(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const service = jsonObject(payload.service ?? null) ?? {};
  const browser = jsonObject(payload.browser ?? null) ?? {};
  const archive = jsonObject(payload.archive ?? null) ?? {};
  const checkpoint = jsonObject(archive.lastCheckpoint ?? null);
  const run = jsonObject(payload.run ?? null);
  const budget = jsonObject(payload.budget ?? null) ?? {};
  const connectorValues = Array.isArray(payload.connectors)
    ? payload.connectors
    : [];
  const connectors = connectorValues.flatMap((value) => {
    const connector = jsonObject(value);
    return connector &&
      typeof connector.id === 'string' &&
      typeof connector.version === 'string'
      ? [
          {
            id: connector.id,
            version: connector.version,
            readOnly: connector.readOnly === true,
          },
        ]
      : [];
  });
  return {
    service: {
      state: stringOrNull(service.state),
      version: stringOrNull(service.version),
    },
    session: {
      mode: stringOrNull(browser.mode),
      state: stringOrNull(browser.session),
      liveCollectionEnabled: browser.liveCollectionEnabled === true,
      selectorContract: stringOrNull(browser.selectorContract),
    },
    archive: {
      totalRecords: numberOrZero(archive.totalRecords),
      chats: numberOrZero(archive.chats),
      submissions: numberOrZero(archive.submissions),
      lastCheckpoint: checkpoint
        ? {
            scope: stringOrNull(checkpoint.scope),
            updatedAt: stringOrNull(checkpoint.updatedAt),
          }
        : null,
    },
    run: run
      ? {
          id: stringOrNull(run.id),
          actionId: stringOrNull(run.actionId),
          actionPhase: stringOrNull(run.actionPhase),
          connectorId: stringOrNull(run.connectorId),
          state: stringOrNull(run.state),
          source: stringOrNull(run.source),
          requested: numberOrZero(run.requested),
          committed: numberOrZero(run.committed),
          stopReason: stringOrNull(run.stopReason),
        }
      : null,
    budget: {
      runsToday: numberOrZero(budget.runsToday),
      maxRunsPerDay: numberOrZero(budget.maxRunsPerDay),
      maxRecordsPerRun: numberOrZero(budget.maxRecordsPerRun),
    },
    connectors,
  };
}

export function toSyncHandle(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const run = jsonObject(payload.run ?? null);
  if (!run || typeof run.id !== 'string') {
    throw new Error('Runtime returned an invalid sync handle');
  }
  return {
    run: {
      id: run.id,
      actionId: stringOrNull(run.actionId),
      actionPhase: stringOrNull(run.actionPhase),
      connectorId: stringOrNull(run.connectorId),
      state: stringOrNull(run.state),
      source: stringOrNull(run.source),
      requested: numberOrZero(run.requested),
    },
  };
}

export function toProjectionReceipt(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const receipt = jsonObject(payload.projectionReceipt ?? null);
  const record = receipt ? jsonObject(receipt.record ?? null) : null;
  const authorization = receipt
    ? jsonObject(receipt.authorization ?? null)
    : null;
  if (
    !receipt ||
    !record ||
    !authorization ||
    receipt.contentReleased !== false ||
    typeof receipt.sourceHash !== 'string' ||
    typeof receipt.projectionHash !== 'string'
  ) {
    throw new Error('Runtime returned an invalid projection receipt');
  }
  return {
    projectionReceipt: {
      kind: 'authorized_model_projection_receipt',
      sourceHash: receipt.sourceHash,
      policyVersion: stringOrNull(receipt.policyVersion),
      projectionHash: receipt.projectionHash,
      record: {
        id: stringOrNull(record.id),
        kind: stringOrNull(record.kind),
        platform: stringOrNull(record.platform),
        updatedAt: stringOrNull(record.updatedAt),
      },
      authorization: {
        dataPolicy: stringOrNull(authorization.dataPolicy),
        policyHash: stringOrNull(authorization.policyHash),
        authorizationHash: stringOrNull(authorization.authorizationHash),
      },
      contentReleased: false,
    },
  };
}

export function toExportReceipt(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (
    typeof payload.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.sha256)
  ) {
    throw new Error('Runtime returned an invalid export hash');
  }
  return { status: 'created', sha256: payload.sha256 };
}

class ArenaRuntimeClient {
  readonly #baseUrl: string;

  constructor(baseUrl: string) {
    const parsed = new URL(baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
      throw new Error('Arena runtime must use a loopback URL');
    }
    this.#baseUrl = parsed.href.replace(/\/$/, '');
  }

  async request(
    path: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<Record<string, JsonValue>> {
    const headers = new Headers(init.headers);
    if (!headers.has('content-type'))
      headers.set('content-type', 'application/json');
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers,
      signal,
    });
    const payload = (await response.json()) as Record<string, JsonValue>;
    if (!response.ok) {
      const code =
        typeof payload.code === 'string' ? payload.code : 'runtime_error';
      throw new Error(
        `Arena runtime request failed (${response.status}/${code})`,
      );
    }
    return payload;
  }
}

const jsonOutput = {
  schema: { type: 'object', additionalProperties: true } as const,
  render: (_args: unknown, value: Record<string, JsonValue>) => [
    { type: 'text' as const, text: JSON.stringify(value) },
  ],
};

export function apply(ctx: Context, config: Config = {}): void {
  const client = new ArenaRuntimeClient(
    config.runtimeBaseUrl ?? 'http://127.0.0.1:4317',
  );

  ctx.effect(function* registerArenaTools() {
    yield ctx.tools.guard((execution) =>
      ARENA_TOOL_NAMES.has(execution.name)
        ? undefined
        : `Arena profile denies tool: ${execution.name}`,
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_query_archive',
        description:
          'Query local archive handles with a stable opaque cursor. A stale cursor is rejected after the archive catalog changes.',
        parameters: {
          kind: {
            type: 'string',
            enum: ['chat', 'submission'],
            description: 'Optional archive record kind.',
          },
          platform: {
            type: 'string',
            description: 'Optional exact connector platform identifier.',
          },
          limit: {
            type: 'integer',
            description: 'Page size from 1 through 200.',
          },
          cursor: {
            type: 'string',
            description: 'Opaque cursor returned by the previous page.',
          },
        },
        output: jsonOutput,
        timeoutMs: 10_000,
        async execute(args, exec) {
          const limit = args.limit ?? 50;
          if (limit < 1 || limit > 200) {
            throw new Error('limit must be between 1 and 200');
          }
          const query = new URLSearchParams({ limit: String(limit) });
          if (args.kind) query.set('kind', args.kind);
          if (args.platform) query.set('platform', args.platform);
          if (args.cursor) query.set('cursor', args.cursor);
          const page = await client.request(
            `/v1/records/query?${query.toString()}`,
            { method: 'GET' },
            exec.signal,
          );
          return toArchiveHandlePage(page);
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_session_status',
        description:
          'Return non-secret Gray Swan session and local archive status. This never returns cookies or browser storage.',
        parameters: {},
        output: jsonOutput,
        timeoutMs: 10_000,
        async execute(_args, exec) {
          return toArenaStatus(
            await client.request('/v1/status', { method: 'GET' }, exec.signal),
          );
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_sync_next_batch',
        description:
          'Start one locally policy-authorized, low-frequency, read-only archive batch. It cannot submit or edit Arena content.',
        parameters: {
          maxRecords: {
            type: 'integer',
            required: true,
            description: 'Number of new records to archive, from 1 through 25.',
          },
          source: {
            type: 'string',
            enum: ['demo', 'live'],
            description:
              'Use demo fixtures or the reviewed live selector contract.',
          },
        },
        output: jsonOutput,
        timeoutMs: 20 * 60_000,
        async execute(args, exec) {
          if (args.maxRecords < 1 || args.maxRecords > 25) {
            throw new Error('maxRecords must be between 1 and 25');
          }
          return toSyncHandle(
            await client.request(
              '/v1/sync',
              {
                method: 'POST',
                body: JSON.stringify({
                  maxRecords: args.maxRecords,
                  source: args.source ?? 'demo',
                }),
              },
              exec.signal,
            ),
          );
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_read_archived_record',
        description:
          'Return a policy-versioned projection receipt with local record handle and provenance hashes. Record content, raw evidence, browser state, and Playwright are never returned.',
        parameters: {
          recordId: {
            type: 'string',
            required: true,
            description: 'Local archive record ID.',
          },
        },
        output: jsonOutput,
        timeoutMs: 10_000,
        async execute(args, exec) {
          return toProjectionReceipt(
            await client.request(
              `/v1/records/${encodeURIComponent(args.recordId)}/projection`,
              { method: 'GET' },
              exec.signal,
            ),
          );
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_export',
        description:
          'Create a local analysis pack after secret scanning. Browser profiles and credentials are always excluded.',
        parameters: {
          format: {
            type: 'string',
            required: true,
            enum: ['analysis-pack'],
          },
        },
        output: jsonOutput,
        timeoutMs: 120_000,
        async execute(_args, exec) {
          return toExportReceipt(
            await client.request(
              '/v1/export',
              {
                method: 'POST',
                body: JSON.stringify({ format: 'analysis-pack' }),
              },
              exec.signal,
            ),
          );
        },
      }),
    );
  }, 'arena semantic tools and monotonic guard');
}
