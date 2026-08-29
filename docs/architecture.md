# Arena Archivist architecture

Arena Archivist is a localhost-only personal archive and replay runtime for records the user is already authorized to view. The first release has one site adapter, one visible browser, one active tab, and no submission capability.

## Trust boundaries

```text
User
  │ manually starts a batch / completes login
  ▼
Dashboard (localhost)
  │ semantic commands only
  ▼
Runtime API ── Archive Store ── raw evidence + SQLite + checkpoint
  │
  ├── Browser Guardian ── policy audit log
  ├── Rate Governor ───── bounded batch budget
  └── Gray Swan Adapter ─ deterministic parser/state machine
                              │
                              ▼
                     Playwright persistent context
                              │
                              ▼
                    dedicated Chrome profile
```

The model-facing surface never receives Playwright primitives. It only exposes four bounded operations: session status, sync the next batch, read an archived record, and export an analysis pack.

## Runtime modes

- `AUTH_MODE`: opens a dedicated visible Chrome profile. The user alone controls identity-provider pages, passkeys, CAPTCHA, and MFA. No model tools are active.
- `COLLECT_MODE`: permits navigation only to configured Gray Swan origins and required static origins. Writing into controls, uploads, GraphQL mutations, and unknown state-changing requests are denied.
- `PAUSED_HUMAN_AUTH`: terminal state for a batch when the session is missing or a human challenge appears.
- `DEMO_MODE`: runs the exact parse, validate, commit, and checkpoint path against local fixtures without contacting Gray Swan.

## Collection state machine

```text
AUTH_CHECK
  → INDEX_DISCOVERY
  → OPEN_RECORD
  → CAPTURE_RAW
  → PARSE
  → VALIDATE
  → COMMIT
  → COOLDOWN
  → NEXT_RECORD
```

Every transition is explicit and auditable. `COMMIT` writes normalized fields and provenance in a single SQLite transaction. The checkpoint is advanced only after that transaction succeeds. A repeated batch is therefore idempotent.

## Canonical data and recovery

`arena-archivist-data/normalized/arena.sqlite` is canonical for normalized records. Raw HTML, visible text, and allowed response payloads are immutable evidence addressed by SHA-256. `checkpoints/crawler_state.json` is a recovery handle, not a second database.

If a process exits between capture and commit, the temporary evidence directory is discarded on restart. If it exits after commit but before the next record opens, the checkpoint and unique constraints prevent a duplicate.

## Model routing

Browsing succeeds without an LLM. Model calls are only available to offline analysis and parser-repair proposals. Before each call the router checks the record data policy:

- `local_only`: no external model call.
- `direct_provider_only`: only explicitly approved direct providers.
- `zdr_router_allowed`: approved direct providers or an explicitly configured zero-data-retention router.
- `public`: any configured and approved route.

Parser repair output is a proposal. It must pass fixture tests and human review before becoming the active selector contract.

## Local API

The runtime listens on `127.0.0.1` only. The initial API is intentionally small:

- `GET /v1/status`
- `POST /v1/auth/open`
- `POST /v1/session/validate`
- `POST /v1/sync`
- `POST /v1/pause`
- `GET /v1/records`
- `POST /v1/analyze`
- `POST /v1/export`
- `GET /v1/policy/events`

All write-shaped API calls change only local runtime state. None can submit, edit, or delete data on Gray Swan.
