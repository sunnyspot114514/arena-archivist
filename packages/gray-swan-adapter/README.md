# Gray Swan adapter

This package parses versioned, user-authorized HTML fixtures into local-only archive records. It
does not fetch a site, log in, click controls, submit content, or contain a live-DOM claim.

`contracts/grayswan.fixture-v1.json` is deliberately marked `fixture-baseline`. Before production
collection, create a new contract version from a small, manually captured and secret-scanned
fixture set. Promote its compatibility status only after the offline tests pass. Keep old
contracts so already archived evidence remains reproducible.

Each record kind also has an anchored href pattern. This is an action allowlist, not just a parsing
hint: a same-origin link outside the versioned detail-page shape is rejected.

The parser records every selector candidate used for every normalized field. Missing roots,
required fields, unknown record kinds, duplicate ids, and id mismatches all fail closed.

Public entry point: `src/index.ts`.

`src/connector.ts` supplies the first `ArchiveConnectorRegistry` registration facade. It delegates contract loading, parsing, blocker detection, and record validation to this package's existing functions. Collection remains owned by the existing guarded Gray Swan worker; the facade neither exposes Playwright nor implements a second worker.
