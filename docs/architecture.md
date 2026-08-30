# Arena Archivist architecture

Arena Archivist is a localhost-only personal archive and replay runtime for records the user is already authorized to view. `D:\Agent` is the only product and canonical codebase. The first connector is Gray Swan; collection is read-only, manually started, single-concurrency, and has no submission capability.

## Trust boundaries

```text
User
  │ manual login / bounded loopback semantic request
  ▼
Dashboard or DSH (localhost semantic operations only)
  │
  ▼
Runtime API
  ├── ArchiveConnectorRegistry ── Gray Swan connector metadata + typed adapter
  ├── Action ledger ───────────── run/action authorization and terminal history
  ├── Archive store ───────────── normalized SQLite + immutable evidence
  ├── Browser Guardian ────────── semantic, DOM, and network denial policy
  ├── Rate Governor ───────────── bounded batch budget
  └── Model projection gate ───── deterministic local redaction + hash verification
                                      │
                                      ▼
                           existing GraySwanBrowserWorker
                                      │
                                      ▼
                           dedicated browser profile
```

The connector registry does not execute a generic browser. Registration runtime-validates IDs, declared capabilities, duplicate fields, and `readOnly: true`; `get()`/`list()` retain only a frozen metadata facade. The controller uses the typed instance returned by successful Gray Swan registration. The existing Gray Swan worker remains the only collection executor and owns its narrow `CollectBrowserPort`; neither DSH nor the model router receives Playwright, DOM handles, cookies, storage state, or arbitrary URLs.

## Runtime modes

- `AUTH_MODE`: launches the dedicated visible system browser. The user alone controls identity-provider pages, passkeys, CAPTCHA, and MFA. No model browser tools are active.
- `COLLECT_MODE`: permits navigation only to configured Gray Swan and required static origins. Writes to controls, uploads, GraphQL mutations, and unknown state-changing requests are denied.
- `PAUSED_HUMAN_AUTH`: the idle/handoff state when a session is missing or human action is required.
- `DEMO_MODE`: runs the same parse, validate, record commit, and ledger path against repository fixtures without contacting Gray Swan.

Live collection requires an explicit `AUTH_MODE → browser closed → session validation → COLLECT_MODE` transition. A Controller-level exclusive transition is acquired before the first asynchronous browser operation; live sync cannot consume the Profile until the validation browser has closed successfully and `valid` is committed. `login_required` revokes the validated state, while browser/challenge failures conservatively return it to `unknown`. The Dashboard applies the same gate, but `DEMO_MODE` remains available during human authentication because it uses repository fixtures and never opens the profile. Runtime startup reads the optional project-root `.env` before constructing configuration.

## Worker state and durable action state

The existing record worker keeps its deliberately narrow state machine:

```text
AUTH_CHECK → INDEX_DISCOVERY → OPEN_RECORD → CAPTURE_RAW
           → PARSE → VALIDATE → COMMIT → COOLDOWN → NEXT_RECORD
```

Every manually requested sync run also has one durable action in SQLite:

```text
proposal → validation → authorization → dispatch → observation
         → reconciliation → canonical_commit

any non-terminal phase → blocked | failed | cancelled
```

`action_ledger_events` is append-only and sequences events by `(action_id, sequence)`. Every event also carries `sync_run_id`, input hash, payload hash, connector ID/version, and policy version. `action_authorizations` is a separate append-only grant: its authorization hash binds action/run, request hash, locally derived scope hash, policy and connector identity, principal/source/decision, and authorization time. Dispatch, successful settlement, and canonical record writes revalidate that row against the action; upgraded legacy actions without a v4 binding can only enter a non-success terminal (`blocked`, `failed`, or `cancelled`). The action row persists only an allowlisted request summary; arbitrary request bodies are hashed in memory and never stored. `action_ledger_actions` is a current-state index, not a replacement for either append-only history.

On a successful run, observation, reconciliation, canonical action commit, and the terminal `sync_runs` update are written in one SQLite transaction. A stopped or failed run writes its explicit terminal action phase with the run terminal state. Startup recovery marks a formerly running action failed with `process_restarted` rather than blindly redispatching it.

Individual records are still committed as they pass worker validation. An authorized run can enter this canonical transaction only while its action is in `dispatch`. Each record, its evidence references, append-only `sync_record_commits` run/action link, run counter, and checkpoint advance form one atomic canonical-record transaction. Successful reconciliation requires the worker count, SQLite run counter, and linked non-unchanged record set to agree; the ledger stores a deterministic `recordSetHash` and `commitSetHash`. A mismatch rolls back observation/reconciliation and is settled as a failed action. The run-level `canonical_commit` attests that the resulting batch was observed and reconciled; it does not postpone already durable per-record commits.

