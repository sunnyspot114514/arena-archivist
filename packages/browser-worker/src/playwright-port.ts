import { randomUUID } from 'node:crypto';

import type {
  IndexPreparationPlan,
  IndexPreparationStep,
  RawPageSnapshot,
  RecordKind,
} from '../../gray-swan-adapter/src/types.js';
import {
  CollectNetworkPolicy,
  type CollectNetworkPolicyConfig,
} from './network-policy.js';
import { assertDedicatedProfileDirectory } from './profile.js';
import type {
  CollectBrowserPort,
  ManualAuthSession,
  NetworkPolicyDecision,
  RequestDescriptor,
} from './types.js';

interface PlaywrightRequestLike {
  url(): string;
  method(): string;
  resourceType(): string;
  postData(): string | null;
  headers(): Record<string, string>;
}

interface PlaywrightRouteLike {
  request(): PlaywrightRequestLike;
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

interface PlaywrightResponseLike {
  status(): number;
}

interface PlaywrightElementHandleLike {
  click(): Promise<void>;
  dispose(): Promise<void>;
  evaluate<TResult, TArgument = undefined>(
    pageFunction: (element: HTMLElement, argument: TArgument) => TResult,
    argument?: TArgument,
  ): Promise<TResult>;
  innerText(): Promise<string>;
}

interface PlaywrightLocatorLike {
  all(): Promise<PlaywrightLocatorLike[]>;
  elementHandles(): Promise<PlaywrightElementHandleLike[]>;
  innerText(): Promise<string>;
}

interface PlaywrightPageLike {
  url(): string;
  goto(
    url: string,
    options?: {
      readonly waitUntil?: 'domcontentloaded';
      readonly timeout?: number;
    },
  ): Promise<PlaywrightResponseLike | null>;
  content(): Promise<string>;
  title(): Promise<string>;
  locator(selector: string): PlaywrightLocatorLike;
  evaluate?<TResult, TArgument>(
    pageFunction: (argument: TArgument) => TResult,
    argument: TArgument,
  ): Promise<TResult>;
  waitForEvent?(
    event: 'popup',
    options: { readonly timeout: number },
  ): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

interface PlaywrightContextLike {
  pages(): readonly PlaywrightPageLike[];
  newPage(): Promise<PlaywrightPageLike>;
  addInitScript(script: string): Promise<void>;
  route(
    pattern: string,
    handler: (route: PlaywrightRouteLike) => Promise<void>,
  ): Promise<void>;
  on(event: 'page', handler: (page: PlaywrightPageLike) => void): void;
  on(event: 'close', handler: () => void): void;
  close(): Promise<void>;
}

export const AUTH_MODE_INITIAL_PAGES = 2;
export const AUTH_MODE_MAX_PAGES = 3;

export interface PlaywrightRuntimeLike {
  readonly chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: {
        readonly headless: false;
        readonly acceptDownloads: false;
        readonly serviceWorkers: 'allow' | 'block';
        readonly channel?: string;
        readonly executablePath?: string;
        readonly env?: Record<string, string>;
      },
    ): Promise<PlaywrightContextLike>;
  };
}

const SECRET_ENV_NAME =
  /(?:^|[_-])(?:api[_-]?key|access[_-]?key|private[_-]?key|key|token|secret|password|passwd|credential|authorization|cookie)(?:$|[_-])/iu;

export function browserProcessEnvironment(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && !SECRET_ENV_NAME.test(entry[0]),
    ),
  );
}

export interface ManualAuthConfig {
  readonly profileDirectory: string;
  readonly startUrl: string;
  readonly channel?: string;
  readonly executablePath?: string;
}

export interface CollectBrowserConfig extends CollectNetworkPolicyConfig {
  readonly profileDirectory: string;
  readonly navigationTimeoutMs?: number;
  readonly channel?: string;
  readonly executablePath?: string;
  readonly onPolicyDecision?: (
    decision: NetworkPolicyDecision,
  ) => void | Promise<void>;
  readonly now?: () => Date;
}

const REVIEWED_INDEX_TRANSITIONS = [
  {
    intent: 'open_history_panel',
    selector: 'button[type=button]',
    expectedTextPattern: '^Chats\\s+\\d+$',
  },
  {
    intent: 'select_chat_tab',
    selector: 'div[role=dialog] button',
    expectedTextPattern: '^Chats\\s+\\(\\d+\\)$',
  },
] as const;
const REVIEWED_INDEX_READY_SELECTOR = 'div[role=dialog] a[href*="chatId="]';
const REVIEWED_CHAT_READY_SELECTORS = [
  'button[data-behavior-id][class*="bg-secondary"]',
  'div[data-testid="userMessage"]',
  'div[data-testid="assistantMessage"]',
] as const;

