import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  EnvironmentAuthBroker,
  MemorySecretStore,
  OpaqueCredentialHandle,
  WindowsDpapiSecretStore,
  redactSecrets,
} from '../src/index';

const ENV_NAME = 'ARENA_ARCHIVIST_TEST_API_KEY';
const ORIGINAL_VALUE = process.env[ENV_NAME];

afterEach(() => {
  if (ORIGINAL_VALUE === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = ORIGINAL_VALUE;
});

describe('opaque credential handles', () => {
  it('serializes identity metadata but never credential bytes', async () => {
    const secret = 'fixture-provider-secret-value';
    process.env[ENV_NAME] = secret;
    const broker = new EnvironmentAuthBroker({
      provider: { provider: 'fixture', envName: ENV_NAME },
    });

    const handle = await broker.resolveCredential('provider');
    expect(handle).toBeInstanceOf(OpaqueCredentialHandle);
    expect(handle).not.toHaveProperty('secret');
    expect(JSON.stringify(handle)).toBe(
      '{"provider":"fixture","connectionId":"provider","credential":"[opaque]"}',
    );
    expect(JSON.stringify(handle)).not.toContain(secret);
    expect(String(handle)).not.toContain(secret);

    await expect(
      broker.withCredential(handle, async (value) => value === secret),
    ).resolves.toBe(true);
  });

  it('refuses disconnected handles and provider-binding mismatches', async () => {
    process.env[ENV_NAME] = 'fixture-provider-secret-value';
    const broker = new EnvironmentAuthBroker({
      provider: { provider: 'fixture', envName: ENV_NAME },
    });
    await expect(
      broker.withCredential(
        new OpaqueCredentialHandle('provider', 'wrong-provider'),
        async () => true,
      ),
    ).rejects.toThrow('provider binding mismatch');

    const handle = await broker.resolveCredential('provider');
    await broker.disconnect('provider');
    await expect(
      broker.withCredential(handle, async () => true),
    ).rejects.toThrow('not connected');
  });

  it('uses managed secrets before environment fallbacks and forgets them', async () => {
    const store = new MemorySecretStore();
    const broker = new EnvironmentAuthBroker(
      { provider: { provider: 'fixture', envName: ENV_NAME } },
      store,
    );
    await broker.setCredential('provider', 'managed-fixture-secret');
    expect(await broker.credentialSource('provider')).toBe('managed');
    const handle = await broker.resolveCredential('provider');
    await expect(
      broker.withCredential(handle, async (value) => value),
    ).resolves.toBe('managed-fixture-secret');
    await broker.disconnect('provider');
    await expect(store.has('provider')).resolves.toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'round-trips a DPAPI secret without writing plaintext',
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'arena-dpapi-'));
      const secret = 'fixture-dpapi-secret-value';
      try {
        const store = new WindowsDpapiSecretStore(directory);
        await store.write('nvidia', secret);
        const ciphertext = await readFile(
          join(directory, 'nvidia.dpapi'),
          'utf8',
        );
        expect(ciphertext).not.toContain(secret);
        await expect(store.read('nvidia')).resolves.toBe(secret);
        await store.delete('nvidia');
        await expect(store.has('nvidia')).resolves.toBe(false);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('secret redaction', () => {
  it('recursively redacts credential-shaped keys without changing ordinary fields', () => {
    expect(
      redactSecrets({
        event: 'provider_failed',
        authorization: 'Bearer hidden',
        nested: {
          api_key: 'hidden',
          items: [{ refreshToken: 'hidden' }, { detail: 'safe' }],
        },
        storage_state: { cookies: ['hidden'] },
      }),
    ).toEqual({
      event: 'provider_failed',
      authorization: '[redacted]',
      nested: {
        api_key: '[redacted]',
        items: [{ refreshToken: '[redacted]' }, { detail: 'safe' }],
      },
      storage_state: '[redacted]',
    });
  });
});
