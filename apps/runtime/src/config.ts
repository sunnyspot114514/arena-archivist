import { mkdirSync } from 'node:fs';
import { isAbsolute, parse, resolve } from 'node:path';

export type RuntimeConfig = {
  host: '127.0.0.1';
  port: number;
  workspaceRoot: string;
  dataDirectory: string;
  databasePath: string;
  evidenceDirectory: string;
  normalizedDirectory: string;
  analysisDirectory: string;
  exportsDirectory: string;
  checkpointsDirectory: string;
  runtimeStateDirectory: string;
  credentialDirectory: string;
  providerSettingsPath: string;
  browserProfileDirectory: string;
  authStartUrl: string;
  liveCollectionEnabled: boolean;
  liveIndexUrl: string | null;
  liveSelectorContractPath: string | null;
  staticOrigins: string[];
  readOnlyGraphqlEndpoints: string[];
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(
      'ARENA_RUNTIME_PORT must be an integer between 1 and 65535',
    );
  }
  return parsed;
}

function commaList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeDirectory(value: string, label: string): string {
  const directory = resolve(value);
  if (directory === parse(directory).root) {
    throw new Error(`${label} cannot be a filesystem root`);
  }
  return directory;
}

function optionalPath(
  value: string | undefined,
  workspaceRoot: string,
): string | null {
  if (!value?.trim()) return null;
  return isAbsolute(value) ? resolve(value) : resolve(workspaceRoot, value);
}

export function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  workspaceRoot = resolve('.'),
): RuntimeConfig {
  const host = env.ARENA_RUNTIME_HOST ?? '127.0.0.1';
  if (host !== '127.0.0.1') {
    throw new Error(
      'Arena Archivist is localhost-only; ARENA_RUNTIME_HOST must be 127.0.0.1',
    );
  }

  const dataDirectory = safeDirectory(
    env.ARENA_DATA_DIR ?? resolve(workspaceRoot, 'arena-archivist-data'),
    'ARENA_DATA_DIR',
  );
  const browserProfileDirectory = safeDirectory(
    env.ARENA_BROWSER_PROFILE ??
      env.ARENA_CHROME_PROFILE ??
      resolve(workspaceRoot, 'runtime', 'chrome-profile'),
    'ARENA_BROWSER_PROFILE',
  );
  const liveCollectionEnabled = env.ARENA_LIVE_COLLECTION === 'true';
  const liveIndexUrl = env.ARENA_INDEX_URL?.trim() || null;
  const liveSelectorContractPath = optionalPath(
    env.ARENA_SELECTOR_CONTRACT,
    workspaceRoot,
  );
  if (liveCollectionEnabled && (!liveIndexUrl || !liveSelectorContractPath)) {
    throw new Error(
      'Live collection requires both ARENA_INDEX_URL and ARENA_SELECTOR_CONTRACT',
    );
  }

  const normalizedDirectory = resolve(dataDirectory, 'normalized');
  const evidenceDirectory = resolve(dataDirectory, 'raw');
  const analysisDirectory = resolve(dataDirectory, 'analysis');
  const exportsDirectory = resolve(dataDirectory, 'exports');
  const checkpointsDirectory = resolve(dataDirectory, 'checkpoints');
  const runtimeStateDirectory = safeDirectory(
    env.ARENA_RUNTIME_STATE_DIR ?? resolve(workspaceRoot, '.arena-runtime'),
    'ARENA_RUNTIME_STATE_DIR',
  );
  const credentialDirectory = resolve(runtimeStateDirectory, 'credentials');
  for (const directory of [
    dataDirectory,
    normalizedDirectory,
    evidenceDirectory,
    analysisDirectory,
    exportsDirectory,
    checkpointsDirectory,
    runtimeStateDirectory,
    credentialDirectory,
    browserProfileDirectory,
  ]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    host,
    port: positiveInteger(env.ARENA_RUNTIME_PORT, 4317),
    workspaceRoot,
    dataDirectory,
    databasePath: resolve(normalizedDirectory, 'arena.sqlite'),
    evidenceDirectory,
    normalizedDirectory,
    analysisDirectory,
    exportsDirectory,
    checkpointsDirectory,
    runtimeStateDirectory,
    credentialDirectory,
    providerSettingsPath: resolve(runtimeStateDirectory, 'providers.json'),
    browserProfileDirectory,
    authStartUrl: env.ARENA_AUTH_URL?.trim() || 'https://app.grayswan.ai',
    liveCollectionEnabled,
    liveIndexUrl,
    liveSelectorContractPath,
    staticOrigins: commaList(env.ARENA_STATIC_ORIGINS),
    readOnlyGraphqlEndpoints: commaList(env.ARENA_READ_ONLY_GRAPHQL_ENDPOINTS),
  };
}
