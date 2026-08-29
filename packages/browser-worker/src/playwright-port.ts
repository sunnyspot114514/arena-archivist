import type { RawPageSnapshot } from '../../gray-swan-adapter/src/types.js';
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

interface PlaywrightLocatorLike {
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

// COLLECT_MODE pages receive this guard before any application script. It prevents form and
// editable-control interaction even if a later refactor accidentally wires a raw input event.
// The network policy remains the authoritative backstop for all writes.
export const COLLECT_MODE_DOM_GUARD = String.raw`(() => {
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
  ) {}

  noteViolation(decision: NetworkPolicyDecision): void {
    if (!decision.allowed && this.firstViolation === null)
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

  // Never restore old tabs into collection mode. The dedicated profile stores auth state, not
  // browsing work state, and collection always starts with one guarded page.
  await Promise.all(context.pages().map((page) => page.close()));
  await context.addInitScript(COLLECT_MODE_DOM_GUARD);
  const page = await context.newPage();
  context.on('page', (openedPage) => {
    if (openedPage !== page) void openedPage.close();
  });

  const browser = new PlaywrightCollectBrowser(
    policy.primaryOrigin,
    context,
    page,
    policy,
    config.navigationTimeoutMs ?? 30_000,
    config.now ?? (() => new Date()),
  );

  await context.route('**/*', async (route) => {
    const decision = policy.decide(requestDescriptor(route.request()));
    await config.onPolicyDecision?.(decision);
    if (decision.allowed) await route.continue();
    else {
      browser.noteViolation(decision);
      await route.abort('blockedbyclient');
    }
  });

  return browser;
}
