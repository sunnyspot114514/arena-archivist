import { resolve } from 'node:path';

import {
  collectAnalysisPackFiles,
  assertAnalysisPackSecretFree,
} from '../packages/exporter/src/index';

async function main(): Promise<void> {
  const archiveRoot = resolve(
    process.env.ARENA_DATA_DIR ?? resolve('.', 'arena-archivist-data'),
  );
  const files = await collectAnalysisPackFiles(archiveRoot);
  assertAnalysisPackSecretFree(files);
  process.stdout.write(
    `Secret scan passed for ${files.length} export candidate files.\n`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Secret scan failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
