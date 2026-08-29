# Data dictionary

The canonical database is `arena-archivist-data/normalized/arena.sqlite`. Schema version 5 is managed by checksummed, append-only migrations; previously applied migration SQL is never rewritten. Version 4 adds request minimization and separate authorization records; version 5 adds execution-time binding triggers and migration integrity checks without changing the v4 checksum.

## Canonical tables

| Table | Purpose |
| --- | --- |
| `schema_migrations` | Applied migration version, name, checksum, and timestamp. |
| `sync_runs` | Batch start/finish state, requested limit, committed-record count, stop reason, and non-secret metadata. |
| `action_ledger_actions` | Current durable action snapshot, one action per sync run. |
| `action_ledger_events` | Append-only authorization/execution history linked to both action and sync run. |
| `action_authorizations` | Append-only authorization grant and hash-bound request/scope/policy/connector/principal/source/time fields. |
| `sync_record_commits` | Per-record canonical commit links carrying run ID, action ID, record ID/hash, disposition, and commit time. |
| `archive_catalog_state` | Singleton persistent catalog ID and transactional generation used to invalidate query cursors. |
| `behaviors` | Stable behavior/taxonomy metadata. |
| `challenges` | Challenge metadata referenced by archived records. |
| `chats` | One normalized previous-chat record per `(platform, external_chat_id)`. |
| `messages` | Ordered canonical chat messages. |
| `submissions` | One normalized submission per `(platform, external_submission_id)`. |
| `judge_results` | Submission scores, labels, explanations, and source hashes. |
| `source_artifacts` | Immutable evidence type, content hash, byte length, media type, relative storage path, capture time, and non-secret metadata. |
| `parser_events` | Versioned parser success, warning, failure, and proposal events. |
| `model_annotations` | Versioned derived labels; never overwrites raw data. |
| `policy_decisions` | Semantic, worker, DOM/network, provider, and data-routing audit decisions. |
| `checkpoints` | Canonical per-source cursor, state JSON, last record/hash, monotonic version, and update time. |

## Action ledger

`action_ledger_actions` contains:

| Field | Meaning |
| --- | --- |
| `action_id` | Stable local action handle returned with the sync run. |
| `sync_run_id` | Unique foreign key to `sync_runs.id`. |
| `kind`, `target` | Bounded semantic operation and target connector. |
| `current_phase`, `sequence`, `terminal` | Current indexed lifecycle position. Event history remains authoritative. |
| `input_hash` | SHA-256 of canonical request JSON. |
| `policy_version` | Local authorization policy version. |
| `connector_id`, `connector_version` | Exact connector identity used for validation/dispatch. |
| `request_json`, `context_json` | Allowlisted non-secret request summary and local context. The full canonical request is hashed in memory and is not persisted. |
| `created_at`, `updated_at` | ISO timestamps from the local runtime clock. |

`action_ledger_events` repeats action/run identity, input/policy/connector identity, and adds `event_id`, monotonic `sequence`, `from_phase`, `phase`, `occurred_at`, canonical `payload_json`, and its `payload_hash`. SQLite triggers reject UPDATE or DELETE of an event.

`action_authorizations` stores one new-format grant per action. `authorization_hash` covers `authorization_id`, action/run IDs, request and scope hashes, policy and connector identity, principal, authorization source, decision code, and `authorized_at`. The scope hash is always derived locally; a caller-supplied value is accepted only when it exactly matches that derivation. UPDATE and DELETE are denied by triggers. Migration v4 logically clears any v3 `request_json` bodies. Historical actions created under v3 retain their append-only authorization event but have no synthetic `action_authorizations` row; the API returns `null` rather than inventing a grant, and those actions cannot dispatch, successfully settle, or commit records. They may only enter `blocked`, `failed`, or `cancelled` for recovery.

Normal successful phases are `proposal`, `validation`, `authorization`, `dispatch`, `observation`, `reconciliation`, and `canonical_commit`. `blocked`, `failed`, and `cancelled` are explicit terminal alternatives.

`sync_record_commits` is written inside each record/checkpoint transaction and is append-only from schema v4 onward. Under schema v5, authorized rows additionally require a same-run, validated authorization binding and are accepted only while that action is in `dispatch`; legacy offset/store compatibility runs may have a null action ID. Reconciliation hashes the ordered non-unchanged link set and refuses `canonical_commit` unless its count equals both `sync_runs.records_committed` and the worker-reported count.

## Record policy fields

Every chat or submission stores:

| Field | Meaning |
| --- | --- |
| `data_policy` | `local_only`, `direct_provider_only`, `zdr_router_allowed`, or `public`. |
| `embargo_until` | Optional ISO timestamp before which external processing is denied. |
| `external_processing_allowed` | Independent external-processing gate; defaults to false. |
| `source_hash` | SHA-256 over the ordered content-addressed evidence set. |
| `normalized_json` | Adapter-normalized JSON; not itself authorization to send data externally. |

The model projection policy version is not caller-provided and is not a mutable record column. It is emitted as `policyVersion` in each deterministic projection and covered by its hashes.

## Query generation and cursor

`archive_catalog_state` has exactly one row: `{singleton: 1, catalog_id, generation}`. `catalog_id` is a persistent random database/catalog epoch. INSERT, UPDATE, or DELETE on `chats` or `submissions` increments `generation` in the same SQLite transaction. Changes to audit logs or ledger events do not invalidate record-summary queries.

The opaque cursor is an encoded implementation detail with version, query hash, catalog ID/generation, and last `(updatedAt, id)` key. It contains neither an offset nor record content. A consumer must not parse or edit it. Query mismatch is a client error; catalog identity/generation mismatch is a stale-cursor conflict requiring a fresh first page.

## Deterministic projections

`RedactionProjection` and `AuthorizedModelProjection` are generated values, not database tables. Their generator requires a current `ArchiveStore` attestation branded in process and bound to record ID/source policy plus catalog identity/generation. The store must remain open, and freshness is checked again whenever the authorized projection reaches the provider boundary; any catalog or record-policy change invalidates the old object. Both projections expose deterministic `projectionId`, `sourceRecordId`, `sourceHash`, an explicit payload `contentHash`, fixed local `policyVersion`, envelope `projectionHash`, and a minimized payload with fixed `allowedClasses`/`removedClasses`. The authorized form additionally contains the stored record policy, `policyHash`, and `authorizationHash`. Evidence storage paths, attachment names, remote IDs, source URLs, parser/selector provenance, artifact hashes, raw adapter metadata, cookies, credentials, and browser state are never fields in the provider payload. After validating the complete envelope, `ModelRouter` sends only that payload plus a fixed instruction.

DSH never receives that payload. Its read tool receives `AuthorizedModelProjectionReceipt`: projection/source-record IDs, the local record handle, source/content/policy/projection/authorization hashes, data-policy label, and `contentReleased: false`.

## Provenance and checkpoint rules

Normalized records retain platform/external identity, record source hash, first/update time, child source hashes, and artifact content hashes. Adapter parser and selector-contract versions may remain in canonical normalized JSON when supplied by the adapter, but projection generation does not forward them to a provider.

The `checkpoints` table is authoritative and advances as the final write in each canonical record transaction. There is no `crawler_checkpoints` table and no crawler-state JSON mirror. Rate-governor JSON tracks only operational budget recovery and is not archive truth.

Provider credentials, dedicated browser profiles, DPAPI ciphertext, local provider settings, build output, and exports are outside this database and excluded from Git and archive exports as appropriate.
