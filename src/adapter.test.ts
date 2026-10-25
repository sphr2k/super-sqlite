import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { type } from 'arktype';
import { arktypeJsonTable } from './factory.js';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';
import { D1Adapter, type D1StatementLike } from './adapters/d1.js';
import type { SQLiteAdapter } from './adapters/types.js';

/** Emulates D1's asynchronous prepared statement/batch contract against native SQLite. */
function mockD1(sqlite: Database.Database) {
  class Prepared implements D1StatementLike {
    constructor(readonly text: string, readonly params: any[] = []) {}
    bind(...params: any[]) { return new Prepared(this.text, params); }
    async run() { return sqlite.prepare(this.text).run(...this.params); }
    async all<T>() { return { results: sqlite.prepare(this.text).all(...this.params) as T[] }; }
    async first<T>() { return (sqlite.prepare(this.text).get(...this.params) ?? null) as T | null; }
  }
  return {
    prepare: (text: string) => new Prepared(text),
    batch: async (queries: D1StatementLike[]) => {
      const statements = queries as Prepared[];
      return sqlite.transaction(() => statements.map(s => sqlite.prepare(s.text).run(...s.params)))();
    }
  };
}

for (const kind of ['better-sqlite3', 'd1-mock'] as const) {
  describe(kind, () => {
    function setup(): { sqlite: Database.Database; adapter: SQLiteAdapter } {
      const sqlite = new Database(':memory:');
      const adapter = kind === 'd1-mock'
        ? new D1Adapter(mockD1(sqlite))
        : new BetterSQLite3Adapter(sqlite);
      return { sqlite, adapter };
    }

    it('validates, applies ArkType morphs and persists the output, not the raw input', async () => {
      const { sqlite, adapter } = setup();
      const schema = type({ age: 'string.numeric.parse', 'id?': 'string' });
      const repo = arktypeJsonTable('Person', schema, 'people', adapter, ['age']);
      await repo.initialize();
      const inserted = await repo.insert({ age: '42' } as any);
      expect(inserted.age).toBe(42);
      const row = await repo.findById(inserted.id);
      expect(row?.age).toBe(42);
      expect(JSON.parse((sqlite.prepare('SELECT data FROM people').get() as { data: string }).data as string).json.age).toBe(42);
      await expect(repo.insert({ age: 'invalid' } as any)).rejects.toThrow(/Validation Error/);
      expect((await repo.getAll())).toHaveLength(1);
      sqlite.close();
    });

    it('executes bound params, joins, left joins, ranges and selective indexes', async () => {
      const { sqlite, adapter } = setup();
      const users = arktypeJsonTable('User', type({ id: 'string', email: 'string', active: 'boolean' }), 'users', adapter, ['email', 'active']);
      const profiles = arktypeJsonTable('Profile', type({ id: 'string', userId: 'string', bio: 'string' }), 'profiles', adapter, ['userId']);
      await users.initialize();
      await profiles.initialize();
      await users.insert([{ id: 'u1', email: 'alice@example.org', active: true }, { id: 'u2', email: 'bob@example.org', active: false }]);
      await profiles.insert({ id: 'p1', userId: 'u1', bio: 'Hello' });
      expect(await users.findByField('active', true)).toHaveLength(1);
      expect(await users.select({ email: true }).where({ active: false }).all()).toEqual([{ id: 'u2', email: 'bob@example.org' }]);
      const joined = await users.leftJoin(profiles, { id: 'userId' }).select().all();
      expect(joined).toHaveLength(2);
      expect(joined[0].profiles).toMatchObject({ bio: 'Hello' });
      expect(joined[1].profiles).toBeNull();
      const filtered = await users.join(profiles, { id: 'userId' }).where({ profiles: { bio: 'Hello' } }).all();
      expect(filtered).toHaveLength(1);
      const plan = sqlite.prepare("EXPLAIN QUERY PLAN SELECT * FROM users WHERE json_extract(data, '$.json.email') = ?").get('alice@example.org') as { detail: string };
      expect(plan.detail).toContain('idx_users_email');
      sqlite.close();
    });

    it('rolls back a conflicting batch without partial writes', async () => {
      const { sqlite, adapter } = setup();
      const repo = arktypeJsonTable('Record', type({ id: 'string', name: 'string' }), 'records', adapter);
      await repo.initialize();
      await expect(repo.insert([{ id: 'a', name: 'A' }, { id: 'a', name: 'Duplicate' }])).rejects.toThrow();
      expect(await repo.getAll()).toHaveLength(0);
      sqlite.close();
    });
  });
}