function assertReviewedIndexPreparation(plan: IndexPreparationPlan): void {
  if (
    plan.timeoutMs < 1 ||
    plan.timeoutMs > 30_000 ||
    plan.readySelector !== REVIEWED_INDEX_READY_SELECTOR ||
    plan.steps.length !== REVIEWED_INDEX_TRANSITIONS.length
  ) {
    throw new Error('Unreviewed read-only index preparation plan');
  }
  for (const [index, reviewed] of REVIEWED_INDEX_TRANSITIONS.entries()) {
    const step = plan.steps[index];
    if (
      !step ||
      step.intent !== reviewed.intent ||
      step.selector !== reviewed.selector ||
      step.expectedTextPattern !== reviewed.expectedTextPattern
    ) {
      throw new Error('Unreviewed read-only index preparation plan');
    }
  }
}

function isFatalNetworkDenial(
  decision: NetworkPolicyDecision,
  primaryOrigin: string,
): decision is Exclude<NetworkPolicyDecision, { allowed: true }> {
  if (decision.allowed) return false;
  const blockedTelemetry =
    decision.reason === 'graphql_endpoint_denied' &&
    decision.method === 'POST' &&
    decision.resourceType === 'fetch' &&
    decision.origin === primaryOrigin &&
    decision.endpointPath === '/ingest/flags/';
  return (
    !blockedTelemetry &&
    (decision.origin === primaryOrigin || decision.resourceType === 'document')
  );
}

// COLLECT_MODE pages receive this guard before any application script. It prevents form and
// editable-control interaction even if a later refactor accidentally wires a raw input event.
// The network policy remains the authoritative backstop for all writes.
export const COLLECT_MODE_DOM_GUARD = String.raw`(() => {
  const READ_ONLY_ACTION = 'data-arena-archivist-readonly-action';
  const READ_ONLY_TOKEN = '__ARENA_ARCHIVIST_READONLY_TOKEN__';
  const editable = (target) => target instanceof Element &&
    (target.matches('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  const blockEditableEvent = (event) => {
    if (editable(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  for (const type of ['beforeinput', 'input', 'change', 'paste', 'drop']) {
    document.addEventListener(type, blockEditableEvent, true);
  }
  document.addEventListener('keydown', (event) => {
    if (editable(event.target)) blockEditableEvent(event);
  }, true);
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest('a, button, input, textarea, select, [contenteditable], [role="button"], [role="link"]')
      : null;
    if (event.isTrusted && target?.getAttribute(READ_ONLY_ACTION) === READ_ONLY_TOKEN) return;
    if (target) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  const deny = () => { throw new DOMException('COLLECT_MODE is read-only', 'SecurityError'); };
  HTMLFormElement.prototype.submit = deny;
  HTMLFormElement.prototype.requestSubmit = deny;
})();`;

function requestDescriptor(request: PlaywrightRequestLike): RequestDescriptor {
  return {
    url: request.url(),
    method: request.method(),
    resourceType: request.resourceType(),
    postData: request.postData(),
    headers: request.headers(),
  };
}

function validateAuthStartUrl(startUrl: string): string {
  const url = new URL(startUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('AUTH_MODE start URL must be credential-free HTTPS');
  }
  return url.href;
}

function launchTarget(config: {
  readonly channel?: string;
  readonly executablePath?: string;
}): {
  readonly channel?: string;
  readonly executablePath?: string;
} {
  if (config.channel && config.executablePath) {
    throw new Error(
      'Configure either a browser channel or executablePath, not both',
    );
  }
  if (config.executablePath) return { executablePath: config.executablePath };
  // playwright-core does not download a bundled browser. System Chrome is the safe default for
  // the dedicated persistent profile on Windows/macOS/Linux installations that expose it.
  return { channel: config.channel ?? 'chrome' };
}

