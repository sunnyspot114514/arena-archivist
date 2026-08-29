# Read-only browser worker

This package supplies two deliberately different browser surfaces:

- On Windows, the runtime launches ordinary Edge or Chrome with a dedicated profile and three
  tabs for human authentication. It uses no Playwright connection or automation flags, so Google
  OAuth sees a full system browser. `openManualAuthBrowser()` remains a lifecycle-only fallback
  for platforms where a trusted native executable cannot be resolved.
- `openCollectBrowser()` returns only `navigate()`, `snapshot()`, policy-status consumption, and
  `close()`. No click, fill, keypress, evaluate, upload, download, or raw Playwright handle is
  exposed.

`GraySwanBrowserWorker.runNextBatch()` is the only collection workflow. It follows
`AUTH_CHECK -> INDEX_DISCOVERY -> OPEN_RECORD -> CAPTURE_RAW -> PARSE -> VALIDATE -> COMMIT ->
COOLDOWN`, caps batches/runs/time, stops on login/CAPTCHA/bot challenge/403/429, and advances a
checkpoint in the same atomic store call as the successful idempotent archive commit.
An optional `AbortSignal` pauses cooperatively at record/state boundaries and interrupts cooldown;
the owning runtime remains responsible for closing the browser in `finally`.

The network guardian permits GET/HEAD/OPTIONS. POST is denied unless its exact same-origin endpoint
is configured as GraphQL and every operation is visibly a query. Unknown persisted queries,
mutations, subscriptions, uploads, account changes, and cross-origin documents are denied and
stop collection. A DOM guard also blocks editable controls and form submission.

`demo/offline-demo.ts` runs the complete workflow over synthetic fixtures and never creates a
network client. `MemoryArchive` is for that demo only; production must inject a transactional local
archive implementation.

The Playwright port identifies itself as a live browser. A live worker refuses `fixture-baseline`,
`captured`, or `retired` selector contracts and requires a separately versioned `verified`
contract. This prevents the synthetic demo contract from being reused against a real site.

Public entry point: `src/index.ts`. Playwright is dependency-injected through
`PlaywrightRuntimeLike`; this package intentionally does not install it. Launch defaults to the
system `chrome` channel for `playwright-core`; `executablePath` can be supplied instead. The local
Windows runtime resolves the user's default supported Chromium browser, launches it natively for
AUTH_MODE, and uses its official Playwright channel only for COLLECT_MODE.
