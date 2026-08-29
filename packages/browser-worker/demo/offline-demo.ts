import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadSelectorContract } from '../../gray-swan-adapter/src/contract.js';
import { MemoryArchive } from '../src/memory-archive.js';
import {
  OfflineFixtureBrowser,
  type OfflineFixturePage,
} from '../src/offline-fixture-browser.js';
import { GraySwanBrowserWorker } from '../src/state-machine.js';
import type { WorkerRunResult } from '../src/types.js';

async function fixturePage(
  fixtureDirectory: string,
  file: string,
  url: string,
  title: string,
): Promise<OfflineFixturePage> {
  return {
    url,
    title,
    html: await readFile(resolve(fixtureDirectory, file), 'utf8'),
    visibleText: title,
  };
}

/** Runs the full collector against synthetic files only. It never creates a network client. */
export async function runOfflineDemo(
  workspaceRoot = resolve('.'),
): Promise<{ readonly run: WorkerRunResult; readonly archive: MemoryArchive }> {
  const adapterRoot = resolve(workspaceRoot, 'packages/gray-swan-adapter');
  const fixtureDirectory = resolve(adapterRoot, 'fixtures/html');
  const contract = await loadSelectorContract(
    resolve(adapterRoot, 'contracts/grayswan.fixture-v1.json'),
  );
  const pages = await Promise.all([
    fixturePage(
      fixtureDirectory,
      'index.html',
      'https://fixture.invalid/arena/archive',
      'Archive fixture index',
    ),
    fixturePage(
      fixtureDirectory,
      'chat-001.html',
      'https://fixture.invalid/arena/archive/chat_001',
      'First synthetic chat',
    ),
    fixturePage(
      fixtureDirectory,
      'submission-001.html',
      'https://fixture.invalid/arena/archive/submission_001',
      'Synthetic judged submission',
    ),
  ]);
  const browser = new OfflineFixtureBrowser(pages);
  const archive = new MemoryArchive();
  const worker = new GraySwanBrowserWorker(
    {
      indexUrl: 'https://fixture.invalid/arena/archive',
      minRecordOpenIntervalMs: 0,
    },
    { browser, archive, selectorContract: contract, sleep: async () => {} },
  );
  const run = await worker.runNextBatch({ maxRecords: 10 });
  return { run, archive };
}
