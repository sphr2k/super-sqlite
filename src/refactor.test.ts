import { describe, expect, it } from 'vitest';
import { type } from 'arktype';
import Database from 'better-sqlite3';
import superjson from 'superjson';
import { sql } from 'drizzle-orm';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';
import { arktypeJsonTable } from './factory.js';
import { DocumentVersionError } from './document.js';

function setup() {
  const sqlite = new Database(':memory:');
  const adapter = new BetterSQLite3Adapter(sqlite);
  return { sqlite, adapter };
}

describe('refactor: validation, field metadata and index safety', () => {
  it('rejects invalid stored values without configured schema evolution', async () => {
    const { sqlite, adapter } = setup();
    try {
      const repo = arktypeJsonTable('User', type({ id: 'string', age: 'number' }), 'users', adapter);
      await repo.initialize();
      sqlite.prepare('INSERT INTO users (id, data) VALUES (?, ?)')
        .run('a', superjson.stringify({ id: 'a', age: 'not-number' }));
      await expect(repo.findById('a')).rejects.toThrow(DocumentVersionError);
      await expect(repo.select({ age: true }).all()).rejects.toThrow(DocumentVersionError);
      sqlite.prepare('UPDATE users SET data = ? WHERE id = ?')
        .run(superjson.stringify({ id: 'a', age: 33 }), 'a');
      expect(await repo.findById('a')).toEqual({ id: 'a', age: 33 });
    } finally { sqlite.close(); }
  });

  it('rejects mismatched ids and corrupt or malformed envelopes', async () => {
    const { sqlite, adapter } = setup();
    try {
      const repo = arktypeJsonTable('User', type({ id: 'string', age: 'number' }), 'users', adapter);
      await repo.initialize();
      const insert = sqlite.prepare('INSERT OR REPLACE INTO users (id, data) VALUES (?, ?)');
      insert.run('a', superjson.stringify({ id: 'other', age: 2 }));
      await expect(repo.findById('a')).rejects.toThrow(/id mismatch/);
      insert.run('a', '{not json');
      await expect(repo.findById('a')).rejects.toThrow(DocumentVersionError);
      insert.run('a', JSON.stringify({ json: { id: 'a', age: 2 }, _supersqlite: { revision: -1, version: 1 } }));
      await expect(repo.findById('a')).rejects.toThrow(DocumentVersionError);
    } finally { sqlite.close(); }
  });

  it('rejects nonqueryable rich fields and unknown fields, leaving explicit SQL available', async () => {
    const { sqlite, adapter } = setup();
    try {
      const schema = type({ id: 'string', active: 'boolean', age: 'number', tags: type.instanceOf(Set), name: "'admin' | 'user'" });
      const repo = arktypeJsonTable('Item', schema, 'items', adapter, ['active', 'name']);
      await repo.initialize();
      await repo.insert({ id: 'a', active: true, age: 42, tags: new Set(['a']), name: 'admin' });
      expect(await repo.findByField('name', 'admin')).toHaveLength(1);
      expect(await repo.findByField('active', true)).toHaveLength(1);
      expect(() => repo.proxy.typo).toThrow(/Unknown ArkType field/);
      expect(() => repo.proxy.tags).toThrow(/not queryable/);
      expect(() => repo.select().where({ tags: new Set(['a']) } as any)).toThrow(/not queryable/);
      const viaSql = await repo.select().where(sql`${repo.proxy.age} = ${42}`).get();
      expect(viaSql?.id).toBe('a');
      expect(() => arktypeJsonTable('Bad', schema, 'bad', adapter, ['tags'] as any)).toThrow(/not queryable/);
    } finally { sqlite.close(); }
  });

  it('provides explicit scalar-only projections while preserving strict default validation', async () => {
    const { sqlite, adapter } = setup();
    try {
      const schema = type({ id: 'string', enabled: 'boolean', updated: type.instanceOf(Date), tag: 'string', 'optional?': 'string' });
      const repo = arktypeJsonTable('Item', schema, 'items', adapter, ['enabled']);
      await repo.initialize();
      await repo.insert({ id: 'x', enabled: true, updated: new Date('2026-10-25T00:00:00Z'), tag: 'foo' });
      expect(await repo.selectScalar({ enabled: true, updated: true }).where({ enabled: true }).get())
        .toEqual({ id: 'x', enabled: true, updated: new Date('2026-10-25T00:00:00Z') });
      expect(() => repo.selectScalar({ optional: true } as any)).toThrow(/non-optional/);
      expect(() => repo.selectScalar({ missing: true } as any)).toThrow(/Unknown ArkType field/);
      sqlite.prepare('UPDATE items SET data = ? WHERE id = ?')
        .run(JSON.stringify({ json: { id: 'x', enabled: true, updated: '2026-10-25T00:00:00Z', tag: 42 } }), 'x');
      await expect(repo.select({ enabled: true }).all()).rejects.toThrow(DocumentVersionError);
      // Explicit opt-in validates selected columns only, not the full stored record.
      expect(await repo.selectScalar({ enabled: true }).get()).toEqual({ id: 'x', enabled: true });
      sqlite.prepare('UPDATE items SET data = ? WHERE id = ?').run(
        JSON.stringify({json: {id: 'x', enabled: 99, updated: '2026-10-25T00:00:00Z', tag: 'valid'}}), 'x'
      );
      await expect(repo.selectScalar({ enabled: true }).all()).rejects.toThrow(/Invalid boolean scalar/);
    } finally { sqlite.close(); }
  });

  it('matches equivalent managed DDL with metadata, but never substitutes another expression', async () => {
    const { sqlite, adapter } = setup();
    try {
      const schema = type({ id: 'string', region: 'string' });
      await adapter.run({ sql: 'CREATE TABLE items (id TEXT PRIMARY KEY, data TEXT NOT NULL)' });
      await adapter.run({ sql: `CREATE   INDEX   "idx_items_region" ON "items" ( JSON_EXTRACT( "data" , '$.json.region' ) )` });
      const desired = arktypeJsonTable('Item', schema, 'items', adapter, ['region']);
      expect(await desired.planIndexes()).toEqual([]);
      await adapter.run({ sql: 'DROP INDEX idx_items_region' });
      await adapter.run({ sql: `CREATE INDEX idx_items_region ON items (json_extract(data, '$.json.REGION'))` });
      await expect(desired.planIndexes()).rejects.toThrow(/Conflicting unmanaged index/);
    } finally { sqlite.close(); }
  });
});
