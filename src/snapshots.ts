import { type, type Type } from 'arktype';
import { ulid } from 'ulid';
import type { SQLiteAdapter, SqlRow, SqlStatement } from './adapters/types.js';
import { readDocument, serializeDocument } from './document.js';
import { identifier } from './fields.js';

const Stored = type({ id: 'string', batchId: 'string', value: 'unknown' });

export class SnapshotConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotConflictError'; }
}
export class SnapshotNotFoundError extends Error {
  constructor(id: string) { super(`Unknown snapshot import: ${id}`); this.name = 'SnapshotNotFoundError'; }
}
export class IncompleteSnapshotError extends Error {
  constructor(readonly actual: number, readonly expected: number) {
    super(`Incomplete snapshot: ${actual} of ${expected} documents`);
    this.name = 'IncompleteSnapshotError';
  }
}

export interface SnapshotHead {
  namespace: string;
  batchId: string;
  digest: string;
  checkedAt: string;
  changedAt: string;
}
export interface SnapshotImport {
  batchId: string;
  namespace: string;
  digest: string;
  expectedRows: number;
  parentBatchId: string | null;
  startedAt: string;
}
export interface SnapshotPage<T> {
  documents: T[];
  nextCursor: string | null;
  batchId: string | null;
}
export type BeginResult =
  | { status: 'unchanged'; batchId: string }
  | { status: 'upload'; batchId: string };
export interface SnapshotRecord<T> { id: string; batchId: string; value: T }

const now = () => new Date().toISOString();
const ensureText = (value: string, label: string) => {
  if (!value || value.length > 200 || typeof value !== 'string') throw new TypeError(`Invalid ${label}`);
};

