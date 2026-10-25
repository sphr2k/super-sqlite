import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { type } from 'arktype';
import superjson from 'superjson';
import { arktypeJsonTable, RevisionConflictError, DocumentNotFoundError } from './factory.js';
import { DocumentVersionError, serializeDocument } from './document.js';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';
import { D1Adapter, type D1StatementLike } from './adapters/d1.js';
import type { SQLiteAdapter } from './adapters/types.js';

function mockD1(sqlite: Database.Database) {
  class Prepared implements D1StatementLike {
    constructor(readonly text: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Prepared(this.text, params); }
    async run() { return sqlite.prepare(this.text).run(...this.params); }
    async all<T>() { return { results: sqlite.prepare(this.text).all(...this.params) as T[] }; }
    async first<T>() { return (sqlite.prepare(this.text).get(...this.params) ?? null) as T | null; }
  }
  return {
    prepare: (text: string) => new Prepared(text),
    batch: async (queries: D1StatementLike[]) => sqlite.transaction(
      () => queries.map(query => {
        const p = query as Prepared;
        return sqlite.prepare(p.text).run(...p.params);
      })
    )()
  };
}

for (const kind of ['better-sqlite3', 'd1-mock'] as const) {
  describe(`document enhancements (${kind})`, () => {
    function setup() {
      const sqlite = new Database(':memory:');
      const adapter: SQLiteAdapter = kind === 'better-sqlite3'
        ? new BetterSQLite3Adapter(sqlite)
        : new D1Adapter(mockD1(sqlite));
      return { sqlite, adapter };
    }

    it('supports typed rich projections without JSON1 boolean/rich-type loss', async () => {
      const { sqlite, adapter } = setup();
      try {
        const schema = type({
          id: 'string', enabled: 'boolean',
          createdAt: type.instanceOf(Date), tags: type.instanceOf(Set),
          region: 'string'
        });
        const repo = arktypeJsonTable('Entry', schema, 'entries', adapter, ['enabled', 'region']);
        await repo.initialize();
        const now = new Date('2026-01-01T00:00:00.000Z');
        await repo.insert({ id: 'one', enabled: true, createdAt: now, tags: new Set(['x']), region: 'EU' });
        const row = await repo.select({ enabled: true, createdAt: true, tags: true })
          .where({ enabled: true }).get();
        expect(row).toEqual({ id: 'one', enabled: true, createdAt: now, tags: new Set(['x']) });
        expect(await repo.findByField('enabled', true)).toHaveLength(1);
        expect(await repo.findDateRange('createdAt', { start: new Date('2025-12-31') })).toHaveLength(1);
      } finally { sqlite.close(); }
    });

    it('upcasts legacy SuperJSON lazily, rejects incompatible versions, and persists the new version on update', async () => {
      const { sqlite, adapter } = setup();
      try {
        const v3 = type({
          id: 'string', display: 'string', active: 'boolean',
          createdAt: type.instanceOf(Date), tags: type.instanceOf(Set)
        });
        const repo = arktypeJsonTable('Entry', v3, 'documents', adapter, [], {
          evolution: {
            version: 3,
            upcasters: {
              1: value => {
                const doc = value as Record<string, unknown>;
                return { ...doc, display: doc.name };
              },
              2: value => ({ ...(value as object), active: true })
            }
          }
        });
        await repo.initialize();
        const now = new Date('2026-01-01');
        const legacy = { id: 'legacy', name: 'Old', createdAt: now, tags: new Set(['old']) };
        await adapter.run({
          sql: 'INSERT INTO documents (id, data) VALUES (?, ?)',
          params: ['legacy', superjson.stringify(legacy)]
        });
        const fetched = await repo.findByIdWithRevision('legacy');
        expect(fetched).toMatchObject({
          revision: 1, version: 1,
          value: { display: 'Old', active: true, createdAt: now, tags: new Set(['old']) }
        });
        const updated = await repo.update('legacy', { display: 'New' }, { expectedRevision: 1 });
        expect(updated.value).toMatchObject({ display: 'New', active: true, createdAt: now });
        expect(await repo.findByIdWithRevision('legacy')).toMatchObject({ revision: 2, version: 3 });
        const raw = sqlite.prepare('SELECT data FROM documents WHERE id = ?').get('legacy') as { data: string };
        expect(JSON.parse(raw.data)._supersqlite).toEqual({ revision: 2, version: 3 });
        expect(superjson.parse(raw.data)).toHaveProperty('createdAt', now);
        await adapter.run({
          sql: 'INSERT INTO documents (id, data) VALUES (?, ?)',
          params: ['future', serializeDocument(legacy, 1, 4)]
        });
        await expect(repo.findById('future')).rejects.toThrow(DocumentVersionError);
        const bad = arktypeJsonTable('Bad', v3, 'documents', adapter, [], { evolution: { version: 3 } });
        await expect(bad.findById('future')).rejects.toThrow(DocumentVersionError);
        await expect(bad.findById('legacy')).resolves.toBeDefined();
      } finally { sqlite.close(); }
    });

    it('materializes upcasts in bounded batches for indexed JSON1 queries', async () => {
      const { sqlite, adapter } = setup();
      try {
        const schema = type({ id: 'string', region: 'string', active: 'boolean' });
        const repo = arktypeJsonTable('Item', schema, 'items', adapter, ['region'], {
          evolution: { version: 2, upcasters: {
            1: value => {
              const old = value as { id: string; location: string };
              return { id: old.id, region: old.location, active: true };
            }
          } }
        });
        await repo.initialize();
        for (const id of ['a', 'b']) {
          await adapter.run({ sql: 'INSERT INTO items (id, data) VALUES (?, ?)',
            params: [id, superjson.stringify({ id, location: 'EU' })] });
        }
        await repo.insert({ id: 'c', region: 'US', active: false });
        expect(await repo.findByField('region', 'EU')).toHaveLength(0);
        expect(await repo.findById('a')).toMatchObject({ region: 'EU' });
        expect(await repo.upgradeDocuments({ dryRun: true, batchSize: 1 }))
          .toEqual({ scanned: 3, upgraded: 2 });
        expect(await repo.findByField('region', 'EU')).toHaveLength(0);
        expect(await repo.upgradeDocuments({ batchSize: 1 }))
          .toEqual({ scanned: 3, upgraded: 2 });
        expect(await repo.findByField('region', 'EU')).toHaveLength(2);
        expect(await repo.findByIdWithRevision('a')).toMatchObject({ version: 2, revision: 2 });
        expect(await repo.upgradeDocuments()).toEqual({ scanned: 3, upgraded: 0 });
        await expect(repo.upgradeDocuments({ batchSize: 0 })).rejects.toThrow(RangeError);
      } finally { sqlite.close(); }
    });

    it('performs atomic optimistic writes, patch morphs and optional-field removal', async () => {
      const { sqlite, adapter } = setup();
      try {
        const schema = type({
          id: 'string', age: 'string.numeric.parse',
          title: 'string', 'note?': 'string', tags: type.instanceOf(Set)
        });
        const repo = arktypeJsonTable('Record', schema, 'records', adapter);
        await repo.initialize();
        await repo.insert({ id: 'one', age: '42', title: 'Initial', note: 'yes', tags: new Set(['ok']) });
        expect(await repo.findByIdWithRevision('one')).toMatchObject({ revision: 1, version: 1 });
        const next = await repo.update('one', { title: 'Changed', age: '43', note: undefined }, { expectedRevision: 1 });
        expect(next.revision).toBe(2);
        expect(next.value).toMatchObject({ age: 43, title: 'Changed', tags: new Set(['ok']) });
        expect(next.value).not.toHaveProperty('note');
        await expect(repo.update('one', { title: 'Stale' }, { expectedRevision: 1 }))
          .rejects.toBeInstanceOf(RevisionConflictError);
        await expect(repo.update('missing', { title: 'No' }))
          .rejects.toBeInstanceOf(DocumentNotFoundError);
        await expect(repo.update('one', { age: 'wrong' }))
          .rejects.toThrow(/Validation Error/);
        await expect(repo.update('one', { id: 'illegal' } as any))
          .rejects.toThrow(/id cannot be modified/);
        const outcomes = await Promise.allSettled([
          repo.update('one', { title: 'Writer A' }),
          repo.update('one', { title: 'Writer B' })
        ]);
        expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(x => x.status === 'rejected')).toHaveLength(1);
        expect(await repo.findByIdWithRevision('one')).toMatchObject({ revision: 3 });
      } finally { sqlite.close(); }
    });

    it('handles generated ids and typed joins with lazy upcasted joined documents', async () => {
      const { sqlite, adapter } = setup();
      try {
        const users = arktypeJsonTable('User', type({ name: 'string' }), 'users', adapter);
        const profiles = arktypeJsonTable('Profile', type({ userId: 'string', bio: 'string' }), 'profiles', adapter, [], {
          evolution: { version: 2, upcasters: { 1: value => {
            const old = value as { userId: string; text: string };
            return { userId: old.userId, bio: old.text };
          } } }
        });
        await users.initialize();
        await profiles.initialize();
        const inserted = await users.insert({ name: 'Alice' });
        expect(inserted.id).toBeTruthy();
        expect((await users.update(inserted.id, { name: 'Bob' })).value)
          .toEqual({ id: inserted.id, name: 'Bob' });
        await adapter.run({ sql: 'INSERT INTO profiles (id, data) VALUES (?, ?)',
          params: ['p', superjson.stringify({ userId: inserted.id, text: 'Old bio' })] });
        const result = await users.leftJoin(profiles, { id: 'userId' }).select().all();
        expect(result).toHaveLength(1);
        expect(result[0].users).toEqual({ id: inserted.id, name: 'Bob' });
        expect(result[0].profiles).toEqual({ id: 'p', userId: inserted.id, bio: 'Old bio' });
      } finally { sqlite.close(); }
    });

    it('plans changes safely without dropping unrelated or legacy indexes', async () => {
      const { sqlite, adapter } = setup();
      try {
        const schema = type({ id: 'string', region: 'string', active: 'boolean', zone: 'string' });
        const old = arktypeJsonTable('Item', schema, 'items', adapter, ['region']);
        await adapter.run({ sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, data TEXT NOT NULL)' });
        await adapter.run({ sql: 'CREATE INDEX IF NOT EXISTS "idx_items_region" ON "items" (json_extract(data, \'$.json.region\'))' });
        await adapter.run({ sql: 'CREATE INDEX idx_items_custom ON "items" (length(id))' });
        expect(await old.planIndexes()).toEqual([]);
        const revised = arktypeJsonTable('Item', schema, 'items', adapter, ['active']);
        const plan = await revised.planIndexes();
        expect(plan.map(op => [op.action, op.name])).toEqual([
          ['create', 'idx_items_active'],
          ['drop', 'idx_items_region']
        ]);
        expect(await revised.planIndexes()).toEqual(plan); // planning is pure
        expect((await revised.applyIndexes()).map(op => op.action)).toEqual(['create']);
        expect((await revised.planIndexes()).map(op => op.action)).toEqual(['drop']);
        expect((await revised.applyIndexes({ dropObsolete: true })).map(op => op.action)).toEqual(['drop']);
        expect(await revised.planIndexes()).toEqual([]);
        const indexes = sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND tbl_name = ?')
          .all('index', 'items') as { name: string }[];
        expect(indexes.map(x => x.name)).toContain('idx_items_custom');
        expect(indexes.map(x => x.name)).not.toContain('idx_items_region');
        await adapter.run({ sql: 'DROP INDEX "idx_items_active"' });
        await adapter.run({ sql: 'CREATE INDEX "idx_items_active" ON "items" (length(data))' });
        await expect(revised.planIndexes()).rejects.toThrow(/Conflicting unmanaged index/);
      } finally { sqlite.close(); }
    });
  });
}
