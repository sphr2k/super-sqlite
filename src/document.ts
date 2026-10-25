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
  evolution?: DocumentEvolution,
  rowId?: string
): { document: T['infer']; revision: number; version: number } {
  let envelope: Envelope;
  try { envelope = JSON.parse(raw) as Envelope; }
  catch (cause) { throw new DocumentVersionError(`Invalid stored JSON: ${String(cause)}`); }
  if (!envelope || typeof envelope !== 'object' || !('json' in envelope)) {
    throw new DocumentVersionError('Invalid SuperJSON document envelope');
  }
  const revision = envelope._supersqlite?.revision ?? 1;
  const version = envelope._supersqlite?.version ?? 1;
  if (![revision, version].every(v => Number.isSafeInteger(v) && v >= 1)) {
    throw new DocumentVersionError('Invalid stored SuperSQLite version metadata');
  }
  const target = evolution?.version ?? 1;
  if (!Number.isSafeInteger(target) || target < 1) throw new DocumentVersionError('Invalid target schema version');
  if (version > target) throw new DocumentVersionError(`Stored document v${version} is newer than reader v${target}`);
  let document: unknown;
  try { document = superjson.parse(raw); }
  catch (cause) { throw new DocumentVersionError(`Invalid SuperJSON document: ${String(cause)}`); }
  if (evolution) {
    for (let step = version; step < target; step++) {
      const upcaster = evolution.upcasters?.[step];
      if (!upcaster) throw new DocumentVersionError(`Missing upcaster from document v${step} to v${step + 1}`);
      document = upcaster(document);
    }
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new DocumentVersionError('Stored document must be a JSON object');
  }
  const values = document as Record<string, unknown>;
  if (rowId !== undefined) {
    if (values.id !== undefined && values.id !== rowId) {
      throw new DocumentVersionError(`Stored document id mismatch: row ${rowId}`);
    }
    // Legacy schemas may omit ids entirely; SQL id is canonical.
    document = { ...values, id: rowId };
  }
  // Validate every read, regardless of whether evolution is configured.
  // Use output validation to avoid rerunning input morphs on persisted data.
  const validated = schema.out(document);
  if (validated instanceof type.errors) {
      throw new DocumentVersionError(`Invalid document at v${target}: ${validated.summary}`);
  }
  return { document: validated as T['infer'], revision, version };
}
