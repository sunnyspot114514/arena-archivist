import type {
  AuthBroker,
  AuthResult,
  AuthStatus,
  CredentialExecutor,
  OpaqueCredentialHandle,
} from './index';

/**
 * Narrow port implemented by the pinned DSH credential plugin. Keeping it here
 * prevents Arena code from depending on credential-record internals.
 */
export interface DshCredentialPort {
  status(
    connectionId: string,
  ): Promise<{ provider: string; connected: boolean }>;
  begin(connectionId: string): Promise<AuthResult>;
  disconnect(connectionId: string): Promise<void>;
  withResolvedCredential<T>(
    connectionId: string,
    operation: (credential: string) => Promise<T>,
  ): Promise<T>;
}

export class DshAuthBrokerAdapter implements AuthBroker, CredentialExecutor {
  readonly #port: DshCredentialPort;

  constructor(port: DshCredentialPort) {
    this.#port = port;
  }

  async status(connectionId: string): Promise<AuthStatus> {
    const status = await this.#port.status(connectionId);
    return {
      provider: status.provider,
      connectionId,
      status: status.connected ? 'connected' : 'disconnected',
    };
  }

  begin(connectionId: string): Promise<AuthResult> {
    return this.#port.begin(connectionId);
  }

  disconnect(connectionId: string): Promise<void> {
    return this.#port.disconnect(connectionId);
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

    const { OpaqueCredentialHandle: Handle } = await import('./index');
    return new Handle(connectionId, status.provider);
  }

  withCredential<T>(
    handle: OpaqueCredentialHandle,
    operation: (secret: string) => Promise<T>,
  ): Promise<T> {
    return this.#port.withResolvedCredential(handle.connectionId, operation);
  }
}
