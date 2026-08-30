import { afterEach, describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  loadProjectEnvironment,
  loadProjectRuntimeConfig,
} from '../src/server';

const ENV_NAME = 'ARENA_TEST_PROJECT_ENV_FILE';
const directories: string[] = [];
const managedNames = [
  ENV_NAME,
  'ARENA_RUNTIME_HOST',
  'ARENA_RUNTIME_PORT',
  'ARENA_DATA_DIR',
  'ARENA_RUNTIME_STATE_DIR',
  'ARENA_BROWSER_PROFILE',
] as const;
const originalEnvironment = new Map(
  managedNames.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of managedNames) {
    const original = originalEnvironment.get(name);
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('runtime project environment', () => {
  it('loads an existing project env file without requiring dotenv', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-runtime-env-'));
    directories.push(directory);
    const path = join(directory, '.env');
    writeFileSync(path, `${ENV_NAME}=loaded\n`, 'utf8');

    expect(loadProjectEnvironment(path)).toBe(true);
    expect(process.env[ENV_NAME]).toBe('loaded');
  });

  it('loads the project env before constructing the default runtime config', () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-runtime-config-'));
    directories.push(directory);
    const path = join(directory, '.env');
    const portable = (value: string) => value.replace(/\\/gu, '/');
    for (const name of managedNames) delete process.env[name];
    writeFileSync(
      path,
      [
        'ARENA_RUNTIME_HOST=127.0.0.1',
        'ARENA_RUNTIME_PORT=54321',
        `ARENA_DATA_DIR=${portable(join(directory, 'data'))}`,
        `ARENA_RUNTIME_STATE_DIR=${portable(join(directory, 'state'))}`,
        `ARENA_BROWSER_PROFILE=${portable(join(directory, 'profile'))}`,
      ].join('\n'),
      'utf8',
    );

    const config = loadProjectRuntimeConfig(path, directory);
    expect(config.port).toBe(54_321);
    expect(config.dataDirectory).toBe(resolve(directory, 'data'));
    expect(config.runtimeStateDirectory).toBe(resolve(directory, 'state'));
    expect(config.browserProfileDirectory).toBe(resolve(directory, 'profile'));
  });

  it('silently skips a missing project env file', () => {
    expect(loadProjectEnvironment(join(tmpdir(), 'arena-env-missing'))).toBe(
      false,
    );
  });
});
