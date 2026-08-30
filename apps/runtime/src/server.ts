import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';

import { ArenaRuntimeController } from './controller';
import { loadRuntimeConfig, type RuntimeConfig } from './config';
import { createRuntimeHttpServer } from './http-server';

export async function startRuntimeServer(
  config = loadRuntimeConfig(),
): Promise<{
  config: RuntimeConfig;
  controller: ArenaRuntimeController;
  server: ReturnType<typeof createRuntimeHttpServer>;
  close: () => Promise<void>;
}> {
  const controller = await ArenaRuntimeController.create(config);
  const server = createRuntimeHttpServer(controller, config);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const close = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await controller.close();
  };

  return { config, controller, server, close };
}

export function loadProjectEnvironment(path = resolve('.env')): boolean {
  if (!existsSync(path)) return false;
  loadEnvFile(path);
  return true;
}

export function loadProjectRuntimeConfig(
  envPath = resolve('.env'),
  workspaceRoot = resolve('.'),
): RuntimeConfig {
  loadProjectEnvironment(envPath);
  return loadRuntimeConfig(process.env, workspaceRoot);
}

async function main(): Promise<void> {
  const runtime = await startRuntimeServer(loadProjectRuntimeConfig());
  const address = runtime.server.address() as AddressInfo;
  process.stdout.write(
    `Arena Runtime listening on http://${address.address}:${address.port}\n`,
  );

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

if (
  process.argv[1]?.replace(/\\/g, '/').endsWith('/apps/runtime/src/server.ts')
) {
  void main().catch((error) => {
    const message =
      error instanceof Error ? error.message : 'Runtime startup failed';
    process.stderr.write(`Arena Runtime failed: ${message}\n`);
    process.exitCode = 1;
  });
}
