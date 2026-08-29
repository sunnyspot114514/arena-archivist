# Threat model

## Security objectives

1. The runtime cannot submit, edit, delete, or upload content to the Arena.
2. Cookies, credentials, passkeys, authorization headers, and browser storage never enter model-visible state, logs, SQLite, ledger payloads, or exports.
3. Every normalized value keeps immutable evidence provenance and content hashes.
4. Synchronization is idempotent, recoverable, and durably tied to validation and authorization history.
5. Model decisions cannot increase concurrency, broaden connector capabilities, or exceed a batch budget.
6. External model calls must obey stored record policy and carry only a locally generated, deterministic projection.
7. Archive cursors cannot silently continue across a changed query or catalog generation.

## Protected assets and trust assumptions

Protected assets include the dedicated browser profile/session, raw red-team conversations and judge results, provider API keys, evidence/provenance, action authorization history, and the user's Gray Swan account/eligibility.

The operating-system user account and processes running as that user are inside the local trust boundary. Binding to loopback plus Host/Origin checks prevents ordinary remote and cross-origin browser access, but it is not authentication against local malware or another process running as the same user. The runtime therefore has no raw-record HTTP endpoint; DSH receives only reduced handles and content-free projection receipts.

## Threats and controls

| Threat | Control |
| --- | --- |
| Model invents a click, URL, or submit action | The DSH guard exposes five semantic Arena operations only. No Playwright, browser handle, DOM event, shell, web, or filesystem primitive is model-visible. |
| Parser targets a write control | DOM guard rejects input, textarea, editable controls, uploads, and submit-like actions. |
| SPA sends a mutation through a read page | Network guard parses GraphQL operations, rejects mutations, and fails closed on unknown state-changing endpoints. |
| Redirect leaks the session to another origin | `COLLECT_MODE` uses exact origin policy and pauses on identity-provider or cross-origin document navigation. |
| CAPTCHA or anti-bot loop | Challenge markers, HTTP 403/429, login-required states, and mutation denial immediately stop the batch. |
| Retry storm or unattended crawl | Single concurrency, record interval, run duration, daily budget, explicit manual start, and escalating backoff. No scheduler tool is loaded. |
| Record commit advances a checkpoint after partial failure | Record/children/artifact references, run counter, and checkpoint advance share one SQLite transaction; newly written unreferenced evidence is compensated. |
| Run authorization disappears or execution is blindly replayed after restart | Append-only ledger events persist input/payload hashes, connector/policy identity, and run/action linkage. Legacy run settlement is rejected for an authorized action. Startup atomically settles an unfinished action as failed instead of redispatching. |
| Ledger history is rewritten | SQLite triggers deny UPDATE and DELETE on `action_ledger_events`; the action snapshot is only an index over sequenced history. Export/database integrity review can recompute payload hashes. |
| Re-run duplicates evidence | Platform identity and content hashes have unique constraints; artifacts are content-addressed and checkpoints are monotonic. |
| Record/run counts disagree at finalization | Each canonical record transaction writes a run/action/record link. Reconciliation compares worker count, SQLite counter, and link set, then hashes the exact set; mismatch cannot reach `canonical_commit`. |
| Offset drift skips/duplicates archive rows | New query paths use keyset ordering. Cursor query hash mismatch and catalog-ID/generation change produce explicit errors. The offset endpoint remains compatibility-only. |
| Caller asserts `redacted: true` while sending raw text | The model router has no `redacted` or caller-messages field. It accepts only a module-branded `AuthorizedModelProjection`, recomputes hashes, and constructs provider messages itself. |
| Caller invents a stored record or projection | Projection generation first requires a deep-frozen, module-branded `ArchiveStore` attestation bound to source/policy and catalog identity. A separate projection brand plus source/policy/projection/authorization hash verification rejects cloned or tampered objects. |
| Projection leaks raw identifiers or paths | Fixed allowlist omits external IDs, URLs, selector traces, storage paths, and artifact metadata; provenance contains hashes only. Deterministic redactors cover common email, phone, token/credential, private-key, and URL patterns. |
| DSH response regression releases content or local paths | Every status/sync/query/read/export response passes a field allowlist reducer. Tests prove titles, outcomes, projection payload, checkpoint cursor, browser profile, and export paths are dropped. |
| Connector adds write capability or bypasses worker policy | Registry validates known capability values and `readOnly: true`, stores only frozen metadata facades for `get()`/`list()`, and rejects duplicates. Gray Swan is a typed facade returned by registration over the existing guarded worker, not a generic executable browser connector. New connectors require code review and tests. |
| Secret appears in an error or export | Structured errors redact credential-like fields. Exports have an additional secret scan and exclude profiles, credential stores, runtime state, and build outputs. |
| Dashboard credential entry leaks a provider key | POST is loopback-only with JSON and Host/Origin checks. The key is never returned; Windows stores current-user DPAPI ciphertext outside archive data and exports. |
| Custom endpoint forwards a key | NVIDIA endpoint is pinned to `https://integrate.api.nvidia.com/v1`; UI and API cannot override it. |
| Sensitive record is sent externally | Default `local_only`; projection authorization derives from stored data policy, external-processing flag, and embargo. Router routes additionally require declared ZDR and disabled prompt logging. |
| Everyday browser data is exposed | A project-dedicated profile is mandatory; attaching the user's normal profile is unsupported. |

## Residual risk

Pattern redaction cannot prove removal of every possible secret format. `public` or externally processable classification therefore remains a human policy decision, and raw records should stay `local_only` unless explicitly reviewed. A malicious dependency or same-user local process is also outside the loopback API's protection; operating-system account hygiene and dependency review remain required.

Catalog generation is intentionally coarse: any canonical chat/submission change makes all outstanding cursor pages stale. This favors explicit restart over potentially inconsistent continuation.

## Explicitly unsupported behavior

The codebase must not add message sending, prompt filling, break submission, attack retries, file upload, deletion, account changes, stealth plugins, fingerprint spoofing, CAPTCHA solving, proxy rotation, unattended scheduled crawling, generic browser tools, or model-selected connector code.

## Human responsibilities

The user must review current site terms, access only records they are authorized to view, perform all login steps manually, stop when the site indicates automation is not permitted, protect the local OS account, and prefer an official export when available.

## Security review checklist

- Run fixture, ledger, projection, connector, cursor, and policy tests before changing adapters or selectors.
- Run the repository secret scan before committing and the export secret scan before sharing an analysis pack.
- Confirm dedicated profiles contain no unrelated accounts and remain outside Git/exports.
- Confirm runtime binding is `127.0.0.1` and the DSH final plugin tree contains only the five Arena tools.
- Inspect terminal action events and denied policy events after every live batch.
- Treat parser-repair proposals and new connector registrations as untrusted until reviewed.
- Never use the archived donor project as a second runtime or source of truth.
