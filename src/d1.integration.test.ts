/// <reference types="@cloudflare/workers-types" />
import { describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { type } from 'arktype';
import { arktypeJsonTable } from './factory.js';
import { D1Adapter } from './adapters/d1.js';

describe('Cloudflare D1 integration (Miniflare/workerd)', () => {
  it('persists morphs, queries expression indexes, and rolls back failed batches', async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'supersqlite-test' }
    });

    try {
      const d1 = await mf.getD1Database('DB');
      // Compile-time compatibility with Cloudflare's official D1 binding type.
      const binding: D1Database = d1;
      const adapter = new D1Adapter(binding);
      const repo = arktypeJsonTable(
        'Person',
        type({ id: 'string', age: 'string.numeric.parse', region: 'string' }),
        'people',
        adapter,
        ['region', 'age']
      );
      await repo.initialize();

      await repo.insert([
        { id: 'a', age: '42', region: 'EU' },
        { id: 'b', age: '41', region: 'US' }
      ]);

      expect(await repo.findById('a')).toEqual({ id: 'a', age: 42, region: 'EU' });
      expect(await repo.select({ age: true, region: true })
        .where({ region: 'EU' }).where({ age: 42 }).all())
        .toEqual([{ id: 'a', age: 42, region: 'EU' }]);

      const index = await d1.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_people_age'"
      ).first<{ name: string }>();
      expect(index?.name).toBe('idx_people_age');

      await expect(repo.insert([
        { id: 'c', age: '23', region: 'US' },
        { id: 'c', age: '24', region: 'US' }
      ])).rejects.toThrow(/UNIQUE constraint failed/);
      expect(await repo.findById('c')).toBeUndefined();
      expect(await repo.getAll()).toHaveLength(2);
    } finally {
      await mf.dispose();
    }
  }, 20_000);
});
