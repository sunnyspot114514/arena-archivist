import { describe, expect, it } from 'vitest';

import {
  authorizeRoute,
  type CompletionRequest,
  type ProviderRoute,
  type RecordPolicy,
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

function policy(
  level: RecordPolicy['level'],
  overrides: Partial<RecordPolicy> = {},
): RecordPolicy {
  return {
    level,
    externalProcessingAllowed: true,
    embargoUntil: null,
    redactionVersion: 'v1',
    ...overrides,
  };
}

function request(
  recordPolicy: RecordPolicy,
  overrides: Partial<Pick<CompletionRequest, 'task' | 'redacted'>> = {},
) {
  return {
    task: 'offline_review' as const,
    redacted: false,
    recordPolicy,
    ...overrides,
  };
}

describe('data classification routing', () => {
  it('keeps local-only records off every external route', () => {
    expect(authorizeRoute(directRoute, request(policy('local_only')))).toEqual({
      allowed: false,
      reason: 'record_is_local_only',
    });
    expect(
      authorizeRoute(
        routerRoute,
        request(policy('local_only'), { redacted: true }),
      ),
    ).toEqual({
      allowed: false,
      reason: 'record_is_local_only',
    });
  });

  it('allows direct-provider-only records only through a direct provider', () => {
    expect(
      authorizeRoute(directRoute, request(policy('direct_provider_only')))
        .allowed,
    ).toBe(true);
    expect(
      authorizeRoute(
        routerRoute,
        request(policy('direct_provider_only'), { redacted: true }),
      ),
    ).toEqual({ allowed: false, reason: 'router_disallowed_by_record_policy' });
  });

  it('requires ZDR, disabled logging, and a redacted copy for router processing', () => {
    const routed = request(policy('zdr_router_allowed'), { redacted: true });
    expect(authorizeRoute(routerRoute, routed).allowed).toBe(true);
    expect(authorizeRoute(routerRoute, { ...routed, redacted: false })).toEqual(
      {
        allowed: false,
        reason: 'router_requires_redacted_copy',
      },
    );
    expect(
      authorizeRoute({ ...routerRoute, zeroDataRetention: false }, routed),
    ).toEqual({
      allowed: false,
      reason: 'router_privacy_requirements_not_met',
    });
    expect(
      authorizeRoute({ ...routerRoute, promptLogging: true }, routed),
    ).toEqual({
      allowed: false,
      reason: 'router_privacy_requirements_not_met',
    });
  });

  it('fails closed for disabled external processing and active or invalid embargoes', () => {
    const now = new Date('2026-08-29T00:00:00.000Z');
    expect(
      authorizeRoute(
        directRoute,
        request(policy('public', { externalProcessingAllowed: false })),
        now,
      ),
    ).toEqual({ allowed: false, reason: 'external_processing_not_allowed' });
    expect(
      authorizeRoute(
        directRoute,
        request(policy('public', { embargoUntil: '2026-08-30T00:00:00.000Z' })),
        now,
      ),
    ).toEqual({ allowed: false, reason: 'record_embargo_active' });
    expect(
      authorizeRoute(
        directRoute,
        request(policy('public', { embargoUntil: 'not-a-date' })),
        now,
      ),
    ).toEqual({ allowed: false, reason: 'record_embargo_active' });
  });
});
