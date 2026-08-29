import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';

import { z } from 'zod';

import { redactSecrets } from '../../../packages/auth-broker/src/index';
import type { RuntimeConfig } from './config';

const MAX_BODY_BYTES = 64 * 1024;

function isSingleToken(value: string): boolean {
  if (/\s/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const syncInput = z.object({
  maxRecords: z.number().int().min(1).max(25).default(10),
  source: z.enum(['demo', 'live']).default('demo'),
});

const listInput = z.object({
  kind: z.enum(['chat', 'submission']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const recordQueryInput = z.object({
  kind: z.enum(['chat', 'submission']).optional(),
  platform: z.string().trim().min(1).max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().min(1).max(4096).optional(),
});

const policyListInput = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const nvidiaConfigInput = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(16)
      .max(4096)
      .refine(isSingleToken)
      .optional(),
    model: z.string().trim().min(1).max(256).refine(isSingleToken).optional(),
  })
  .refine((value) => Boolean(value.apiKey || value.model), {
    path: ['model'],
  });

export interface RuntimeController {
  status(): unknown;
  openAuthBrowser(): Promise<unknown>;
  validateSession(): Promise<unknown>;
  startSync(input: z.infer<typeof syncInput>): Promise<unknown>;
  pause(): Promise<unknown>;
  listRecords(input: z.infer<typeof listInput>): unknown;
  queryRecords(input: z.infer<typeof recordQueryInput>): unknown;
  readRecordProjection(recordId: string): unknown;
  readAction(actionId: string): unknown;
  listPolicyEvents(input: z.infer<typeof policyListInput>): unknown;
  nvidiaProviderStatus(): Promise<unknown>;
  configureNvidia(input: z.infer<typeof nvidiaConfigInput>): Promise<unknown>;
  refreshNvidiaModels(): Promise<unknown>;
  disconnectNvidia(): Promise<unknown>;
  analyze(): Promise<unknown>;
  exportAnalysisPack(): Promise<unknown>;
  close(): Promise<void> | void;
}

function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function isRuntimeHost(
  value: string | undefined,
  config: RuntimeConfig,
): boolean {
  if (!value) return false;
  try {
    const url = new URL(`http://${value}`);
    return (
      ['127.0.0.1', 'localhost'].includes(url.hostname) &&
      Number(url.port || 80) === config.port
    );
  } catch {
    return false;
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
): void {
  const encoded = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('content-length', Buffer.byteLength(encoded));
  if (origin && isLoopbackOrigin(origin)) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'Origin');
  }
  response.end(encoded);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function safeError(error: unknown): {
  status: number;
  body: Record<string, unknown>;
} {
  if (error instanceof HttpError) {
    return { status: error.status, body: { code: error.code } };
  }
  if (error instanceof z.ZodError) {
    return {
      status: 400,
      body: {
        code: 'invalid_request',
        issues: error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
        })),
      },
    };
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code =
    typeof candidate?.code === 'string' ? candidate.code : 'runtime_error';
  const message =
    typeof candidate?.message === 'string'
      ? candidate.message.replace(/[\r\n]+/g, ' ').slice(0, 500)
      : 'Runtime request failed';
  const status =
    code === 'NOT_FOUND'
      ? 404
      : code === 'CONFLICT' || code === 'STALE_QUERY_CURSOR'
        ? 409
        : code === 'INVALID_CURSOR' || code === 'QUERY_CURSOR_MISMATCH'
          ? 400
          : code === 'CREDENTIAL_REQUIRED'
            ? 400
            : code === 'NVIDIA_MODEL_NOT_IN_CATALOG'
              ? 400
              : code === 'NVIDIA_CATALOG_REQUIRED'
                ? 409
                : code === 'NVIDIA_CATALOG_FAILED'
                  ? 502
                  : 500;
  return {
    status,
    body: redactSecrets({ code, message }) as Record<string, unknown>,
  };
}

export function createRuntimeHttpServer(
  controller: RuntimeController,
  config: RuntimeConfig,
) {
  return createServer(async (request, response) => {
    if (!isRuntimeHost(request.headers.host, config)) {
      writeJson(response, 400, { code: 'host_denied' });
      return;
    }
    const origin = request.headers.origin;
    if (origin && !isLoopbackOrigin(origin)) {
      writeJson(response, 403, { code: 'origin_denied' });
      return;
    }

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      if (origin) {
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader(
          'access-control-allow-methods',
          'GET, POST, OPTIONS',
        );
        response.setHeader('access-control-allow-headers', 'content-type');
        response.setHeader('vary', 'Origin');
      }
      response.end();
      return;
    }

    if (
      request.method === 'POST' &&
      !request.headers['content-type']
        ?.toLowerCase()
        .startsWith('application/json')
    ) {
      writeJson(response, 415, { code: 'json_content_type_required' }, origin);
      return;
    }

    try {
      const url = new URL(
        request.url ?? '/',
        `http://${config.host}:${config.port}`,
      );
      let body: unknown;
      let status = 200;

      if (request.method === 'GET' && url.pathname === '/v1/status') {
        body = await controller.status();
      } else if (
        request.method === 'GET' &&
        url.pathname === '/v1/providers/nvidia'
      ) {
        body = await controller.nvidiaProviderStatus();
      } else if (
        request.method === 'POST' &&
        url.pathname === '/v1/providers/nvidia/configure'
      ) {
        body = await controller.configureNvidia(
          nvidiaConfigInput.parse(await readJson(request)),
        );
      } else if (
        request.method === 'POST' &&
        url.pathname === '/v1/providers/nvidia/models/refresh'
      ) {
        body = await controller.refreshNvidiaModels();
      } else if (
        request.method === 'POST' &&
        url.pathname === '/v1/providers/nvidia/disconnect'
      ) {
        body = await controller.disconnectNvidia();
      } else if (
        request.method === 'POST' &&
        url.pathname === '/v1/auth/open'
      ) {
        body = await controller.openAuthBrowser();
      } else if (
        request.method === 'POST' &&
        url.pathname === '/v1/session/validate'
      ) {
        body = await controller.validateSession();
      } else if (request.method === 'POST' && url.pathname === '/v1/sync') {
        body = await controller.startSync(
          syncInput.parse(await readJson(request)),
        );
        status = 202;
      } else if (request.method === 'POST' && url.pathname === '/v1/pause') {
        body = await controller.pause();
      } else if (request.method === 'GET' && url.pathname === '/v1/records') {
        body = await controller.listRecords(
          listInput.parse(Object.fromEntries(url.searchParams.entries())),
        );
      } else if (
        request.method === 'GET' &&
        url.pathname === '/v1/records/query'
      ) {
        body = await controller.queryRecords(
          recordQueryInput.parse(
            Object.fromEntries(url.searchParams.entries()),
          ),
        );
      } else if (
        request.method === 'GET' &&
        /^\/v1\/records\/[^/]+\/projection$/.test(url.pathname)
      ) {
        const encodedId = url.pathname
          .slice('/v1/records/'.length)
          .slice(0, -'/projection'.length);
        const recordId = decodeURIComponent(encodedId);
        if (!recordId) throw new HttpError(400, 'record_id_required');
        body = await controller.readRecordProjection(recordId);
      } else if (
        request.method === 'GET' &&
        url.pathname.startsWith('/v1/actions/')
      ) {
        const actionId = decodeURIComponent(
          url.pathname.slice('/v1/actions/'.length),
        );
        if (!actionId) throw new HttpError(400, 'action_id_required');
        body = await controller.readAction(actionId);
      } else if (
        request.method === 'GET' &&
        url.pathname === '/v1/policy/events'
      ) {
        body = await controller.listPolicyEvents(
          policyListInput.parse(Object.fromEntries(url.searchParams.entries())),
        );
      } else if (request.method === 'POST' && url.pathname === '/v1/analyze') {
        body = await controller.analyze();
      } else if (request.method === 'POST' && url.pathname === '/v1/export') {
        body = await controller.exportAnalysisPack();
      } else {
        throw new HttpError(404, 'not_found');
      }

      writeJson(response, status, body, origin);
    } catch (error) {
      const safe = safeError(error);
      writeJson(response, safe.status, safe.body, origin);
    }
  });
}
