import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { type } from 'arktype';
import { Miniflare } from 'miniflare';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';
import { D1Adapter } from './adapters/d1.js';
import {
  createSnapshotStore, SnapshotConflictError, SnapshotNotFoundError,
  IncompleteSnapshotError
} from './snapshots.js';

const schema = type({
  country: 'string',
  raw: 'unknown',
  'single?': 'number | null'
});
const docs = [
  { country: 'DE', raw: { vendor_id: 'aws', server_id: 'a', min_price_spot: 0.2, extra: { hello: ['world'] } }, single: 111 },
  { country: 'FR', raw: { vendor_id: 'aws', server_id: 'b', min_price_spot: 0.1 } },
  { country: 'US', raw: { vendor_id: 'aws', server_id: 'c', min_price_ondemand: 0.3 } }
];

async function exercise(adapter: BetterSQLite3Adapter | D1Adapter) {
  const store = createSnapshotStore('keeper', schema, adapter);
  await store.initialize();
  const first = await store.begin('AWS', 'digest1', 3);
  expect(first.status).toBe('upload');
  const batchId = first.batchId;
  expect((await store.readActivePage('AWS')).documents).toEqual([]);
  await expect(store.publish(batchId)).rejects.toBeInstanceOf(IncompleteSnapshotError);
  expect(await store.append(batchId, 0, docs.slice(0, 2))).toEqual({ accepted: 2, duplicates: 0 });
  expect(await store.append(batchId, 0, docs.slice(0, 2))).toEqual({ accepted: 0, duplicates: 2 });
  await expect(store.append(batchId, 0, [{ ...docs[0], raw: { changed: true } }]))
    .rejects.toBeInstanceOf(SnapshotConflictError);
  await expect(store.append(batchId, 3, docs)).rejects.toThrow(RangeError);
  expect(await store.countBatch(batchId)).toBe(2);
  await store.append(batchId, 2, docs.slice(2));
  const firstPublish = await store.publish(batchId);
  expect(firstPublish.previousBatchId).toBeNull();
  expect(await store.publish(batchId)).toMatchObject({ status: 'committed', head: { batchId } });
  expect(await store.begin('AWS', 'digest1', 3)).toEqual({ status: 'unchanged', batchId });
  await expect(store.prune(batchId)).rejects.toBeInstanceOf(SnapshotConflictError);
  expect(await store.readActivePage('AWS', {limit: 2})).toMatchObject({
    batchId, documents: expect.arrayContaining([docs[0], docs[1]])
  });
  const firstPage = await store.readActivePage('AWS', { limit: 2 });
  const secondPage = await store.readActivePage('AWS', { limit: 2, cursor: firstPage.nextCursor! });
  expect([...firstPage.documents, ...secondPage.documents]).toHaveLength(3);
  expect(secondPage.nextCursor).toBeNull();
  expect(await store.listHeads()).toMatchObject([{ namespace: 'AWS', digest: 'digest1' }]);
  // Uploading a different provider must not affect the first provider.
  const other = await store.begin('GCP', 'gd1', 1);
  await store.append(other.batchId, 0, [docs[1]]);
  await store.publish(other.batchId);
  expect((await store.readActivePage('AWS')).documents).toHaveLength(3);
  expect((await store.readActivePage('GCP')).documents).toEqual([docs[1]]);

  const second = await store.begin('AWS', 'digest2', 1);
  const stale = await store.begin('AWS', 'stale', 1);
  await store.append(second.batchId, 0, [docs[2]]);
  await store.append(stale.batchId, 0, [docs[1]]);
  // Old snapshot remains visible until the atomic head switch.
  expect((await store.readActivePage('AWS')).documents).toHaveLength(3);
  const promoted = await store.publish(second.batchId);
  expect(promoted.previousBatchId).toBe(batchId);
  await expect(store.publish(stale.batchId)).rejects.toBeInstanceOf(SnapshotConflictError);
  expect((await store.readActivePage('AWS')).documents).toEqual([docs[2]]);
  await expect(store.append(second.batchId, 0, [{ ...docs[2], country: 'FI' }]))
    .rejects.toBeInstanceOf(SnapshotConflictError);
  expect(await store.prune(batchId)).toBe(3);
  expect(await store.countBatch(batchId)).toBe(0);
  await expect(store.import(batchId)).rejects.toBeInstanceOf(SnapshotNotFoundError);
  expect((await store.readActivePage('AWS')).documents).toEqual([docs[2]]);
  await store.prune(stale.batchId);
  await expect(store.readActivePage('AWS', {limit: 10000})).rejects.toThrow(RangeError);
}

describe('snapshot import lifecycle', () => {
  it('supports exact retry, atomic publication, stale-head protection and pruning on native SQLite', async () => {
    const db = new Database(':memory:');
    try { await exercise(new BetterSQLite3Adapter(db)); } finally { db.close(); }
  });

  it('works against actual workerd D1 under Miniflare', async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch() {return new Response("ok")}}',
      d1Databases: { DB: 'supersqlite-snapshot-test' }
    });
    try { await exercise(new D1Adapter(await mf.getD1Database('DB'))); }
    finally { await mf.dispose(); }
  }, 25000);
});
