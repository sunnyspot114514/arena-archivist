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
  MODEL_PROJECTION_ALLOWED_SENSITIVITY_CLASSES,
  MODEL_PROJECTION_POLICY_VERSION,
  MODEL_PROJECTION_REMOVED_SENSITIVITY_CLASSES,
  projectionMessages,
  type AuthorizedModelProjection,
} from '../src/index';

function sensitiveFixture(): {
  store: ArchiveStore;
  attestation: AttestedArchiveRecord;
  updatePolicy: (level: 'local_only' | 'zdr_router_allowed') => void;
  cleanup: () => void;
} {
  const directory = mkdtempSync(join(tmpdir(), 'arena-projection-'));
  try {
    const store = new ArchiveStore({
      databasePath: ':memory:',
      evidenceDirectory: join(directory, 'evidence'),
      now: () => new Date('2026-08-29T00:00:00.000Z'),
    });
    const commit = (level: 'local_only' | 'zdr_router_allowed') =>
      store.commitRecord({
        record: {
          kind: 'chat',
          platform: 'gray-swan',
          externalId: 'remote-secret-id',
          dataPolicy: level,
          externalProcessingAllowed: level !== 'local_only',
          embargoUntil: null,
          title: 'Contact alice@example.com',
          status: 'complete',
          normalized: {
            behavior: 'Call +86 138-0013-8000',
            modelAlias: 'fixture-model',
            displayName: 'Alice Reviewer',
            sourceUrl: 'https://private.invalid/item?token=secret',
            attachments: [{ fileName: 'customer-evidence.pdf' }],
            parserVersion: '1.0.0',
            selectorContractVersion: 'fixture-v1',
          },
          messages: [
            {
              ordinal: 0,
              role: 'Alice Reviewer',
              content:
                'Authorization: Bearer super-secret-token and alice@example.com; password=correct-horse; {"api_key": "plain-json-secret-value"}; attached customer-evidence.pdf; visit https://private.invalid/path, ftp://private.invalid/file, file:///C:/private.txt, //private.invalid/relative and bare.private.invalid/path; -----BEGIN PRIVATE KEY-----\nsecret-key-body\n-----END PRIVATE KEY-----',
            },
          ],
        },
        evidence: [
          {
            artifactType: 'page_html',
            content: '<html>RAW_EVIDENCE_MARKER sensitive fixture</html>',
            metadata: {
              sourceUrl: 'https://private.invalid/item',
              fileName: 'customer-evidence.pdf',
            },
          },
        ],
        checkpoint: {
          scope: 'fixture',
          cursor: 'fixture',
          expectedVersion: store.getCheckpoint('fixture')?.version ?? 0,
        },
      });
    const committed = commit('zdr_router_allowed');
    const value = store.attestRecord(committed.recordId);
    if (!value) throw new Error('fixture attestation missing');
    return {
      store,
      attestation: value,
      updatePolicy: (level) => {
        commit(level);
      },
      cleanup: () => {
        store.close();
        rmSync(directory, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 20,
        });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

describe('deterministic model projections', () => {
  it('generates stable source, policy, projection, and authorization hashes', () => {
    const firstFixture = sensitiveFixture();
    const secondFixture = sensitiveFixture();
    try {
      const first = createAuthorizedModelProjection(firstFixture.attestation);
      const second = createAuthorizedModelProjection(secondFixture.attestation);
      expect(first).toEqual(second);
      expect(first.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.sourceRecordId).toBe(first.payload.record.id);
      expect(first.projectionId).toMatch(/^projection_[a-f0-9]{32}$/);
      expect(first.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.projectionHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.policyVersion).toBe(MODEL_PROJECTION_POLICY_VERSION);
      expect(first.authorization.policyHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(first.authorization.authorizationHash).toMatch(
        /^sha256:[a-f0-9]{64}$/,
      );
      expect(first.payload.sensitivity.allowedClasses).toEqual(
        MODEL_PROJECTION_ALLOWED_SENSITIVITY_CLASSES,
      );
      expect(first.payload.sensitivity.removedClasses).toEqual(
        MODEL_PROJECTION_REMOVED_SENSITIVITY_CLASSES,
      );
      expect(Object.isFrozen(first)).toBe(true);
      expect(isLocallyGeneratedAuthorizedProjection(first)).toBe(true);
    } finally {
      secondFixture.cleanup();
      firstFixture.cleanup();
    }
  });

  it('redacts credentials and URLs, pseudonymizes display roles, and omits evidence', () => {
    const fixture = sensitiveFixture();
    try {
      const projection = createRedactionProjection(fixture.attestation);
      const encoded = JSON.stringify(projection);
      expect(encoded).toContain('[REDACTED_EMAIL]');
      expect(encoded).toContain('Bearer [REDACTED_TOKEN]');
      expect(encoded).toContain('[REDACTED_PHONE]');
      expect(encoded).toContain('[REDACTED_CREDENTIAL]');
      expect(encoded).toContain('[REDACTED_FILENAME]');
      expect(encoded).toContain('[REDACTED_URL]');
      expect(encoded).toContain('[REDACTED_PRIVATE_KEY]');
      expect(projection.payload.messages[0].role).toMatch(
        /^participant_[a-f0-9]{12}$/,
      );
      expect(encoded).not.toContain('Alice Reviewer');
      expect(encoded).not.toContain('alice@example.com');
      expect(encoded).not.toContain('private.invalid');
      expect(encoded).not.toContain('plain-json-secret-value');
      expect(encoded).not.toContain('correct-horse');
      expect(encoded).not.toContain('secret-key-body');
      expect(encoded).not.toContain('remote-secret-id');
      expect(encoded).not.toContain('customer-evidence.pdf');
      expect(encoded).not.toContain('RAW_EVIDENCE_MARKER');
      expect(encoded).not.toContain('parserVersion');
      expect(encoded).not.toContain('selectorContractVersion');
      expect(encoded).not.toContain('fixture-v1');
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects a serialized or cloned projection at the provider boundary', () => {
    const fixture = sensitiveFixture();
    try {
      const projection = createAuthorizedModelProjection(fixture.attestation);
      const clone = JSON.parse(
        JSON.stringify(projection),
      ) as AuthorizedModelProjection;
      expect(isLocallyGeneratedAuthorizedProjection(clone)).toBe(false);
      expect(() => projectionMessages(clone)).toThrow(/not generated/);
    } finally {
      fixture.cleanup();
    }
  });

  it('rejects an archive record attestation cloned outside the store', () => {
    const fixture = sensitiveFixture();
    try {
      const cloned = structuredClone(fixture.attestation);
      expect(() => createAuthorizedModelProjection(cloned)).toThrow(
        /not attested/,
      );
    } finally {
      fixture.cleanup();
    }
  });

  it('invalidates attestations and projections when the catalog policy changes', () => {
    const fixture = sensitiveFixture();
    try {
      const projection = createAuthorizedModelProjection(fixture.attestation);
      expect(isLocallyGeneratedAuthorizedProjection(projection)).toBe(true);
      fixture.updatePolicy('local_only');
      expect(isLocallyGeneratedAuthorizedProjection(projection)).toBe(false);
      expect(() => projectionMessages(projection)).toThrow(/not generated/);
      expect(() =>
        createAuthorizedModelProjection(fixture.attestation),
      ).toThrow(/not attested/);
    } finally {
      fixture.cleanup();
    }
  });

  it('creates a content-free receipt for model-facing semantic tools', () => {
    const fixture = sensitiveFixture();
    try {
      const projection = createAuthorizedModelProjection(fixture.attestation);
      const receipt = createAuthorizedModelProjectionReceipt(projection);
      const encoded = JSON.stringify(receipt);
      expect(receipt.contentReleased).toBe(false);
      expect(receipt.projectionId).toBe(projection.projectionId);
      expect(receipt.sourceRecordId).toBe(projection.sourceRecordId);
      expect(receipt.contentHash).toBe(projection.contentHash);
      expect(receipt.authorization.dataPolicy).toBe('zdr_router_allowed');
      expect(encoded).not.toContain('messages');
      expect(encoded).not.toContain('alice@example.com');
      expect(encoded).not.toContain('[REDACTED_EMAIL]');
      expect(encoded).not.toContain('Fixture');
    } finally {
      fixture.cleanup();
    }
  });
});
