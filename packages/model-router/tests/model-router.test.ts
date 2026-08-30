import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  AttestedArchiveRecord,
  DataPolicy,
} from '../../archive-store/index';
import { ArchiveStore } from '../../archive-store/index';
import {
  OpaqueCredentialHandle,
  type AuthBroker,
  type CredentialExecutor,
} from '../../auth-broker/src/index';
import {
  authorizeRoute,
  createAuthorizedModelProjection,
  DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
  defaultProviderRoutes,
  MAX_MODEL_REQUEST_TIMEOUT_MS,
  ModelRouter,
  NVIDIA_MODEL_REQUEST_TIMEOUT_MS,
  type AuthorizedModelProjection,
  type CompletionRequest,
  type ProviderRoute,
} from '../src/index';

const directRoute: ProviderRoute = {
  id: 'direct',
  provider: 'fixture-direct',
  kind: 'direct',
  baseUrl: 'https://direct.invalid/v1',
  model: 'fixture-model',
  connectionId: 'direct',
  allowedTasks: ['offline_review'],
  zeroDataRetention: false,
  promptLogging: true,
  enabled: true,
};

const routerRoute: ProviderRoute = {
  ...directRoute,
  id: 'router',
  provider: 'fixture-router',
  kind: 'router',
  connectionId: 'router',
  zeroDataRetention: true,
  promptLogging: false,
};

const fixtureCleanups: Array<() => void> = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of fixtureCleanups.splice(0).reverse()) cleanup();
});

function attestation(
  level: DataPolicy,
  overrides: {
    externalProcessingAllowed?: boolean;
    embargoUntil?: string | null;
    title?: string;
  } = {},
): AttestedArchiveRecord {
  const directory = mkdtempSync(join(tmpdir(), 'arena-model-router-'));
  try {
    const store = new ArchiveStore({
      databasePath: ':memory:',
      evidenceDirectory: join(directory, 'evidence'),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });
    const committed = store.commitRecord({
      record: {
        kind: 'chat',
        platform: 'gray-swan-fixture',
        externalId: 'external_fixture',
        title: overrides.title ?? 'Fixture',
        status: 'complete',
        normalized: {},
        dataPolicy: level,
        externalProcessingAllowed:
          overrides.externalProcessingAllowed ?? level !== 'local_only',
        embargoUntil: overrides.embargoUntil ?? null,
      },
      evidence: [
        { artifactType: 'page_html', content: '<html>fixture</html>' },
      ],
      checkpoint: { scope: 'fixture', cursor: 'fixture', expectedVersion: 0 },
    });
    const value = store.attestRecord(committed.recordId);
    if (!value) throw new Error('fixture attestation missing');
    fixtureCleanups.push(() => {
      store.close();
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    });
    return value;
  } catch (error) {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
    throw error;
  }
}

function request(projection: AuthorizedModelProjection) {
  return { task: 'offline_review' as const, projection };
}

function connectedAuth(): AuthBroker & CredentialExecutor {
  return {
    status: async () => ({
      provider: 'fixture-direct',
      connectionId: 'direct',
      status: 'connected',
    }),
    begin: async () => ({ status: 'connected' }),
    disconnect: async () => undefined,
    resolveCredential: async () =>
      new OpaqueCredentialHandle('direct', 'fixture-direct'),
    withCredential: async <T>(
      _handle: OpaqueCredentialHandle,
      operation: (secret: string) => Promise<T>,
    ) => operation('fixture-secret'),
  };
}

