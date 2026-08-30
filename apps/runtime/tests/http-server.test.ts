import { afterEach, describe, expect, it } from 'vitest';

import type { AddressInfo } from 'node:net';

import type { RuntimeConfig } from '../src/config';
import {
  createRuntimeHttpServer,
  type RuntimeController,
} from '../src/http-server';

const openServers: ReturnType<typeof createRuntimeHttpServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function fixtureServer(
  options: {
    liveSessionInvalid?: boolean;
    validationError?: { readonly code: string; readonly message: string };
  } = {},
) {
  const calls: string[] = [];
  const controller: RuntimeController = {
    status: () => ({}),
    openAuthBrowser: async () => ({}),
    validateSession: async () => {
      if (options.validationError) {
        throw Object.assign(new Error(options.validationError.message), {
          code: options.validationError.code,
        });
      }
      return {};
    },
    startSync: async () => {
      if (options.liveSessionInvalid) {
        throw Object.assign(new Error('validate session first'), {
          code: 'SESSION_NOT_VALID',
        });
      }
      return {};
    },
    pause: async () => ({}),
    listRecords: (input) => {
      calls.push(`offset:${input.offset}`);
      return { items: [], total: 0 };
    },
    queryRecords: (input) => {
      calls.push(`query:${input.cursor ?? 'first'}`);
      if (input.cursor === 'stale') {
        throw Object.assign(new Error('catalog changed'), {
          code: 'STALE_QUERY_CURSOR',
        });
      }
      if (input.cursor === 'invalid') {
        throw Object.assign(new Error('bad cursor'), {
          code: 'INVALID_CURSOR',
        });
      }
      if (input.cursor === 'mismatch') {
        throw Object.assign(new Error('query changed'), {
          code: 'QUERY_CURSOR_MISMATCH',
        });
      }
      return {
        items: [{ id: 'chat_1' }],
        nextCursor: 'next',
        queryHash: `sha256:${'a'.repeat(64)}`,
        catalogGeneration: 2,
      };
    },
    readRecordProjection: (recordId) => {
      calls.push(`projection:${recordId}`);
      return { projectionReceipt: { record: { id: recordId } } };
    },
    readAction: (actionId) => {
      calls.push(`action:${actionId}`);
      return { action: { actionId }, events: [] };
    },
    listPolicyEvents: () => ({ items: [], total: 0 }),
    nvidiaProviderStatus: async () => ({}),
    configureNvidia: async () => ({}),
    refreshNvidiaModels: async () => ({}),
    disconnectNvidia: async () => ({}),
    analyze: async () => ({}),
    exportAnalysisPack: async () => ({}),
    close: () => undefined,
  };
  const config = {
    host: '127.0.0.1',
    port: 0,
  } as RuntimeConfig;
  const server = createRuntimeHttpServer(controller, config);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  config.port = address.port;
  return { baseUrl: `http://127.0.0.1:${address.port}`, calls };
}

describe('runtime archive HTTP boundary', () => {
  it('routes cursor, projection receipt, action, and offset compatibility APIs', async () => {
    const { baseUrl, calls } = await fixtureServer();
    const query = await fetch(`${baseUrl}/v1/records/query?limit=2`);
    expect(query.status).toBe(200);
    expect(await query.json()).toEqual(
      expect.objectContaining({ nextCursor: 'next', catalogGeneration: 2 }),
    );

    const projection = await fetch(`${baseUrl}/v1/records/chat_1/projection`);
    expect(projection.status).toBe(200);
    expect(await projection.json()).toEqual({
      projectionReceipt: { record: { id: 'chat_1' } },
    });

    const action = await fetch(`${baseUrl}/v1/actions/action_1`);
    expect(action.status).toBe(200);
    expect(await action.json()).toEqual({
      action: { actionId: 'action_1' },
      events: [],
    });

    const offset = await fetch(`${baseUrl}/v1/records?limit=2&offset=7`);
    expect(offset.status).toBe(200);
    expect(calls).toEqual([
      'query:first',
      'projection:chat_1',
      'action:action_1',
      'offset:7',
    ]);

    const rawRecord = await fetch(`${baseUrl}/v1/records/chat_1`);
    expect(rawRecord.status).toBe(404);
  });

  it('maps invalid and stale cursor errors to stable HTTP statuses', async () => {
    const { baseUrl } = await fixtureServer();
    const invalid = await fetch(`${baseUrl}/v1/records/query?cursor=invalid`);
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
    const mismatch = await fetch(`${baseUrl}/v1/records/query?cursor=mismatch`);
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual(
      expect.objectContaining({ code: 'QUERY_CURSOR_MISMATCH' }),
    );
    const stale = await fetch(`${baseUrl}/v1/records/query?cursor=stale`);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual(
      expect.objectContaining({ code: 'STALE_QUERY_CURSOR' }),
    );
  });

  it('maps an unvalidated live session to a stable conflict response', async () => {
    const { baseUrl } = await fixtureServer({ liveSessionInvalid: true });
    const response = await fetch(`${baseUrl}/v1/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxRecords: 1, source: 'live' }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(
      expect.objectContaining({ code: 'SESSION_NOT_VALID' }),
    );
  });

  it('returns a stable sanitized session-validation failure', async () => {
    const { baseUrl } = await fixtureServer({
      validationError: {
        code: 'SESSION_SNAPSHOT_FAILED',
        message: '无法读取登录状态验证页。请重试。',
      },
    });
    const response = await fetch(`${baseUrl}/v1/session/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      code: 'SESSION_SNAPSHOT_FAILED',
      message: '无法读取登录状态验证页。请重试。',
    });
    expect(JSON.stringify(body)).not.toContain('Browser logs');
    expect(JSON.stringify(body)).not.toContain('browser-profile');
  });
});
