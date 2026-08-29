import { describe, expect, it } from 'vitest';

import { scoreModelIdMatch } from './model-id-search';

describe('model ID fuzzy search', () => {
  it('matches ordered shorthand against a longer model name', () => {
    expect(scoreModelIdMatch('moonshotai/kimi-k3', 'k3')).toBeGreaterThan(0);
    expect(scoreModelIdMatch('moonshotai/kimi-k3', 'KIMI K3')).toBeGreaterThan(
      0,
    );
  });

  it('ignores separators but rejects unrelated text', () => {
    expect(scoreModelIdMatch('moonshotai/kimi-k3', 'kimi.k3')).toBeGreaterThan(
      0,
    );
    expect(scoreModelIdMatch('moonshotai/kimi-k3', 'deepseek')).toBe(0);
  });
});
