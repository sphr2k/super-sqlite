import { type, type Type } from 'arktype';
import superjson from 'superjson';

export interface DocumentEvolution {
  /** Current logical document schema version, starting at 1. */
  version: number;
  /** Each function transforms from key N to version N + 1. */
  upcasters?: Record<number, (document: unknown) => unknown>;
}

export class DocumentVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentVersionError';
  }
}

interface Envelope {
  _supersqlite?: { revision: number; version: number };
  json: unknown;
  meta?: unknown;
}

export function serializeDocument(value: unknown, revision = 1, version = 1): string {
  const envelope = JSON.parse(superjson.stringify(value)) as Envelope;
  envelope._supersqlite = { revision, version };
  return JSON.stringify(envelope);
}

export function readDocument<T extends Type<any>>(
  raw: string,
  schema: T,
  evolution?: DocumentEvolution
): { document: T['infer']; revision: number; version: number } {
  const envelope = JSON.parse(raw) as Envelope;
  const revision = envelope._supersqlite?.revision ?? 1;
  const version = envelope._supersqlite?.version ?? 1;
  if (![revision, version].every(v => Number.isSafeInteger(v) && v >= 1)) {
    throw new DocumentVersionError('Invalid stored SuperSQLite version metadata');
  }
  const target = evolution?.version ?? 1;
  if (!Number.isSafeInteger(target) || target < 1) throw new DocumentVersionError('Invalid target schema version');
  if (version > target) throw new DocumentVersionError(`Stored document v${version} is newer than reader v${target}`);
  let document: unknown = superjson.parse(raw);
  if (evolution) {
    for (let step = version; step < target; step++) {
      const upcaster = evolution.upcasters?.[step];
      if (!upcaster) throw new DocumentVersionError(`Missing upcaster from document v${step} to v${step + 1}`);
      document = upcaster(document);
    }
    // Validate only the final output shape, even for read-time upcasts.
    const validated = schema.out(document);
    if (validated instanceof type.errors) {
      throw new DocumentVersionError(`Invalid document at v${target}: ${validated.summary}`);
    }
    document = validated;
  }
  return { document: document as T['infer'], revision, version };
}
