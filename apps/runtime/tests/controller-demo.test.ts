import { describe, expect, it } from 'vitest';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  ArenaRuntimeController,
  classifyWorkerSettlement,
} from '../src/controller';
import { loadRuntimeConfig } from '../src/config';
import { ArchiveStore } from '../../../packages/archive-store/index';

describe('offline runtime lifecycle', () => {
  it('classifies archive persistence failures as failed ledger outcomes', () => {
    expect(
      classifyWorkerSettlement({
        status: 'stopped',
        stopReason: 'archive_failed',
        committed: 0,
        skippedKnown: 0,
        visitedStates: ['COMMIT'],
      }),
    ).toEqual({ status: 'failed', terminalPhase: 'failed' });
    expect(
      classifyWorkerSettlement({
        status: 'stopped',
        stopReason: 'user_paused',
        committed: 0,
        skippedKnown: 0,
        visitedStates: [],
      }),
    ).toEqual({ status: 'stopped', terminalPhase: 'cancelled' });
    expect(
      classifyWorkerSettlement({
        status: 'stopped',
        stopReason: 'runtime_shutdown',
        committed: 0,
        skippedKnown: 0,
        visitedStates: [],
      }),
    ).toEqual({ status: 'stopped', terminalPhase: 'cancelled' });
  });

  it('uses the registered connector and completes the durable action ledger', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-runtime-demo-'));
    let controller: ArenaRuntimeController | null = null;
    try {
      const config = loadRuntimeConfig(
        {
          NODE_ENV: 'test',
          ARENA_DATA_DIR: join(directory, 'data'),
          ARENA_RUNTIME_STATE_DIR: join(directory, 'runtime-state'),
          ARENA_BROWSER_PROFILE: join(directory, 'browser-profile'),
          ARENA_RUNTIME_PORT: '4317',
        },
        resolve('.'),
      );
      controller = await ArenaRuntimeController.create(config);
      const started = await controller.startSync({
        maxRecords: 2,
        source: 'demo',
      });
      expect(started.run?.actionId).toMatch(/^action_/);
      expect(['authorization', 'dispatch']).toContain(started.run?.actionPhase);
      expect(started.run?.connectorId).toBe('gray-swan');

      let status = await controller.status();
      for (
        let attempt = 0;
        attempt < 100 && status.run?.state === 'running';
        attempt += 1
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        status = await controller.status();
      }
      expect(status.run?.state).toBe('completed');
      expect(status.run?.actionPhase).toBe('canonical_commit');
      expect(status.connectors).toEqual([
        expect.objectContaining({ id: 'gray-swan', readOnly: true }),
      ]);

      const actionId = status.run?.actionId;
      if (!actionId) throw new Error('action id missing');
      const detail = controller.readAction(actionId) as {
        authorization: {
          actionId: string;
          connectorId: string;
          source: string;
          authorizationHash: string;
        };
        events: Array<{ phase: string }>;
        recordCommits: Array<{ actionId: string; recordId: string }>;
      };
      expect(detail.authorization).toEqual(
        expect.objectContaining({
          actionId,
          connectorId: 'gray-swan',
          source: 'loopback_http_policy',
          authorizationHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        }),
      );
      expect(detail.events.map((event) => event.phase)).toEqual([
        'proposal',
        'validation',
        'authorization',
        'dispatch',
        'observation',
        'reconciliation',
        'canonical_commit',
      ]);
      expect(detail.recordCommits).toHaveLength(2);
      expect(
        detail.recordCommits.every((commit) => commit.actionId === actionId),
      ).toBe(true);
      expect(controller.queryRecords({ limit: 10 }).items).toHaveLength(2);

      await controller.startSync({ maxRecords: 2, source: 'demo' });
      let replay = await controller.status();
      for (
        let attempt = 0;
        attempt < 100 && replay.run?.state === 'running';
        attempt += 1
      ) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
        replay = await controller.status();
      }
      expect(replay.run).toEqual(
        expect.objectContaining({
          state: 'completed',
          actionPhase: 'canonical_commit',
          committed: 0,
          skippedKnown: 2,
        }),
      );
    } finally {
      if (controller) await controller.close();
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it('recovers an interrupted dispatched action as failed without replay', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'arena-runtime-recovery-'));
    let controller: ArenaRuntimeController | null = null;
    try {
      const config = loadRuntimeConfig(
        {
          NODE_ENV: 'test',
          ARENA_DATA_DIR: join(directory, 'data'),
          ARENA_RUNTIME_STATE_DIR: join(directory, 'runtime-state'),
          ARENA_BROWSER_PROFILE: join(directory, 'browser-profile'),
          ARENA_RUNTIME_PORT: '4317',
        },
        resolve('.'),
      );
      const store = new ArchiveStore({
        databasePath: config.databasePath,
        evidenceDirectory: config.evidenceDirectory,
      });
      const created = store.startAuthorizedSyncRun({
        id: 'run_interrupted',
        actionId: 'action_interrupted',
        requestedMaxRecords: 1,
        connectorId: 'gray-swan',
        connectorVersion: '1.0.0',
        policyVersion: 'arena-read-only-sync-v1',
        request: { source: 'demo', maxRecords: 1 },
        authorization: {
          principal: 'loopback_runtime_client',
          decisionCode: 'bounded_readonly_policy_allow',
        },
      });
      store.advanceAction(created.actionId, 'dispatch');
      store.close();

      controller = await ArenaRuntimeController.create(config);
      const status = await controller.status();
      expect(status.run).toEqual(
        expect.objectContaining({
          id: created.runId,
          actionId: created.actionId,
          state: 'failed',
          actionPhase: 'failed',
          stopReason: 'process_restarted',
        }),
      );
      const detail = controller.readAction(created.actionId) as {
        events: Array<{ phase: string; payload: Record<string, unknown> }>;
      };
      expect(detail.events.map((event) => event.phase)).toEqual([
        'proposal',
        'validation',
        'authorization',
        'dispatch',
        'observation',
        'failed',
      ]);
      expect(detail.events.at(-2)?.payload).toEqual(
        expect.objectContaining({ recovery: true }),
      );
    } finally {
      if (controller) await controller.close();
      rmSync(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });
});
