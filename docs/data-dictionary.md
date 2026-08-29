# Data dictionary

## Canonical tables

| Table                 | Purpose                                                                |
| --------------------- | ---------------------------------------------------------------------- |
| `sync_runs`           | Batch lifecycle, budget, terminal state, and failure reason.           |
| `challenges`          | Challenge metadata referenced by archived records.                     |
| `behaviors`           | Stable behavior/taxonomy metadata.                                     |
| `chats`               | One normalized previous-chat record per external platform ID.          |
| `messages`            | Ordered messages belonging to a chat.                                  |
| `submissions`         | One normalized submission per external platform ID.                    |
| `judge_results`       | Scores, labels, and raw-result provenance.                             |
| `source_artifacts`    | Immutable evidence path, media type, SHA-256, parser version.          |
| `parser_events`       | Parser success, drift, and repair-proposal history.                    |
| `model_annotations`   | Versioned derived labels; never overwrites raw data.                   |
| `policy_decisions`    | Allowed and denied semantic, DOM, network, and data-routing decisions. |
| `crawler_checkpoints` | Canonical per-source cursor committed with normalized records.         |

## Record policy fields

Every top-level chat or submission carries:

| Field                         | Meaning                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `data_policy`                 | `local_only`, `direct_provider_only`, `zdr_router_allowed`, or `public`. |
| `embargo_until`               | Optional ISO timestamp before which external processing is denied.       |
| `external_processing_allowed` | Explicit second gate; defaults to `false`.                               |
| `redaction_version`           | Version of the transform used to create any analysis copy.               |

## Provenance fields

Normalized records keep the platform name, external record ID, source artifact ID, source content hash, parser version, capture timestamp, and normalized timestamp. A derived annotation additionally stores taxonomy version, annotator prompt version, provider, model, confidence, and review status.

## Checkpoint rule

The database checkpoint is authoritative. `checkpoints/crawler_state.json` is a human-readable mirror written after commit. On disagreement, the runtime reconstructs the file from SQLite and records a reconciliation event.
