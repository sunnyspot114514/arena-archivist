import type { SecretStore, SecretStoreKind } from './secret-store';

export type AuthStatus = {
  provider: string;
  connectionId: string;
  status: 'connected' | 'disconnected';
};

export {
  createLocalSecretStore,
  MemorySecretStore,
  WindowsDpapiSecretStore,
  type SecretStore,
  type SecretStoreKind,
} from './secret-store';

export type AuthResult =
  | { status: 'connected' }
  | { status: 'action_required'; message: string }
  | { status: 'failed'; message: string };

const credentialHandleBrand: unique symbol = Symbol('credential-handle');

/**
 * An opaque reference that is safe to include in runtime state. It deliberately
 * has no method that reveals credential bytes and serializes to a redacted value.
 */
export class OpaqueCredentialHandle {
  readonly [credentialHandleBrand] = true;

  constructor(
    readonly connectionId: string,
    readonly provider: string,
  ) {}

  toJSON(): Record<string, string> {
    return {
      provider: this.provider,
      connectionId: this.connectionId,
      credential: '[opaque]',
    };
  }

  toString(): string {
    return `[OpaqueCredentialHandle ${this.provider}/${this.connectionId}]`;
  }
}

export interface AuthBroker {
  status(connectionId: string): Promise<AuthStatus>;
  begin(connectionId: string): Promise<AuthResult>;
  disconnect(connectionId: string): Promise<void>;
  resolveCredential(connectionId: string): Promise<OpaqueCredentialHandle>;
}

export interface CredentialExecutor {
  /** Run trusted transport code with a secret that never enters model-visible state. */
  withCredential<T>(
    handle: OpaqueCredentialHandle,
    operation: (secret: string) => Promise<T>,
  ): Promise<T>;
}

export type EnvConnection = {
  provider: string;
  envName: string;
};

/**
 * Development fallback for the DSH credential seam. Environment variable names
 * may be configured, but values are never returned through the public broker API.
 */
export class EnvironmentAuthBroker implements AuthBroker, CredentialExecutor {
  readonly #connections: ReadonlyMap<string, EnvConnection>;
  readonly #disconnected = new Set<string>();
  readonly #secretStore: SecretStore | null;

  constructor(
    connections: Record<string, EnvConnection>,
    secretStore: SecretStore | null = null,
  ) {
    this.#connections = new Map(Object.entries(connections));
    this.#secretStore = secretStore;
  }

  get secretStoreKind(): SecretStoreKind | 'environment' {
    return this.#secretStore?.kind ?? 'environment';
  }

  async status(connectionId: string): Promise<AuthStatus> {
    const connection = this.#getConnection(connectionId);
    const connected =
      !this.#disconnected.has(connectionId) &&
      (Boolean(await this.#secretStore?.has(connectionId)) ||
        Boolean(process.env[connection.envName]));

    return {
      provider: connection.provider,
      connectionId,
      status: connected ? 'connected' : 'disconnected',
    };
  }

  async begin(connectionId: string): Promise<AuthResult> {
    const connection = this.#getConnection(connectionId);
    if (
      ((await this.#secretStore?.has(connectionId)) ||
        process.env[connection.envName]) &&
      !this.#disconnected.has(connectionId)
    ) {
      return { status: 'connected' };
    }

    return {
      status: 'action_required',
      message: `Set the credential through the configured secret store reference: ${connection.envName}`,
    };
  }

  async disconnect(connectionId: string): Promise<void> {
    this.#getConnection(connectionId);
    await this.#secretStore?.delete(connectionId);
    this.#disconnected.add(connectionId);
  }

  async setCredential(connectionId: string, secret: string): Promise<void> {
    this.#getConnection(connectionId);
    if (!this.#secretStore) {
      throw new Error('Managed credential storage is unavailable');
    }
    if (!secret || containsWhitespaceOrControl(secret)) {
      throw new Error(
        'Credential must be a non-empty value without whitespace',
      );
    }
    await this.#secretStore.write(connectionId, secret);
    this.#disconnected.delete(connectionId);
  }

  async credentialSource(
    connectionId: string,
  ): Promise<'managed' | 'environment' | null> {
    const connection = this.#getConnection(connectionId);
    if (this.#disconnected.has(connectionId)) return null;
    if (await this.#secretStore?.has(connectionId)) return 'managed';
    return process.env[connection.envName] ? 'environment' : null;
  }

  async resolveCredential(
    connectionId: string,
  ): Promise<OpaqueCredentialHandle> {
    const status = await this.status(connectionId);
    if (status.status !== 'connected') {
      throw new Error(
        `Credential connection is not connected: ${connectionId}`,
      );
    }
    return new OpaqueCredentialHandle(connectionId, status.provider);
  }

  async withCredential<T>(
    handle: OpaqueCredentialHandle,
    operation: (secret: string) => Promise<T>,
  ): Promise<T> {
    const connection = this.#getConnection(handle.connectionId);
    if (connection.provider !== handle.provider) {
      throw new Error('Credential handle provider binding mismatch');
    }

    const status = await this.status(handle.connectionId);
    const secret =
      (await this.#secretStore?.read(handle.connectionId)) ??
      process.env[connection.envName];
    if (status.status !== 'connected' || !secret) {
      throw new Error(
        `Credential connection is not connected: ${handle.connectionId}`,
      );
    }

    return operation(secret);
  }

  #getConnection(connectionId: string): EnvConnection {
    const connection = this.#connections.get(connectionId);
    if (!connection) {
      throw new Error(`Unknown credential connection: ${connectionId}`);
    }
    return connection;
  }
}

const SECRET_KEY_PATTERN =
  /(^|[-_])(authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|storage[-_]?state)($|[-_])/i;

function containsWhitespaceOrControl(value: string): boolean {
  if (/\s/u.test(value)) return true;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Remove common credential fields before an error or event is persisted. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        SECRET_KEY_PATTERN.test(key) ? '[redacted]' : redactSecrets(nested),
      ]),
    );
  }

  return value;
}
