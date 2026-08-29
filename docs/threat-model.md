# Threat model

## Security objectives

1. The runtime cannot submit content to the Arena.
2. Cookies, credentials, passkeys, and authorization headers never enter model-visible state, logs, SQLite, JSONL, or exports.
3. Every normalized value keeps raw provenance and a content hash.
4. Synchronization is idempotent and recoverable.
5. Model decisions cannot increase concurrency or exceed a batch budget.
6. External model calls must obey the record's data policy.

## Protected assets

- the dedicated browser profile and its session material;
- raw red-team conversations and judge results;
- provider API keys;
- immutable evidence and its provenance chain;
- the user's Gray Swan account and competition eligibility.

## Threats and controls

| Threat                                                  | Control                                                                                                                                                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Model invents a click or submit action                  | Raw browser actions are absent from the semantic tool surface.                                                                                                                                         |
| Parser accidentally targets a write control             | DOM guard rejects input, textarea, editable controls, uploads, and submit-like actions.                                                                                                                |
| SPA sends a mutation through a read page                | Network guard parses GraphQL operations, rejects mutations, and fails closed on unknown state-changing endpoints.                                                                                      |
| Redirect leaks the session to another origin            | `COLLECT_MODE` uses an origin allowlist and pauses on an identity-provider redirect.                                                                                                                   |
| CAPTCHA or anti-bot challenge triggers automation loops | Challenge markers, HTTP 403/429, and login-required states stop the batch immediately.                                                                                                                 |
| Retry storm                                             | Single concurrency, minimum record interval, bounded run duration, bounded daily runs, and fixed escalating backoff.                                                                                   |
| Partial write moves the cursor                          | Normalized rows and checkpoint metadata are committed atomically; the file checkpoint is written only afterward.                                                                                       |
| Re-run duplicates evidence                              | Platform IDs and content hashes have unique constraints; artifacts are content-addressed.                                                                                                              |
| Secret appears in an error                              | Structured errors redact cookie, authorization, token, key, and storage-state fields. Exports run an additional secret scan.                                                                           |
| Dashboard credential entry leaks a provider key         | POST is accepted only by the loopback Runtime with JSON and loopback Origin/Host checks. The key is never returned; Windows stores only current-user DPAPI ciphertext outside the archive and exports. |
| Custom endpoint forwards a key to an attacker           | NVIDIA endpoint is pinned to `https://integrate.api.nvidia.com/v1`; the UI cannot supply or override it.                                                                                               |
| Sensitive record is sent to a provider                  | Default `local_only`; routing gate denies unless both record policy and provider policy allow it.                                                                                                      |
| Everyday browser data is exposed                        | A dedicated profile is mandatory; connection to the user's primary profile is unsupported.                                                                                                             |

## Explicitly unsupported behavior

The codebase must not add message sending, prompt filling, break submission, retries of attacks, file upload, deletion, account changes, stealth plugins, fingerprint spoofing, CAPTCHA solving, proxy rotation, or unattended scheduled crawling.

## Human responsibilities

The user must review the current site terms before live collection, use only records they are allowed to access, perform all login steps manually, and stop collection if the site indicates automation is not permitted. When an official export is available, it should be preferred over browser collection.

## Security review checklist

- Run fixture and policy tests before changing selectors.
- Run the secret scanner before sharing an analysis pack.
- Confirm the browser profile contains no unrelated accounts.
- Confirm the runtime is bound to `127.0.0.1`.
- Inspect denied policy events after every live batch.
- Treat parser-repair proposals as untrusted until reviewed.
