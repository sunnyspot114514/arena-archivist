import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  EnvironmentAuthBroker,
  MemorySecretStore,
} from '../../../packages/auth-broker/src/index';
import {
  classifyNvidiaModelSelection,
  fetchNvidiaModelIds,
  ProviderSettingsStore,
} from '../src/provider-manager';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('NVIDIA provider settings', () => {
  it('only accepts exact IDs from a refreshed catalog', () => {
    const models = ['moonshotai/kimi-k3', 'nvidia/example-model'];

    expect(classifyNvidiaModelSelection('kimi-k3', models)).toBe(
      'not-in-catalog',
    );
    expect(classifyNvidiaModelSelection('moonshotai/kimi-k3', models)).toBe(
      'available',
    );
    expect(classifyNvidiaModelSelection('moonshotai/kimi-k3', [])).toBe(
      'catalog-required',
    );
  });

  it('persists the selected model without storing a credential', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'arena-provider-'));
    directories.push(directory);
    const path = join(directory, 'providers.json');
    const store = await ProviderSettingsStore.open(path, null);
    await store.selectNvidiaModel('nvidia/example-model');

    const reopened = await ProviderSettingsStore.open(path, null);
    expect(reopened.nvidiaModel).toBe('nvidia/example-model');
  });

  it('fetches and normalizes OpenAI-compatible model IDs with a bearer key', async () => {
    const auth = new EnvironmentAuthBroker(
      { nvidia: { provider: 'nvidia', envName: 'UNUSED_NVIDIA_KEY' } },
      new MemorySecretStore(),
    );
    await auth.setCredential('nvidia', 'fixture-nvidia-secret');
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe(
          'Bearer fixture-nvidia-secret',
        );
        return Response.json({
          object: 'list',
          data: [
            { id: 'nvidia/model-b', object: 'model' },
            { id: 'nvidia/model-a', object: 'model' },
            { id: 'nvidia/model-b', object: 'model' },
            { id: null },
          ],
        });
      },
    );

    await expect(
      fetchNvidiaModelIds({
        auth,
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toEqual(['nvidia/model-a', 'nvidia/model-b']);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('rejects a credential-forwarding base URL', async () => {
    const auth = new EnvironmentAuthBroker(
      { nvidia: { provider: 'nvidia', envName: 'UNUSED_NVIDIA_KEY' } },
      new MemorySecretStore(),
    );
    await auth.setCredential('nvidia', 'fixture-nvidia-secret');
    await expect(
      fetchNvidiaModelIds({
        auth,
        baseUrl: 'https://example.com/v1',
        fetchImpl: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow('NVIDIA_BASE_URL');
  });
});
