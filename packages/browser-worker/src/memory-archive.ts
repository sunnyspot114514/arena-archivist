import type { RecordKind } from '../../gray-swan-adapter/src/types.js';
import type {
  ArchiveCommitInput,
  ArchiveCommitResult,
  ArchivePort,
  CheckpointUpdate,
} from './types.js';

function archiveKey(kind: RecordKind, externalId: string): string {
  return `${kind}\0${externalId}`;
}

/** Offline/demo archive only. Production wiring must provide a transactional local store. */
export class MemoryArchive implements ArchivePort {
  readonly records = new Map<string, ArchiveCommitInput>();
  readonly checkpoints: CheckpointUpdate[] = [];

  async hasRecord(kind: RecordKind, externalId: string): Promise<boolean> {
    return this.records.has(archiveKey(kind, externalId));
  }

  async commitRecord(input: ArchiveCommitInput): Promise<ArchiveCommitResult> {
    const key = archiveKey(input.record.kind, input.record.externalId);
    const committed = !this.records.has(key);
    // There are no asynchronous operations between these in-memory writes. Production uses the
    // same single-call contract but implements it with an actual database transaction.
    if (committed) this.records.set(key, input);
    this.checkpoints.push(input.checkpoint);
    return { committed, canonicalRecordId: key };
  }
}
