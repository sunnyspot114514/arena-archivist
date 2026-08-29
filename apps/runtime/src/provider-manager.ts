import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

import { z } from 'zod';

import type {
  CredentialExecutor,
  EnvironmentAuthBroker,
} from '../../../packages/auth-broker/src/index';

function isSingleToken(value: string): boolean {
  if (/\s/u.test(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

const modelIdSchema = z.string().trim().min(1).max(256).refine(isSingleToken, {
  message: 'Model ID cannot contain whitespace or control characters',
});

const settingsSchema = z.object({
  version: z.literal(1),
  providers: z.object({
    nvidia: z.object({ model: modelIdSchema.nullable() }),
  }),
});

type ProviderSettingsDocument = z.infer<typeof settingsSchema>;

function assertNvidiaBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'integrate.api.nvidia.com' ||
    !['/v1', '/v1/'].includes(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'NVIDIA_BASE_URL must be https://integrate.api.nvidia.com/v1',
    );
  }
  return 'https://integrate.api.nvidia.com/v1';
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (
      !['EEXIST', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')
    ) {
      await rm(temporary, { force: true });
      throw error;
    }
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

export class ProviderSettingsStore {
  readonly #path: string;
  #document: ProviderSettingsDocument;

  private constructor(path: string, document: ProviderSettingsDocument) {
    this.#path = path;
    this.#document = document;
  }

  static async open(
    path: string,
    defaultNvidiaModel: string | null,
  ): Promise<ProviderSettingsStore> {
    const fallback: ProviderSettingsDocument = {
      version: 1,
      providers: {
        nvidia: {
          model: defaultNvidiaModel
            ? modelIdSchema.parse(defaultNvidiaModel)
            : null,
        },
      },
    };
    try {
      const parsed = settingsSchema.parse(
        JSON.parse(await readFile(path, 'utf8')) as unknown,
      );
      return new ProviderSettingsStore(path, parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return new ProviderSettingsStore(path, fallback);
      }
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new Error('Provider settings file is invalid');
      }
      throw error;
    }
  }

  get nvidiaModel(): string | null {
    return this.#document.providers.nvidia.model;
  }

  async selectNvidiaModel(model: string): Promise<void> {
    const next: ProviderSettingsDocument = {
      ...this.#document,
      providers: {
        ...this.#document.providers,
        nvidia: { model: modelIdSchema.parse(model) },
      },
    };
    await writeAtomic(this.#path, `${JSON.stringify(next, null, 2)}\n`);
    this.#document = next;
  }
}

type ModelsPayload = {
  data?: Array<{ id?: unknown }>;
};

export function classifyNvidiaModelSelection(
  model: string,
  availableModels: readonly string[],
): 'available' | 'catalog-required' | 'not-in-catalog' {
  if (availableModels.length === 0) return 'catalog-required';
  return availableModels.includes(model) ? 'available' : 'not-in-catalog';
}

export async function fetchNvidiaModelIds(options: {
  auth: EnvironmentAuthBroker & CredentialExecutor;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const baseUrl = assertNvidiaBaseUrl(options.baseUrl);
  const handle = await options.auth.resolveCredential('nvidia');
  return options.auth.withCredential(handle, async (credential) => {
    const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${credential}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new Error(
        `NVIDIA model catalog request failed (${response.status})`,
      );
    }
    const payload = (await response.json()) as ModelsPayload;
    if (!Array.isArray(payload.data)) {
      throw new Error('NVIDIA model catalog returned an invalid response');
    }
    return [
      ...new Set(
        payload.data
          .map((entry) => entry.id)
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => modelIdSchema.safeParse(id).success),
      ),
    ].sort((left, right) => left.localeCompare(right));
  });
}

export function nvidiaBaseUrlFromEnvironment(): 'https://integrate.api.nvidia.com/v1' {
  assertNvidiaBaseUrl(
    process.env.NVIDIA_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
  );
  return 'https://integrate.api.nvidia.com/v1';
}
