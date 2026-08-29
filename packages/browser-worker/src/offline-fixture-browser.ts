import type { RawPageSnapshot } from '../../gray-swan-adapter/src/types.js';
import type { CollectBrowserPort, NetworkPolicyDecision } from './types.js';

export interface OfflineFixturePage {
  readonly url: string;
  readonly title: string;
  readonly html: string;
  readonly visibleText: string;
  readonly responseStatus?: number;
}

/** A no-network browser port for parser demos and deterministic tests. */
export class OfflineFixtureBrowser implements CollectBrowserPort {
  readonly mode = 'COLLECT_MODE' as const;
  readonly runtimeKind = 'offline_fixture' as const;
  readonly primaryOrigin: string;
  private readonly pages: ReadonlyMap<string, OfflineFixturePage>;
  private current: OfflineFixturePage | null = null;

  constructor(
    pages: readonly OfflineFixturePage[],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (pages.length === 0)
      throw new Error('At least one fixture page is required');
    this.primaryOrigin = new URL(pages[0]!.url).origin;
    for (const page of pages) {
      if (new URL(page.url).origin !== this.primaryOrigin) {
        throw new Error('Offline fixtures must share one origin');
      }
    }
    this.pages = new Map(pages.map((page) => [new URL(page.url).href, page]));
  }

  async navigate(target: string): Promise<void> {
    const url = new URL(target, this.primaryOrigin);
    if (url.origin !== this.primaryOrigin)
      throw new Error('Offline fixture origin denied');
    const page = this.pages.get(url.href);
    if (!page) throw new Error(`No offline fixture for ${url.href}`);
    this.current = page;
  }

  async snapshot(): Promise<RawPageSnapshot> {
    if (!this.current)
      throw new Error('Navigate to an offline fixture before snapshotting');
    return {
      ...this.current,
      capturedAt: this.now().toISOString(),
    };
  }

  consumePolicyViolation(): NetworkPolicyDecision | null {
    return null;
  }

  async close(): Promise<void> {
    this.current = null;
  }
}
