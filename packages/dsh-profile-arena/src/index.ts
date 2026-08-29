import type { Context } from '@deepseek-ai/cordis';
import type { JsonValue } from '@deepseek-ai/dsh-session';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const inject = ['tools'];

export type Config = {
  runtimeBaseUrl?: string;
};

const ARENA_TOOL_NAMES = new Set([
  'arena_session_status',
  'arena_sync_next_batch',
  'arena_read_archived_record',
  'arena_export',
]);

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
        name: 'arena_session_status',
        description:
          'Return non-secret Gray Swan session and local archive status. This never returns cookies or browser storage.',
        parameters: {},
        output: jsonOutput,
        timeoutMs: 10_000,
        async execute(_args, exec) {
          return client.request('/v1/status', { method: 'GET' }, exec.signal);
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_sync_next_batch',
        description:
          'Start one manually authorized, low-frequency, read-only archive batch. It cannot submit or edit Arena content.',
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
          return client.request(
            '/v1/sync',
            {
              method: 'POST',
              body: JSON.stringify({
                maxRecords: args.maxRecords,
                source: args.source ?? 'demo',
              }),
            },
            exec.signal,
          );
        },
      }),
    );

    yield ctx.tools.register(
      defineTool({
        name: 'arena_read_archived_record',
        description:
          'Read a normalized local archive record and provenance. This performs no browser action.',
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
          return client.request(
            `/v1/records/${encodeURIComponent(args.recordId)}`,
            { method: 'GET' },
            exec.signal,
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
          return client.request(
            '/v1/export',
            {
              method: 'POST',
              body: JSON.stringify({ format: 'analysis-pack' }),
            },
            exec.signal,
          );
        },
      }),
    );
  }, 'arena semantic tools and monotonic guard');
}
