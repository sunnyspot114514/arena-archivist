# web-archive-agent absorption record

`D:\Agent` is the only Arena Archivist product, runtime, and canonical repository. `D:\devspace\projects\web-archive-agent` was used as a read-only design donor. Nothing in Arena Archivist imports, launches, writes, or depends on that directory; it may be archived by the project owner.

## Capability mapping

| Donor concept/source | Absorbed implementation in `D:\Agent` | Decision |
| --- | --- | --- |
| `src/action-ledger.js` and action-event schema | `packages/archive-store/index.ts`: checksummed SQLite migrations, `action_ledger_actions`, append-only `action_ledger_events`, append-only `action_authorizations`, and `sync_record_commits` | Reimplemented in the canonical SQLite store. No JSONL/Map ledger or second truth source. |
| `src/archive-query.js` | `ArchiveStore.queryRecords`, `GET /v1/records/query`, Dashboard client, and DSH query reducer | Reimplemented as `(updated_at DESC, id ASC)` keyset pagination. Cursor binds query hash, catalog ID, generation, and last key; offset remains compatibility-only. |
| `src/model-router.js` | `packages/model-router/src/projection.ts` and `src/index.ts` | Replaced caller assertions with store-attested, deterministic, projection/source-record-ID and source/content/policy/projection/authorization-hashed envelopes. The envelope declares allowed/removed sensitivity classes; only its minimized payload is serialized at the local provider boundary. |
| `src/connectors.js` | `packages/archive-connectors` plus `packages/gray-swan-adapter/src/connector.ts` | Reimplemented as a frozen, read-only registry seam. Gray Swan wraps the existing parser/contract/validation code. |
| `src/collector-runtime.js` and `src/browser-runtime.js` | Existing `apps/runtime`, `packages/browser-worker`, and `packages/browser-policy` | Not copied. The existing guarded worker remains the only collection executor and no generic browser surface was added. |
| `src/archive-store.js` | Existing `packages/archive-store` | Donor file store rejected in favor of the existing TypeScript/SQLite canonical store and immutable content-addressed evidence. |
| `src/rate-limiter.js` | Existing `packages/rate-governor` | Donor implementation not copied; existing daily/run/cooldown budgets retained. |
| `src/policy.js` | Existing `packages/browser-policy` and stored policy decisions | Donor policy engine not copied; existing semantic/DOM/network fail-closed layers retained. |
| `src/normalizer.js` | Existing Gray Swan selector contract, parser, validation, and worker | Donor normalizer not copied. |
| `src/archive-exporter.js` | Existing `packages/exporter` | Donor exporter not copied; current allowlist and secret scan retained. |
| DSH example adapter | `packages/dsh-profile-arena` | Replaced by five narrow semantic tools with explicit output reducers; no shell, filesystem, web, or Playwright primitive. |

## Durable invariants added

- One authorized action is bound to one sync run and exact connector/policy identity.
- Authorization scope is derived locally; its hash binds action/run/request/policy/connector/principal/source/decision/time and is stored separately from outcomes.
- Arbitrary request bodies are never persisted in the ledger; only a fixed operation/source/count summary and hashes remain.
- Canonical records cannot commit before dispatch. Record/action/run link, counter, evidence references, and checkpoint share a transaction.
- Successful reconciliation requires the worker count, SQLite counter, and linked non-unchanged commits to match.
- Catalog changes invalidate outstanding cursors and attested model projections. Policy changes revoke already-created projections before provider dispatch.
- Provider calls cannot accept caller messages, `redacted: true`, cloned projections, or stale store attestations.

## Compatibility and intentionally retained behavior

- `GET /v1/records?limit=&offset=` remains available for older local clients; new clients use `/v1/records/query`.
- `GraySwanBrowserWorker`, Browser Guardian, Rate Governor, Archive Exporter, Dashboard, localhost API, and dedicated-profile login flow were extended rather than replaced.
- Schema v4 upgrades v3 databases under one immediate SQLite transaction, logically clears legacy request JSON, and adds separate authorization/link immutability controls. Schema v5 preserves the v4 checksum while validating existing action/run commit links and adding execution binding triggers. Historical v3 actions keep their original append-only authorization event and return no invented v4 authorization row; without that row they may only enter `blocked`, `failed`, or `cancelled`, never dispatch, successfully settle, or commit.
- Offline fixtures continue to exercise the same controller, connector, ledger, parser, commit, and recovery path without network access. In addition, a user-authorized read-only validation on 2026-08-30 exercised the bundled route-specific live v2 contract end to end: one Chat record reached `canonical_commit`, then local deterministic analysis and secret-scanned export completed. That validation found and fixed live DOM drift, an invalid ready selector, SPA hydration timing, optional telemetry classification, late policy-violation consumption, and browser-boundary cleanup/error sanitization. No Gray Swan submission or remote model call was made.

## Verification

The merge and self-review are accepted only after `npm test`, `npm run typecheck`, `npm run build`, `npm run secret-scan`, `npm run lint`, and `git diff --check` pass, and after tracked-path review confirms that dependencies, build output, runtime data, browser profiles, database files, and credentials are absent.
