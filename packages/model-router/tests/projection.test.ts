import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AttestedArchiveRecord } from '../../archive-store/index';
import { ArchiveStore } from '../../archive-store/index';
import {
  createAuthorizedModelProjection,
  createAuthorizedModelProjectionReceipt,
  createRedactionProjection,
  isLocallyGeneratedAuthorizedProjection,
  MODEL_PROJECTION_POLICY_VERSION,
  projectionMessages,
  type AuthorizedModelProjection,
} from '../src/index';

function sensitiveRecord(): AttestedArchiveRecord {
  const directory = mkdtempSync(join(tmpdir(), 'arena-projection-'));
  try {
    const store = new ArchiveStore({
      databasePath: ':memory:',
      evidenceDirectory: join(directory, 'evidence'),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });
    const committed = store.commitRecord({
      record: {
        kind: 'chat',
        platform: 'gray-swan',
        externalId: 'remote-secret-id',
        dataPolicy: 'zdr_router_allowed',
        externalProcessingAllowed: true,
        embargoUntil: null,
        title: 'Contact alice@example.com',
        status: 'complete',
        normalized: {
          behavior: 'Call +86 138-0013-8000',
          modelAlias: 'fixture-model',
          sourceUrl: 'https://private.invalid/item?token=secret',
          parserVersion: '1.0.0',
          selectorContractVersion: 'fixture-v1',
        },
        messages: [
          {
            ordinal: 0,
            role: 'user',
            content:
              'Authorization: Bearer super-secret-token and alice@example.com; password=correct-horse; visit https://private.invalid/path; -----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----',
          },
        ],
      },
      evidence: [
        {
          artifactType: 'page_html',
          content: '<html>sensitive fixture</html>',
          metadata: { sourceUrl: 'https://private.invalid/item' },
        },
      ],
      checkpoint: { scope: 'fixture', cursor: 'fixture', expectedVersion: 0 },
    });
    const value = store.attestRecord(committed.recordId);
    store.close();
    if (!value) throw new Error('fixture attestation missing');
    return value;
  } finally {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 20,
    });
  }
}

describe('deterministic model projections', () => {
  it('generates stable source, policy, projection, and authorization hashes', () => {
    const first = createAuthorizedModelProjection(sensitiveRecord());
    const second = createAuthorizedModelProjection(sensitiveRecord());
    expect(first).toEqual(second);
    expect(first.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.projectionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.policyVersion).toBe(MODEL_PROJECTION_POLICY_VERSION);
    expect(first.authorization.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.authorization.authorizationHash).toMatch(
      /^sha256:[a-f0-9]{64}$/,
    );
    expect(Object.isFrozen(first)).toBe(true);
    expect(isLocallyGeneratedAuthorizedProjection(first)).toBe(true);
  });

  it('redacts sensitive text and omits raw URLs, remote IDs, and storage paths', () => {
    const projection = createRedactionProjection(sensitiveRecord());
    const encoded = JSON.stringify(projection);
    expect(encoded).toContain('[REDACTED_EMAIL]');
    expect(encoded).toContain('Bearer [REDACTED_TOKEN]');
    expect(encoded).toContain('[REDACTED_PHONE]');
    expect(encoded).toContain('[REDACTED_CREDENTIAL]');
    expect(encoded).toContain('[REDACTED_URL]');
    expect(encoded).toContain('[REDACTED_PRIVATE_KEY]');
    expect(encoded).not.toContain('alice@example.com');
    expect(encoded).not.toContain('private.invalid');
    expect(encoded).not.toContain('correct-horse');
    expect(encoded).not.toContain('secret-key-body');
    expect(encoded).not.toContain('remote-secret-id');
    expect(encoded).not.toContain('secret.html');
  });

  it('rejects a serialized or cloned projection at the provider boundary', () => {
    const projection = createAuthorizedModelProjection(sensitiveRecord());
    const clone = JSON.parse(
      JSON.stringify(projection),
    ) as AuthorizedModelProjection;
    expect(isLocallyGeneratedAuthorizedProjection(clone)).toBe(false);
    expect(() => projectionMessages(clone)).toThrow(/not generated/);
  });

  it('rejects an archive record attestation cloned outside the store', () => {
    const cloned = structuredClone(sensitiveRecord());
    expect(() => createAuthorizedModelProjection(cloned)).toThrow(
      /not attested/,
    );
  });

  it('creates a content-free receipt for model-facing semantic tools', () => {
    const projection = createAuthorizedModelProjection(sensitiveRecord());
    const receipt = createAuthorizedModelProjectionReceipt(projection);
    const encoded = JSON.stringify(receipt);
    expect(receipt.contentReleased).toBe(false);
    expect(receipt.authorization.dataPolicy).toBe('zdr_router_allowed');
    expect(encoded).not.toContain('messages');
    expect(encoded).not.toContain('alice@example.com');
    expect(encoded).not.toContain('[REDACTED_EMAIL]');
    expect(encoded).not.toContain('Fixture');
  });
});
