import { describe, expect, it } from 'vitest';
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
  ModelRouter,
  type AuthorizedModelProjection,
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

function attestation(
  level: DataPolicy,
  overrides: {
    externalProcessingAllowed?: boolean;
    embargoUntil?: string | null;
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
        title: 'Fixture',
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
    store.close();
    if (!value) throw new Error('fixture attestation missing');
    return value;
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}

function request(projection: AuthorizedModelProjection) {
  return { task: 'offline_review' as const, projection };
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
        providerBody = JSON.parse(String(init?.body)) as Record<
          string,
          unknown
        >;
        return new Response(
          JSON.stringify({
            id: 'request_1',
            choices: [{ message: { content: 'ok' } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    await router.complete({
      task: 'offline_review',
      routeId: 'direct',
      projection: createAuthorizedModelProjection(
        attestation('direct_provider_only'),
      ),
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
    expect(messages[1].content).toContain('authorized_model_projection');
    expect(messages[1].content).not.toContain('external_fixture');
  });
});
