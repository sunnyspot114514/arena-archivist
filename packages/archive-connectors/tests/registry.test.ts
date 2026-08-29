import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { ArchiveConnectorRegistry, type ArchiveConnector } from '../src/index';
import { graySwanArchiveConnector } from '../../gray-swan-adapter/src/index';

describe('archive connector registry', () => {
  it('registers Gray Swan as the first read-only connector', () => {
    const registry = new ArchiveConnectorRegistry();
    const connector = registry.register(graySwanArchiveConnector);
    expect(connector).toBe(graySwanArchiveConnector);
    expect(registry.get('gray-swan')).not.toBe(graySwanArchiveConnector);
    expect(registry.get('gray-swan')).toEqual({
      metadata: expect.objectContaining({ id: 'gray-swan', readOnly: true }),
    });
    expect(registry.get('gray-swan')).not.toHaveProperty('parseRecord');
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: 'gray-swan',
        version: '1.0.0',
        readOnly: true,
        cursorFormat: 'gray-swan-index-v1',
      }),
    ]);
    expect(registry.list()[0]).not.toHaveProperty('parseRecord');
  });

  it('rejects duplicate or write-capable connectors', () => {
    const registry = new ArchiveConnectorRegistry();
    registry.register(graySwanArchiveConnector);
    expect(() => registry.register(graySwanArchiveConnector)).toThrow(
      /already registered/,
    );
    const unsafe = {
      metadata: {
        ...graySwanArchiveConnector.metadata,
        id: 'unsafe',
        readOnly: false,
      },
    } as unknown as ArchiveConnector;
    expect(() => new ArchiveConnectorRegistry().register(unsafe)).toThrow(
      /read-only/,
    );
  });

  it('delegates Gray Swan fixture parsing to the existing adapter facade', async () => {
    const contract = await graySwanArchiveConnector.loadContract(
      resolve('packages/gray-swan-adapter/contracts/grayswan.fixture-v1.json'),
    );
    const html = await readFile(
      resolve('packages/gray-swan-adapter/fixtures/html/index.html'),
      'utf8',
    );
    const parsed = graySwanArchiveConnector.parseIndex(
      {
        url: 'https://fixture.invalid/arena/archive',
        title: 'fixture index',
        html,
        visibleText: 'fixture index',
        capturedAt: '2026-08-29T00:00:00.000Z',
      },
      contract,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.records).toHaveLength(2);
  });
});
