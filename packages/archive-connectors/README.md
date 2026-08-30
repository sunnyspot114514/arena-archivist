# Archive connectors

This package defines the narrow `ArchiveConnector` metadata contract and `ArchiveConnectorRegistry` used by Arena Archivist. Registration requires a stable lowercase ID, version, record kinds, known read-only capabilities, cursor format, and literal `readOnly: true`; duplicates and unknown capabilities fail closed.

The registry is not a generic collector or browser dispatcher. Registration accepts only a frozen execution connector with frozen metadata, capabilities, and record-kind arrays, preventing validation/use mutation. `get()` and `list()` expose frozen metadata-only facades. A reviewed adapter may attach typed local parser methods to the object passed to `register()`, and the controller may retain the exact typed instance returned by that successful registration. DSH and model-facing code never receive those methods.

The first implementation is `graySwanArchiveConnector` in `packages/gray-swan-adapter`. It wraps the existing selector-contract/parser/validation functions. It does not replace or duplicate `GraySwanBrowserWorker`.
