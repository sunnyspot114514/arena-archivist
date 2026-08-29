import { describe, expect, it } from 'vitest';

import type { JsonValue } from '@deepseek-ai/dsh-session';

import {
  ARENA_TOOL_NAME_LIST,
  toArenaStatus,
  toArchiveHandlePage,
  toExportReceipt,
  toProjectionReceipt,
  toSyncHandle,
} from '../src/index';

describe('Arena DSH semantic boundary', () => {
  it('has exactly five narrow tools and no generic execution primitive', () => {
    expect(ARENA_TOOL_NAME_LIST).toEqual([
      'arena_session_status',
      'arena_sync_next_batch',
      'arena_query_archive',
      'arena_read_archived_record',
      'arena_export',
    ]);
    const joined = ARENA_TOOL_NAME_LIST.join(' ');
    for (const forbidden of [
      'playwright',
      'browser',
      'shell',
      'filesystem',
      'fetch',
      'click',
      'type',
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it('reduces archive queries to content-free handles', () => {
    const page = toArchiveHandlePage({
      items: [
        {
          id: 'chat_1',
          kind: 'chat',
          platform: 'gray-swan',
          dataPolicy: 'local_only',
          sourceHash: `sha256:${'a'.repeat(64)}`,
          updatedAt: '2026-08-29T00:00:00.000Z',
          title: 'alice@example.com secret',
          outcome: 'private result',
          payload: { messages: ['raw content'] },
        },
      ],
      nextCursor: 'opaque',
      queryHash: `sha256:${'b'.repeat(64)}`,
      catalogGeneration: 2,
    } as Record<string, JsonValue>);
    const encoded = JSON.stringify(page);
    expect(page.items).toHaveLength(1);
    expect(encoded).toContain('chat_1');
    expect(encoded).not.toContain('alice@example.com');
    expect(encoded).not.toContain('private result');
    expect(encoded).not.toContain('raw content');
    expect(encoded).not.toContain('title');
    expect(encoded).not.toContain('outcome');
  });

  it('whitelists every other model-facing runtime result', () => {
    const status = toArenaStatus({
      service: { state: 'ready', version: '0.1.0', host: '127.0.0.1' },
      browser: {
        mode: 'DEMO_MODE',
        session: 'valid',
        liveCollectionEnabled: false,
        selectorContract: 'missing',
        profileDirectory: 'C:\\secret-profile',
      },
      archive: {
        totalRecords: 1,
        chats: 1,
        submissions: 0,
        lastCheckpoint: {
          scope: 'fixture',
          cursor: 'external_record_secret',
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
      },
      run: null,
      budget: { runsToday: 0, maxRunsPerDay: 3, maxRecordsPerRun: 25 },
      connectors: [{ id: 'gray-swan', version: '1.0.0', readOnly: true }],
    } as Record<string, JsonValue>);
    expect(JSON.stringify(status)).not.toContain('external_record_secret');
    expect(JSON.stringify(status)).not.toContain('secret-profile');

    const sync = toSyncHandle({
      run: {
        id: 'run_1',
        actionId: 'action_1',
        actionPhase: 'authorization',
        connectorId: 'gray-swan',
        state: 'running',
        source: 'demo',
        requested: 1,
        rawRequest: 'secret',
      },
    } as Record<string, JsonValue>);
    expect(JSON.stringify(sync)).not.toContain('rawRequest');

    const receipt = toProjectionReceipt({
      projectionReceipt: {
        kind: 'authorized_model_projection_receipt',
        sourceHash: `sha256:${'a'.repeat(64)}`,
        policyVersion: 'arena-model-projection-v1',
        projectionHash: `sha256:${'b'.repeat(64)}`,
        record: {
          id: 'chat_1',
          kind: 'chat',
          platform: 'gray-swan',
          updatedAt: '2026-08-29T00:00:00.000Z',
        },
        authorization: {
          dataPolicy: 'local_only',
          policyHash: `sha256:${'c'.repeat(64)}`,
          authorizationHash: `sha256:${'d'.repeat(64)}`,
        },
        contentReleased: false,
        payload: { messages: ['must not escape'] },
      },
    } as Record<string, JsonValue>);
    expect(JSON.stringify(receipt)).not.toContain('must not escape');

    expect(
      toExportReceipt({
        path: 'C:\\secret\\analysis-pack.zip',
        includedPaths: ['raw/private.html'],
        sha256: 'e'.repeat(64),
      }),
    ).toEqual({ status: 'created', sha256: 'e'.repeat(64) });
  });
});
