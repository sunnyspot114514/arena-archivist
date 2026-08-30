import type { ArenaRuntimeStatus } from './arena-runtime';

export type LiveFlowState =
  | 'demo'
  | 'close-auth-browser'
  | 'validate-session'
  | 'ready';

export function resolveLiveFlowState(
  browser: ArenaRuntimeStatus['browser'] | null | undefined,
): LiveFlowState {
  if (
    !browser?.liveCollectionEnabled ||
    browser.selectorContract !== 'verified'
  ) {
    return 'demo';
  }
  if (browser.authBrowserOpen) return 'close-auth-browser';
  if (browser.session !== 'valid') return 'validate-session';
  return 'ready';
}

export function syncSourceForLiveFlow(state: LiveFlowState): 'demo' | 'live' {
  return state === 'ready' ? 'live' : 'demo';
}
