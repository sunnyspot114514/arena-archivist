import { describe, expect, it } from 'vitest';

import type { ArenaRuntimeStatus } from './arena-runtime';
import { resolveLiveFlowState, syncSourceForLiveFlow } from './live-flow';

const browser = (
  overrides: Partial<ArenaRuntimeStatus['browser']> = {},
): ArenaRuntimeStatus['browser'] => ({
  mode: 'PAUSED_HUMAN_AUTH',
  session: 'unknown',
  authBrowserOpen: false,
  authPageCount: 0,
  liveCollectionEnabled: true,
  selectorContract: 'verified',
  lastValidatedAt: null,
  ...overrides,
});

describe('live collection UI gate', () => {
  it('falls back to the offline demo until live configuration is verified', () => {
    expect(resolveLiveFlowState(null)).toBe('demo');
    expect(
      resolveLiveFlowState(browser({ liveCollectionEnabled: false })),
    ).toBe('demo');
    expect(
      resolveLiveFlowState(browser({ selectorContract: 'fixture-baseline' })),
    ).toBe('demo');
  });

  it('requires browser close, validation, and then allows live sync', () => {
    expect(resolveLiveFlowState(browser({ authBrowserOpen: true }))).toBe(
      'close-auth-browser',
    );
    expect(resolveLiveFlowState(browser())).toBe('validate-session');
    expect(resolveLiveFlowState(browser({ session: 'invalid' }))).toBe(
      'validate-session',
    );
    expect(resolveLiveFlowState(browser({ session: 'valid' }))).toBe('ready');
  });

  it('keeps the offline demo available until live collection is ready', () => {
    expect(syncSourceForLiveFlow('demo')).toBe('demo');
    expect(syncSourceForLiveFlow('close-auth-browser')).toBe('demo');
    expect(syncSourceForLiveFlow('validate-session')).toBe('demo');
    expect(syncSourceForLiveFlow('ready')).toBe('live');
  });
});