describe('data classification routing', () => {
  it('keeps local-only records off every external route', () => {
    const projection = createAuthorizedModelProjection(
      attestation('local_only'),
    );
    expect(authorizeRoute(directRoute, request(projection))).toEqual({
      allowed: false,
      reason: 'record_is_local_only',
    });
    expect(authorizeRoute(routerRoute, request(projection))).toEqual({
      allowed: false,
      reason: 'record_is_local_only',
    });
  });

  it('allows direct-provider-only records only through a direct provider', () => {
    const projection = createAuthorizedModelProjection(
      attestation('direct_provider_only'),
    );
    expect(authorizeRoute(directRoute, request(projection)).allowed).toBe(true);
    expect(authorizeRoute(routerRoute, request(projection))).toEqual({
      allowed: false,
      reason: 'router_disallowed_by_record_policy',
    });
  });

  it('requires ZDR, disabled logging, and a locally generated projection for routers', () => {
    const projection = createAuthorizedModelProjection(
      attestation('zdr_router_allowed'),
    );
    expect(authorizeRoute(routerRoute, request(projection)).allowed).toBe(true);
    const forged = structuredClone(projection) as AuthorizedModelProjection;
    expect(authorizeRoute(routerRoute, request(forged))).toEqual({
      allowed: false,
      reason: 'projection_not_locally_authorized',
    });
    expect(
      authorizeRoute(
        { ...routerRoute, zeroDataRetention: false },
        request(projection),
      ),
    ).toEqual({
      allowed: false,
      reason: 'router_privacy_requirements_not_met',
    });
    expect(
      authorizeRoute(
        { ...routerRoute, promptLogging: true },
        request(projection),
      ),
    ).toEqual({
      allowed: false,
      reason: 'router_privacy_requirements_not_met',
    });
  });

  it('fails closed for disabled external processing and active embargoes', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    const disabled = createAuthorizedModelProjection(
      attestation('public', { externalProcessingAllowed: false }),
    );
    expect(authorizeRoute(directRoute, request(disabled), now)).toEqual({
      allowed: false,
      reason: 'external_processing_not_allowed',
    });
    const embargoed = createAuthorizedModelProjection(
      attestation('public', {
        embargoUntil: '2026-08-30T00:00:00.000Z',
      }),
    );
    expect(authorizeRoute(directRoute, request(embargoed), now)).toEqual({
      allowed: false,
      reason: 'record_embargo_active',
    });
  });

  it('rejects route configuration that could override projection messages', () => {
    expect(
      () =>
        new ModelRouter({
          routes: [
            {
              ...directRoute,
              additionalBody: {
                messages: [{ role: 'user', content: 'raw caller content' }],
              },
            },
          ],
          auth: {} as never,
        }),
    ).toThrow(/protected body field: messages/);
    expect(
      () =>
        new ModelRouter({
          routes: [
            {
              ...directRoute,
              additionalBody: { stream: true },
            },
          ],
          auth: {} as never,
        }),
    ).toThrow(/protected body field: stream/);
    expect(
      () =>
        new ModelRouter({
          routes: [
            {
              ...directRoute,
              additionalHeaders: { accept: 'text/event-stream' },
            },
          ],
          auth: {} as never,
        }),
    ).toThrow(/protected header: accept/);
  });

  it('keeps the normal timeout narrow and validates slow-route overrides', () => {
    const router = new ModelRouter({
      routes: [directRoute],
      auth: {} as never,
    });
    expect(router.listRoutes()[0]?.requestTimeoutMs).toBe(
      DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    );
    expect(DEFAULT_MODEL_REQUEST_TIMEOUT_MS).toBe(60_000);

    for (const requestTimeoutMs of [
      0,
      1.5,
      Number.POSITIVE_INFINITY,
      MAX_MODEL_REQUEST_TIMEOUT_MS + 1,
    ]) {
      expect(
        () =>
          new ModelRouter({
            routes: [{ ...directRoute, requestTimeoutMs }],
            auth: {} as never,
          }),
      ).toThrow(/requestTimeoutMs must be an integer/);
    }
    expect(
      () =>
        new ModelRouter({
          routes: [
            { ...directRoute, streamResponse: 'true' as never },
          ],
          auth: {} as never,
        }),
    ).toThrow(/streamResponse must be a boolean/);
  });

  it('gives the default NVIDIA route a fifteen-minute deadline', () => {
    const nvidiaRoute = defaultProviderRoutes().find(
      (route) => route.id === 'nvidia-direct',
    );
    expect(nvidiaRoute?.requestTimeoutMs).toBe(
      NVIDIA_MODEL_REQUEST_TIMEOUT_MS,
    );
    expect(NVIDIA_MODEL_REQUEST_TIMEOUT_MS).toBe(15 * 60_000);
    expect(nvidiaRoute?.streamResponse).toBe(true);
  });

  it('consumes streamed content across SSE and transport chunk boundaries', async () => {
    let providerBody: Record<string, unknown> | null = null;
    const encoder = new TextEncoder();
    const router = new ModelRouter({
      routes: [{ ...directRoute, streamResponse: true }],
      auth: connectedAuth(),
      fetchImpl: async (_url, init) => {
        if (typeof init?.body !== 'string') {
          throw new Error('provider request body must be a string');
        }
        providerBody = JSON.parse(init.body) as Record<string, unknown>;
        expect(new Headers(init.headers).get('accept')).toBe(
          'text/event-stream',
        );
        const chunks = [
          'data: {"id":"stream_1","choices":[{"delta":{"reasoning_content":"thinking"}}]}\r',
          '\n\r\ndata: {"id":"stream_1","choices":[{"delta":{"content":"NVIDIA_',
          'API_OK"}}]}\n\ndata: [DONE]\n\n',
        ];
        return new Response(
          new ReadableStream({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        );
      },
    });
    const result = await router.complete({
      task: 'offline_review',
      routeId: 'direct',
      projection: createAuthorizedModelProjection(
        attestation('direct_provider_only'),
      ),
    });

    expect(providerBody).toMatchObject({ stream: true });
    expect(result).toMatchObject({
      content: 'NVIDIA_API_OK',
      requestId: 'stream_1',
    });
  });

  it('rejects a truncated provider event stream', async () => {
    const router = new ModelRouter({
      routes: [{ ...directRoute, streamResponse: true }],
      auth: connectedAuth(),
      fetchImpl: async () =>
        new Response(
          'data: {"id":"stream_1","choices":[{"delta":{"content":"partial"}}]}\n\n',
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    });

    await expect(
      router.complete({
        task: 'offline_review',
        routeId: 'direct',
        projection: createAuthorizedModelProjection(
          attestation('direct_provider_only'),
        ),
      }),
    ).rejects.toThrow('Provider event stream ended before [DONE]');
  });

  it('cancels the provider body when an SSE event is invalid', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const router = new ModelRouter({
      routes: [{ ...directRoute, streamResponse: true }],
      auth: connectedAuth(),
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode('data: not-json\n\n'));
            },
            cancel() {
              cancelled = true;
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          },
        ),
    });

    await expect(
      router.complete({
        task: 'offline_review',
        routeId: 'direct',
        projection: createAuthorizedModelProjection(
          attestation('direct_provider_only'),
        ),
      }),
    ).rejects.toThrow('Provider returned invalid event-stream JSON');
    expect(cancelled).toBe(true);
  });

  it('rejects an oversized SSE frame before parsing it', async () => {
    const router = new ModelRouter({
      routes: [{ ...directRoute, streamResponse: true }],
      auth: connectedAuth(),
      fetchImpl: async () =>
        new Response(`data: ${'x'.repeat(1_000_001)}\n\n`, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    });

    await expect(
      router.complete({
        task: 'offline_review',
        routeId: 'direct',
        projection: createAuthorizedModelProjection(
          attestation('direct_provider_only'),
        ),
      }),
    ).rejects.toThrow('Provider event-stream frame exceeded the safe limit');
  });

  it('reports an empty non-success provider response without a JSON parse leak', async () => {
    const router = new ModelRouter({
      routes: [directRoute],
      auth: connectedAuth(),
      fetchImpl: async () => new Response(null, { status: 504 }),
    });

    await expect(
      router.complete({
        task: 'offline_review',
        routeId: 'direct',
        projection: createAuthorizedModelProjection(
          attestation('direct_provider_only'),
        ),
      }),
    ).rejects.toThrow('Provider request failed (504): empty response');
  });

  it('builds the provider body only from the verified projection', async () => {
    let providerBody: Record<string, unknown> | null = null;
    const auth: AuthBroker & CredentialExecutor = {
      status: async () => ({
        provider: 'fixture-direct',
        connectionId: 'direct',
        status: 'connected',
      }),
      begin: async () => ({ status: 'connected' }),
      disconnect: async () => undefined,
      resolveCredential: async () =>
        new OpaqueCredentialHandle('direct', 'fixture-direct'),
      withCredential: async <T>(
        _handle: OpaqueCredentialHandle,
        operation: (secret: string) => Promise<T>,
      ) => operation('fixture-secret'),
    };
    const router = new ModelRouter({
      routes: [directRoute],
      auth,
      fetchImpl: async (_url, init) => {
        const requestBody = init?.body;
        expect(typeof requestBody).toBe('string');
        if (typeof requestBody !== 'string') {
          throw new Error('provider request body must be a string');
        }
        providerBody = JSON.parse(requestBody) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'request_1',
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const projection = createAuthorizedModelProjection(
      attestation('direct_provider_only'),
    );
    await router.complete({
      task: 'offline_review',
      routeId: 'direct',
      projection,
    });
    const captured = providerBody as Record<string, unknown> | null;
    if (!captured) throw new Error('provider body was not captured');
    const messages = captured.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain(
      'authorized redacted archive projection',
    );
    expect(messages[1].content).toContain('sensitivity');
    expect(messages[1].content).not.toContain('authorized_model_projection');
    expect(messages[1].content).not.toContain(projection.sourceHash);
    expect(messages[1].content).not.toContain(projection.projectionHash);
    expect(messages[1].content).not.toContain(
      projection.authorization.authorizationHash,
    );
    expect(messages[1].content).not.toContain('external_fixture');
  });

  it('snapshots the authorized projection and route across credential awaits', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    let resolveCredentialWait: (() => void) | undefined;
    const credentialWait = new Promise<void>((resolve) => {
      resolveCredentialWait = resolve;
    });
    let credentialRequested: (() => void) | undefined;
    const credentialRequestedPromise = new Promise<void>((resolve) => {
      credentialRequested = resolve;
    });
    let requestedUrl = '';
    let requestedAccept = '';
    let providerBody: Record<string, unknown> | null = null;
    const auth: AuthBroker & CredentialExecutor = {
      status: async () => ({
        provider: 'fixture-direct',
        connectionId: 'direct',
        status: 'connected',
      }),
      begin: async () => ({ status: 'connected' }),
      disconnect: async () => undefined,
      resolveCredential: async () => {
        credentialRequested?.();
        await credentialWait;
        return new OpaqueCredentialHandle('direct', 'fixture-direct');
      },
      withCredential: async <T>(
        _handle: OpaqueCredentialHandle,
        operation: (secret: string) => Promise<T>,
      ) => operation('fixture-secret'),
    };
    const mutableRoute: ProviderRoute = {
      ...directRoute,
      requestTimeoutMs: 123_456,
      streamResponse: false,
      additionalBody: { routeMarker: 'authorized-route' },
    };
    const router = new ModelRouter({
      routes: [mutableRoute],
      auth,
      fetchImpl: async (url, init) => {
        requestedUrl =
          typeof url === 'string'
            ? url
            : url instanceof URL
              ? url.href
              : url.url;
        requestedAccept = new Headers(init?.headers).get('accept') ?? '';
        const requestBody = init?.body;
        if (typeof requestBody !== 'string') {
          throw new Error('provider request body must be a string');
        }
        providerBody = JSON.parse(requestBody) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: 'request_snapshot',
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const allowed = createAuthorizedModelProjection(
      attestation('direct_provider_only', { title: 'AUTHORIZED_CONTENT' }),
    );
    const denied = createAuthorizedModelProjection(
      attestation('local_only', { title: 'LOCAL_ONLY_MUST_NOT_LEAK' }),
    );
    const mutableRequest: CompletionRequest = {
      task: 'offline_review',
      routeId: 'direct',
      projection: allowed,
      temperature: 0.25,
    };

    const completion = router.complete(mutableRequest);
    await credentialRequestedPromise;
    mutableRequest.projection = denied;
    mutableRequest.temperature = 0.9;
    mutableRoute.baseUrl = 'https://credential-thief.invalid/v1';
    mutableRoute.model = 'mutated-model';
    mutableRoute.requestTimeoutMs = 1;
    mutableRoute.streamResponse = true;
    mutableRoute.additionalBody = {
      messages: [{ role: 'user', content: 'route injection' }],
      routeMarker: 'mutated-route',
    };
    resolveCredentialWait?.();
    await completion;

    expect(requestedUrl).toBe('https://direct.invalid/v1/chat/completions');
    expect(requestedAccept).toBe('application/json');
    const captured = providerBody as Record<string, unknown> | null;
    if (!captured) throw new Error('provider body was not captured');
    expect(captured.model).toBe('fixture-model');
    expect(captured.temperature).toBe(0.25);
    expect(captured.routeMarker).toBe('authorized-route');
    expect(captured).not.toHaveProperty('stream');
    expect(timeoutSpy).toHaveBeenCalledWith(123_456);
    expect(JSON.stringify(captured)).toContain('AUTHORIZED_CONTENT');
    expect(JSON.stringify(captured)).not.toContain('LOCAL_ONLY_MUST_NOT_LEAK');
    expect(JSON.stringify(captured)).not.toContain('route injection');
  });
});