export async function openManualAuthBrowser(
  runtime: PlaywrightRuntimeLike,
  config: ManualAuthConfig,
): Promise<ManualAuthSession> {
  const profileDirectory = assertDedicatedProfileDirectory(
    config.profileDirectory,
  );
  const startUrl = validateAuthStartUrl(config.startUrl);
  const context = await runtime.chromium.launchPersistentContext(
    profileDirectory,
    {
      headless: false,
      acceptDownloads: false,
      serviceWorkers: 'allow',
      env: browserProcessEnvironment(),
      ...launchTarget(config),
    },
  );
  // Reuse one page from the persistent context. Closing every page can make Chromium
  // immediately create a replacement window; creating another primary page after that
  // races with the replacement and leaves AUTH_MODE with three pages on first launch.
  const [restoredPrimaryPage, ...restoredExtraPages] = context.pages();
  await Promise.all(restoredExtraPages.map((page) => page.close()));
  const navigateForHumanLogin = (page: PlaywrightPageLike): void => {
    // AUTH_MODE hands control to the human as soon as the page exists. A slow identity
    // provider must not keep the local API request pending or make the browser look closed.
    void page
      .goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      .catch(() => undefined);
  };
  const createLoginPage = async (): Promise<PlaywrightPageLike> => {
    if (context.pages().length >= AUTH_MODE_MAX_PAGES) {
      throw new Error(
        `AUTH_MODE allows at most ${AUTH_MODE_MAX_PAGES} login pages`,
      );
    }
    const page = await context.newPage();
    navigateForHumanLogin(page);
    return page;
  };
  const openLoginPage = async (): Promise<void> => {
    await createLoginPage();
  };
  context.on('page', (openedPage) => {
    if (context.pages().length > AUTH_MODE_MAX_PAGES) {
      void openedPage.close();
    }
  });
  const primaryPage = restoredPrimaryPage ?? (await context.newPage());
  let secondaryPage = context.pages().find((page) => page !== primaryPage);
  if (!secondaryPage && primaryPage.evaluate && primaryPage.waitForEvent) {
    try {
      const popup = primaryPage.waitForEvent('popup', { timeout: 2_000 });
      void popup.catch(() => undefined);
      const opened = await primaryPage.evaluate(
        (url) =>
          Boolean(
            window.open(
              url,
              'arena-archivist-auth-secondary',
              'popup=yes,width=1100,height=820,left=80,top=80',
            ),
          ),
        'about:blank',
      );
      if (!opened) throw new Error('Secondary auth window was blocked');
      secondaryPage = await popup;
    } catch {
      // page.popup is emitted after the popup's initial request begins loading. If that event
      // times out after Chromium already created the Page, reuse it instead of opening page #3.
      secondaryPage = context.pages().find((page) => page !== primaryPage);
    }
  }
  navigateForHumanLogin(primaryPage);
  if (secondaryPage) navigateForHumanLogin(secondaryPage);
  else if (context.pages().length < AUTH_MODE_INITIAL_PAGES)
    await openLoginPage();

  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  context.on('close', () => resolveClosed?.());

  // No Page, Context, click, fill, press, evaluate or upload handle escapes AUTH_MODE.
  return {
    mode: 'AUTH_MODE',
    profileDirectory,
    browserOpen: true,
    pageCount: () => context.pages().length,
    openLoginPage,
    waitForClose: () => closed,
    close: () => context.close(),
  };
}

class PlaywrightCollectBrowser implements CollectBrowserPort {
  readonly mode = 'COLLECT_MODE' as const;
  readonly runtimeKind = 'live_browser' as const;
  private lastResponseStatus: number | undefined;
  private firstViolation: NetworkPolicyDecision | null = null;

  constructor(
    readonly primaryOrigin: string,
    private readonly context: PlaywrightContextLike,
    private readonly page: PlaywrightPageLike,
    private readonly policy: CollectNetworkPolicy,
    private readonly navigationTimeoutMs: number,
    private readonly now: () => Date,
    private readonly readOnlyActionToken: string,
  ) {}

  noteViolation(decision: NetworkPolicyDecision): void {
    // A denied third-party subresource is already aborted and cannot mutate Gray Swan. Keep it
    // in the audit trail, but only fail the run for primary-origin or document-level denials.
    // Gray Swan reverse-proxies optional PostHog traffic under /ingest/; it remains blocked and
    // audited, but a failed analytics beacon must not invalidate a successfully parsed archive.
    if (
      this.firstViolation === null &&
      isFatalNetworkDenial(decision, this.primaryOrigin)
    )
      this.firstViolation = decision;
  }

