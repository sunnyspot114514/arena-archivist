export type ArchiveConnectorCapability =
  | 'official_api_read'
  | 'official_export_read'
  | 'structured_page_read'
  | 'dom_read'
  | 'visual_read'
  | 'offline_fixture_read';

export type ArchiveConnectorMetadata = Readonly<{
  id: string;
  displayName: string;
  version: string;
  readOnly: true;
  recordKinds: readonly string[];
  capabilities: readonly ArchiveConnectorCapability[];
  cursorFormat: string;
}>;

/**
 * The registry deliberately exposes connector metadata rather than browser or
 * transport primitives. A connector may add strongly typed local adapter
 * methods, but DSH and model-facing code only receives this interface.
 */
export interface ArchiveConnector {
  readonly metadata: ArchiveConnectorMetadata;
}

function requiredIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (
    value !== normalized ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(normalized)
  ) {
    throw new Error(`${label} must be a stable lowercase identifier`);
  }
  return normalized;
}

function validateMetadata(metadata: ArchiveConnectorMetadata): void {
  requiredIdentifier(metadata.id, 'connector id');
  if (!metadata.displayName.trim()) throw new Error('displayName is required');
  if (!metadata.version.trim())
    throw new Error('connector version is required');
  if (metadata.readOnly !== true) {
    throw new Error('Archive connectors must be read-only');
  }
  if (metadata.recordKinds.length === 0) {
    throw new Error('Archive connectors must declare record kinds');
  }
  if (metadata.capabilities.length === 0) {
    throw new Error('Archive connectors must declare capabilities');
  }
  if (new Set(metadata.recordKinds).size !== metadata.recordKinds.length) {
    throw new Error('Archive connector record kinds must be unique');
  }
  if (new Set(metadata.capabilities).size !== metadata.capabilities.length) {
    throw new Error('Archive connector capabilities must be unique');
  }
  const allowedCapabilities = new Set<ArchiveConnectorCapability>([
    'official_api_read',
    'official_export_read',
    'structured_page_read',
    'dom_read',
    'visual_read',
    'offline_fixture_read',
  ]);
  if (
    metadata.capabilities.some(
      (capability) => !allowedCapabilities.has(capability),
    )
  ) {
    throw new Error('Archive connector capability is unknown');
  }
  if (!metadata.cursorFormat.trim()) {
    throw new Error('Archive connector cursor format is required');
  }
}

function publicMetadata(
  metadata: ArchiveConnectorMetadata,
): ArchiveConnectorMetadata {
  return Object.freeze({
    id: metadata.id,
    displayName: metadata.displayName,
    version: metadata.version,
    readOnly: true as const,
    recordKinds: Object.freeze([...metadata.recordKinds]),
    capabilities: Object.freeze([...metadata.capabilities]),
    cursorFormat: metadata.cursorFormat,
  });
}

export class ArchiveConnectorRegistry {
  readonly #connectors = new Map<string, ArchiveConnector>();

  register<T extends ArchiveConnector>(connector: T): T {
    validateMetadata(connector.metadata);
    const id = connector.metadata.id;
    if (this.#connectors.has(id)) {
      throw new Error(`Archive connector already registered: ${id}`);
    }
    this.#connectors.set(
      id,
      Object.freeze({ metadata: publicMetadata(connector.metadata) }),
    );
    return connector;
  }

  get(id: string): ArchiveConnector | null {
    const connector = this.#connectors.get(
      requiredIdentifier(id, 'connector id'),
    );
    return connector ?? null;
  }

  list(): ArchiveConnectorMetadata[] {
    return [...this.#connectors.values()]
      .map((connector) => publicMetadata(connector.metadata))
      .sort((left, right) => left.id.localeCompare(right.id));
  }
}