## Canonical data and recovery

`arena-archivist-data/normalized/arena.sqlite` is canonical for normalized records, checkpoints, sync runs, policy decisions, catalog generation, and the action ledger. Raw HTML and visible-text evidence is immutable and content-addressed by SHA-256 under the configured evidence directory.

If capture or parsing fails before `commitRecord`, no checkpoint advances. If a database operation fails after a newly created evidence file is written, compensation removes the unreferenced file. If the process exits after a record commit, the SQLite checkpoint and unique constraints make replay idempotent. Rate-governor JSON is separate operational budget state, not a second archive or crawler checkpoint.

## Stable archive queries

`GET /v1/records/query` uses keyset pagination ordered by `updated_at DESC, id ASC`. A cursor is opaque and contains only a version, canonical query hash, persistent random catalog ID, catalog generation, and the last ordering key. The runtime:

1. normalizes the query and recomputes its SHA-256 hash;
2. rejects a cursor from another query with `QUERY_CURSOR_MISMATCH`;
3. compares catalog ID and generation with transactional `archive_catalog_state` and returns `STALE_QUERY_CURSOR` after database replacement or canonical chats/submissions change;
4. applies `updated_at < last_updated_at OR (updated_at = last_updated_at AND id > last_id)` rather than OFFSET.

`GET /v1/records?limit=&offset=` remains a compatibility API. New DSH and Dashboard paths use the cursor API.

## Deterministic model projections

Browsing and archival do not require an LLM. A provider request can only carry an `AuthorizedModelProjection` produced locally from a stored record:

- the provider payload is a fixed allowlist of record summary, messages, judge results, selected attributes, and an explicit allowed/removed sensitivity-class manifest;
- email, phone, quoted/unquoted credential/token, private-key, and URL patterns are deterministically replaced; structured display roles/judge names use source-scoped stable pseudonyms;
- remote IDs, source URLs, selector/parser provenance, evidence paths, attachment names, and artifact metadata/hashes are omitted from provider content;
- the local authorization envelope carries deterministic `projectionId`, `sourceRecordId`, `sourceHash`, an explicit payload `contentHash`, `policyVersion`, and `projectionHash`;
- authorization carries the stored data policy plus `policyHash` and `authorizationHash`;
- the generator requires a deep-frozen, module-branded attestation read from an open `ArchiveStore`; catalog identity/generation and current source/policy fields are revalidated at generation and provider dispatch, so policy/catalog changes revoke old objects;
- a second module-private projection brand and hash recomputation reject serialized, cloned, tampered, or caller-authored projections.

The model router no longer accepts caller messages, a caller-supplied record policy, or `redacted: true`. It snapshots the request once, and constructor-time validated provider routes are JSON-copied and deeply frozen before use. It validates the full local envelope, then serializes only its minimized payload beside a fixed instruction; projection/auth hashes and local authorization policy are not sent as model content. It then applies `local_only`, external-processing, embargo, direct-provider, and ZDR/logging gates against the same immutable projection/route later used for dispatch.

## Model-facing tools and local API

The DSH profile has a monotonic allowlist of five tools: status, start a bounded sync, cursor-query content-free archive handles, read a content-free projection receipt, and export an analysis pack. Every runtime response passes an explicit field reducer: checkpoint cursors, titles/outcomes, projection payloads, absolute export paths, and unknown fields are discarded. It has no generic web, shell, filesystem, editor, workflow, scheduler, subagent, or Playwright tool.

Relevant runtime endpoints are:

- `GET /v1/status`
- `POST /v1/auth/open`
- `POST /v1/session/validate`
- `POST /v1/sync`
- `POST /v1/pause`
- `GET /v1/records` (offset compatibility)
- `GET /v1/records/query` (stable cursor API)
- `GET /v1/records/:id/projection` (content-free projection receipt)
- `GET /v1/actions/:id`
- `GET /v1/policy/events`
- `POST /v1/analyze`
- `POST /v1/export`

All write-shaped API calls change only local runtime state. None can submit, edit, or delete Gray Swan data.

## Absorbed donor

The useful concepts from `D:\devspace\projects\web-archive-agent` were reimplemented in this TypeScript/SQLite architecture. Its JSONL/Map ledger, offset-style cursor, caller-configurable projection, and standalone JavaScript collector were not copied. The donor is no longer an active product or runtime dependency and can be archived as read-only historical reference.