  async navigate(target: string): Promise<void> {
    const absolute = new URL(target, this.primaryOrigin).href;
    const decision = this.policy.decide({
      url: absolute,
      method: 'GET',
      resourceType: 'document',
      postData: null,
    });
    if (!decision.allowed) {
      this.noteViolation(decision);
      throw new Error(
        `Navigation denied by collect policy: ${decision.reason}`,
      );
    }
    const response = await this.page.goto(absolute, {
      waitUntil: 'domcontentloaded',
      timeout: this.navigationTimeoutMs,
    });
    this.lastResponseStatus = response?.status();
  }

  async prepareIndex(plan: IndexPreparationPlan): Promise<void> {
    assertReviewedIndexPreparation(plan);
    const deadline = Date.now() + plan.timeoutMs;
    for (const step of plan.steps) {
      const target = await this.findPreparationTarget(step, deadline);
      try {
        const prepared = await target.evaluate(
          (element, input) => {
            const normalizedText = (element.innerText ?? '')
              .replace(/\s+/g, ' ')
              .trim();
            const rawType = element.getAttribute('type');
            const normalizedType = rawType?.toLowerCase() ?? null;
            const button = element as HTMLButtonElement;
            const eligible =
              element.tagName.toLowerCase() === 'button' &&
              new RegExp(input.expectedTextPattern, 'u').test(normalizedText) &&
              element.getAttribute('disabled') === null &&
              element.getAttribute('aria-disabled') !== 'true' &&
              (normalizedType === 'button' ||
                (rawType === null && button.form === null));
            if (eligible) {
              element.setAttribute(
                'data-arena-archivist-readonly-action',
                input.token,
              );
            }
            return eligible;
          },
          {
            token: this.readOnlyActionToken,
            expectedTextPattern: step.expectedTextPattern,
          },
        );
        if (!prepared) {
          throw new Error(`Read-only index transition denied: ${step.intent}`);
        }
        try {
          await target.click();
        } finally {
          try {
            await target.evaluate((element) =>
              element.removeAttribute('data-arena-archivist-readonly-action'),
            );
          } catch {
            // A successful transition may detach its trigger. The marker is scoped
            // to that detached node and cannot authorize another action.
          }
        }
      } finally {
        try {
          await target.dispose();
        } catch {
          // Context cleanup will release an already-detached handle.
        }
      }
    }
    await this.waitForSelector(plan.readySelector, deadline);
  }

  async waitForRecordReady(kind: RecordKind): Promise<void> {
    if (kind !== 'chat') {
      throw new Error(
        `Live record readiness is not reviewed for kind: ${kind}`,
      );
    }
    const deadline = Date.now() + Math.min(this.navigationTimeoutMs, 10_000);
    for (const selector of REVIEWED_CHAT_READY_SELECTORS) {
      await this.waitForSelector(selector, deadline);
    }
  }