export function createSnapshotStore<T extends Type<any>>(name: string, schema: T, adapter: SQLiteAdapter) {
  identifier(name);
  const records = `"${name}_documents"`;
  const batches = `"${name}_batches"`;
  const heads = `"${name}_heads"`;
  const batchIndex = `"idx_${name}_documents_batch"`;
  const batchExpr = "json_extract(data, '$.json.batchId')";
  type Value = T['infer'];

  async function getBatch(batchId: string): Promise<SnapshotImport> {
    const row = await adapter.get<{
      id: string; namespace: string; digest: string; expected_rows: number;
      parent_batch_id: string | null; started_at: string;
    }>({ sql: `SELECT * FROM ${batches} WHERE id = ?`, params: [batchId] });
    if (!row) throw new SnapshotNotFoundError(batchId);
    return {
      batchId: row.id, namespace: row.namespace, digest: row.digest,
      expectedRows: row.expected_rows, parentBatchId: row.parent_batch_id,
      startedAt: row.started_at
    };
  }

  function decode(row: { id: string; data: string }): SnapshotRecord<Value> {
    const parsed = readDocument(row.data, Stored, undefined, row.id).document;
    const value = schema.out(parsed.value);
    if (value instanceof type.errors) {
      throw new Error(`Invalid snapshot document ${row.id}: ${value.summary}`);
    }
    return { id: row.id, batchId: parsed.batchId, value: value as Value };
  }

  return {
    async initialize(): Promise<void> {
      await adapter.run({ sql: `CREATE TABLE IF NOT EXISTS ${records} (id TEXT PRIMARY KEY, data TEXT NOT NULL)` });
      await adapter.run({ sql: `CREATE INDEX IF NOT EXISTS ${batchIndex} ON ${records} (${batchExpr})` });
      await adapter.run({ sql: `CREATE TABLE IF NOT EXISTS ${batches} (
        id TEXT PRIMARY KEY, namespace TEXT NOT NULL, digest TEXT NOT NULL,
        expected_rows INTEGER NOT NULL, parent_batch_id TEXT, started_at TEXT NOT NULL
      )` });
      await adapter.run({ sql: `CREATE INDEX IF NOT EXISTS "idx_${name}_batches_namespace" ON ${batches} (namespace)` });
      await adapter.run({ sql: `CREATE TABLE IF NOT EXISTS ${heads} (
        namespace TEXT PRIMARY KEY, batch_id TEXT NOT NULL,
        digest TEXT NOT NULL, checked_at TEXT NOT NULL, changed_at TEXT NOT NULL
      )` });
    },

    async head(namespace: string): Promise<SnapshotHead | undefined> {
      ensureText(namespace, 'namespace');
      const row = await adapter.get<{
        namespace: string; batch_id: string; digest: string;
        checked_at: string; changed_at: string;
      }>({ sql: `SELECT * FROM ${heads} WHERE namespace = ?`, params: [namespace] });
      return row && {
        namespace: row.namespace, batchId: row.batch_id, digest: row.digest,
        checkedAt: row.checked_at, changedAt: row.changed_at
      };
    },

    async listHeads(): Promise<SnapshotHead[]> {
      const rows = await adapter.all<{
        namespace: string; batch_id: string; digest: string;
        checked_at: string; changed_at: string;
      }>({ sql: `SELECT * FROM ${heads} ORDER BY namespace` });
      return rows.map(row => ({
        namespace: row.namespace, batchId: row.batch_id, digest: row.digest,
        checkedAt: row.checked_at, changedAt: row.changed_at
      }));
    },

    async begin(namespace: string, digest: string, expectedRows: number): Promise<BeginResult> {
      ensureText(namespace, 'namespace');
      ensureText(digest, 'digest');
      if (!Number.isSafeInteger(expectedRows) || expectedRows < 1 || expectedRows > 1_000_000) {
        throw new RangeError('expectedRows must be an integer in 1..1000000');
      }
      const prior = await this.head(namespace);
      if (prior?.digest === digest) return { status: 'unchanged', batchId: prior.batchId };
      const batchId = ulid();
      await adapter.run({
        sql: `INSERT INTO ${batches} (id, namespace, digest, expected_rows, parent_batch_id, started_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
        params: [batchId, namespace, digest, expectedRows, prior?.batchId ?? null, now()]
      });
      return { status: 'upload', batchId };
    },

    async import(batchId: string): Promise<SnapshotImport> {
      return getBatch(batchId);
    },

    async append(batchId: string, offset: number, documents: readonly T['inferIn'][]):
      Promise<{ accepted: number; duplicates: number }> {
      ensureText(batchId, 'batchId');
      const batch = await getBatch(batchId);
      if (!Number.isSafeInteger(offset) || offset < 0 || documents.length < 1 ||
          documents.length > 50 || offset + documents.length > batch.expectedRows) {
        throw new RangeError('Invalid snapshot import offset or chunk size (1..50)');
      }
      const stored = documents.map((input, i) => {
        const result = schema(input);
        if (result instanceof type.errors) throw new Error(`Snapshot validation failed: ${result.summary}`);
        const id = `${batchId}:${offset + i}`;
        return { id, data: serializeDocument({ id, batchId, value: result }) };
      });
      const params = stored.map(v => v.id);
      const read = (): Promise<{ id: string; data: string }[]> => adapter.all({
        sql: `SELECT id, data FROM ${records} WHERE id IN (${params.map(() => '?').join(',')})`,
        params
      });
      const existing = await read();
      const byId = new Map(existing.map(row => [row.id, row.data]));
      for (const row of stored) {
        if (byId.has(row.id) && byId.get(row.id) !== row.data) {
          throw new SnapshotConflictError(`Conflicting retry for ${row.id}`);
        }
      }
      const published = await this.head(batch.namespace);
      if (published?.batchId === batchId || (published?.batchId !== batch.parentBatchId &&
          (published?.batchId ?? null) !== batch.parentBatchId)) {
        if (stored.every(row => byId.get(row.id) === row.data)) return { accepted: 0, duplicates: stored.length };
        throw new SnapshotConflictError(`Batch ${batchId} is no longer writable`);
      }
      const newRows = stored.filter(row => !byId.has(row.id));
      if (newRows.length) {
        await adapter.batch(newRows.map(row => ({
          sql: `INSERT INTO ${records} (id, data)
            SELECT ?, ? WHERE EXISTS (
              SELECT 1 FROM ${batches} WHERE id = ?
            ) AND NOT EXISTS (
              SELECT 1 FROM ${heads} WHERE batch_id = ?
            ) ON CONFLICT(id) DO NOTHING`,
          params: [row.id, row.data, batchId, batchId]
        })));
      }
      const after = new Map((await read()).map(row => [row.id, row.data]));
      if (stored.some(row => after.get(row.id) !== row.data)) {
        throw new SnapshotConflictError(`Concurrent or conflicting upload in batch ${batchId}`);
      }
      return { accepted: newRows.length, duplicates: stored.length - newRows.length };
    },

    async countBatch(batchId: string): Promise<number> {
      const row = await adapter.get<{ total: number }>({
        sql: `SELECT COUNT(*) AS total FROM ${records} WHERE ${batchExpr} = ?`, params: [batchId]
      });
      return row?.total ?? 0;
    },

    /**
     * A single SQLite statement checks both completeness and the expected
     * prior head before publishing. Consumers see either old or new snapshot.
     */
    async publish(batchId: string): Promise<{ status: 'committed'; head: SnapshotHead; previousBatchId: string | null }> {
      const batch = await getBatch(batchId);
      const previous = await this.head(batch.namespace);
      if (previous?.batchId === batchId) return { status: 'committed', head: previous, previousBatchId: batch.parentBatchId };
      const actual = await this.countBatch(batchId);
      if (actual !== batch.expectedRows) throw new IncompleteSnapshotError(actual, batch.expectedRows);
      const timestamp = now();
      const published = await adapter.get<{
        namespace: string; batch_id: string; digest: string;
        checked_at: string; changed_at: string;
      }>({
        sql: `INSERT INTO ${heads} (namespace, batch_id, digest, checked_at, changed_at)
          SELECT b.namespace, b.id, b.digest, ?, ? FROM ${batches} AS b
          WHERE b.id = ? AND (SELECT COUNT(*) FROM ${records}
            WHERE ${batchExpr} = b.id) = b.expected_rows
            AND (SELECT h.batch_id FROM ${heads} AS h WHERE h.namespace = b.namespace) IS b.parent_batch_id
          ON CONFLICT(namespace) DO UPDATE SET
            batch_id = excluded.batch_id, digest = excluded.digest,
            checked_at = excluded.checked_at, changed_at = excluded.changed_at
          WHERE ${heads}.batch_id IS (SELECT b.parent_batch_id FROM ${batches} AS b WHERE b.id = excluded.batch_id)
          RETURNING namespace, batch_id, digest, checked_at, changed_at`,
        params: [timestamp, timestamp, batchId]
      });
      if (!published) throw new SnapshotConflictError(`Stale or incomplete snapshot publish: ${batchId}`);
      return {
        status: 'committed',
        head: {
          namespace: published.namespace, batchId: published.batch_id, digest: published.digest,
          checkedAt: published.checked_at, changedAt: published.changed_at
        },
        previousBatchId: batch.parentBatchId
      };
    },

    async readBatchPage(batchId: string, options: { limit?: number; cursor?: string } = {}):
      Promise<SnapshotPage<Value>> {
      const limit = options.limit ?? 200;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        throw new RangeError('Page limit must be 1..500');
      }
      const rows = await adapter.all<{ id: string; data: string }>({
        sql: `SELECT id, data FROM ${records}
          WHERE ${batchExpr} = ? AND id > ? ORDER BY id LIMIT ?`,
        params: [batchId, options.cursor ?? '', limit + 1]
      });
      const sliced = rows.slice(0, limit);
      return {
        batchId,
        documents: sliced.map(row => decode(row).value),
        nextCursor: rows.length > limit ? sliced[sliced.length - 1].id : null
      };
    },

    async readActivePage(namespace: string, options: { limit?: number; cursor?: string } = {}):
      Promise<SnapshotPage<Value>> {
      const active = await this.head(namespace);
      if (!active) return { batchId: null, documents: [], nextCursor: null };
      return this.readBatchPage(active.batchId, options);
    },

    async prune(batchId: string): Promise<number> {
      ensureText(batchId, 'batchId');
      // Never touch currently published docs or a namespace's current head.
      const head = await adapter.get<{ namespace: string }>({
        sql: `SELECT namespace FROM ${heads} WHERE batch_id = ?`, params: [batchId]
      });
      if (head) throw new SnapshotConflictError(`Cannot prune active batch ${batchId}`);
      await getBatch(batchId);
      const removed = await adapter.get<{ removed: number }>({
        sql: `SELECT COUNT(*) AS removed FROM ${records} WHERE ${batchExpr} = ?`,
        params: [batchId]
      });
      // Guard deletion in SQL as well, in case the head changed since the read.
      await adapter.run({ sql: `DELETE FROM ${records} WHERE ${batchExpr} = ?
        AND NOT EXISTS (SELECT 1 FROM ${heads} WHERE batch_id = ?)`, params: [batchId, batchId] });
      await adapter.run({ sql: `DELETE FROM ${batches} WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM ${heads} WHERE batch_id = ?)`, params: [batchId, batchId] });
      return removed?.removed ?? 0;
    }
  };
}