  private async findPreparationTarget(
    step: IndexPreparationStep,
    deadline: number,
  ): Promise<PlaywrightElementHandleLike> {
    const expected = new RegExp(step.expectedTextPattern, 'u');
    while (Date.now() <= deadline) {
      // ElementHandles pin identity. Locator.all() entries are live and can resolve to a
      // different node after a Svelte list reorder between text inspection and click.
      const candidates = await this.page
        .locator(step.selector)
        .elementHandles();
      const matches: PlaywrightElementHandleLike[] = [];
      for (const candidate of candidates) {
        let text = '';
        try {
          text = (await candidate.innerText()).replace(/\s+/g, ' ').trim();
        } catch {
          await candidate.dispose().catch(() => undefined);
          continue;
        }
        if (expected.test(text)) matches.push(candidate);
        else await candidate.dispose().catch(() => undefined);
      }
      if (matches.length === 1) return matches[0]!;
      if (matches.length > 1) {
        await Promise.all(
          matches.map((candidate) =>
            candidate.dispose().catch(() => undefined),
          ),
        );
        throw new Error(
          `Read-only index transition is ambiguous: ${step.intent}`,
        );
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error(`Read-only index transition timed out: ${step.intent}`);
  }

  private async waitForSelector(
    selector: string,
    deadline: number,
  ): Promise<void> {
    while (Date.now() <= deadline) {
      if ((await this.page.locator(selector).all()).length > 0) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    throw new Error('Read-only archive index did not become ready');
  }

  async snapshot(): Promise<RawPageSnapshot> {
    let visibleText = '';
    try {
      visibleText = await this.page.locator('body').innerText();
    } catch {
      // An empty/missing body is passed to the parser and fails closed there.
    }
    return {
      url: this.page.url(),
      title: await this.page.title(),
      html: await this.page.content(),
      visibleText,
      capturedAt: this.now().toISOString(),
      ...(this.lastResponseStatus === undefined
        ? {}
        : { responseStatus: this.lastResponseStatus }),
    };
  }

  consumePolicyViolation(): NetworkPolicyDecision | null {
    const violation = this.firstViolation;
    this.firstViolation = null;
    return violation;
  }

  close(): Promise<void> {
    return this.context.close();
  }
}

export async function openCollectBrowser(
  runtime: PlaywrightRuntimeLike,
  config: CollectBrowserConfig,
): Promise<CollectBrowserPort> {
  const profileDirectory = assertDedicatedProfileDirectory(
    config.profileDirectory,
  );
  const policy = new CollectNetworkPolicy(config);
  const context = await runtime.chromium.launchPersistentContext(
    profileDirectory,
    {
      headless: false,
      acceptDownloads: false,
      serviceWorkers: 'block',
      env: browserProcessEnvironment(),
      ...launchTarget(config),
    },
  );
  try {
    let browser: PlaywrightCollectBrowser | null = null;
    let startupViolation: NetworkPolicyDecision | null = null;
    await context.route('**/*', async (route) => {
      const decision = policy.decide(requestDescriptor(route.request()));
      await config.onPolicyDecision?.(decision);
      if (decision.allowed) await route.continue();
      else {
        if (browser) browser.noteViolation(decision);
        else if (
          startupViolation === null &&
          isFatalNetworkDenial(decision, policy.primaryOrigin)
        ) {
          startupViolation = decision;
        }
        await route.abort('blockedbyclient');
      }
    });

    // Never restore old tabs into collection mode. The dedicated profile stores auth state, not
    // browsing work state, and collection always starts with one guarded page.
    const readOnlyActionToken = randomUUID();
    await context.addInitScript(
      COLLECT_MODE_DOM_GUARD.replace(
        '__ARENA_ARCHIVIST_READONLY_TOKEN__',
        readOnlyActionToken,
      ),
    );
    await Promise.all(
      context.pages().map((restoredPage) => restoredPage.close()),
    );
    const page = await context.newPage();
    context.on('page', (openedPage) => {
      if (openedPage === page) return;
      browser?.noteViolation({
        allowed: false,
        reason: 'origin_denied',
        method: 'OPEN',
        origin: null,
        resourceType: 'document',
      });
      void openedPage.close().catch(() => {
        browser?.noteViolation({
          allowed: false,
          reason: 'origin_denied',
          method: 'OPEN',
          origin: null,
          resourceType: 'document',
        });
      });
    });

    browser = new PlaywrightCollectBrowser(
      policy.primaryOrigin,
      context,
      page,
      policy,
      config.navigationTimeoutMs ?? 30_000,
      config.now ?? (() => new Date()),
      readOnlyActionToken,
    );
    if (startupViolation) browser.noteViolation(startupViolation);

    // Closing the last restored tab may make Chromium create a replacement page. The listener
    // above catches future pages; this second sweep closes any replacement created before the
    // listener was installed and fails closed if it cannot be released.
    const replacementPages = context
      .pages()
      .filter((candidate) => candidate !== page);
    for (const replacementPage of replacementPages) {
      await replacementPage.close();
    }
    if (context.pages().some((candidate) => candidate !== page)) {
      throw new Error(
        'Unexpected browser page survived collection initialization',
      );
    }

    // A popup may have arrived while the final sweep yielded. Let its close handler settle and
    // verify the invariant one more time before exposing the browser port.
    await Promise.resolve();
    if (context.pages().some((candidate) => candidate !== page)) {
      throw new Error(
        'Unexpected browser page survived collection initialization',
      );
    }

    if (browser.consumePolicyViolation()) {
      throw new Error('Collection initialization encountered a denied request');
    }

    return browser;
  } catch (error) {
    // A persistent context owns the profile lock as soon as launch succeeds. Initialization
    // failures must not strand that lock; cleanup is best effort and never hides the root error.
    try {
      await context.close();
    } catch {
      // The original initialization failure is the actionable error.
    }
    throw error;
  }
}
