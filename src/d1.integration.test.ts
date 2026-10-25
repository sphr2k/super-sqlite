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
  it('updates documents with D1-native CAS, applies index plans and upcasts legacy JSON', async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'supersqlite-enhancements' }
    });
    try {
      const d1 = await mf.getD1Database('DB');
      const adapter = new D1Adapter(d1);
      const schema = type({ id: 'string', name: 'string', active: 'boolean' });
      const repo = arktypeJsonTable('Entry', schema, 'entries', adapter, ['name'], {
        evolution: { version: 2, upcasters: { 1: val => {
          const old = val as { id: string; label: string };
          return { id: old.id, name: old.label, active: true };
        } } }
      });
      await repo.initialize();
      await d1.prepare('INSERT INTO entries (id, data) VALUES (?, ?)')
        .bind('legacy', JSON.stringify({ json: { id: 'legacy', label: 'Before' } })).run();
      expect(await repo.findByIdWithRevision('legacy')).toMatchObject({
        revision: 1, version: 1, value: { name: 'Before', active: true }
      });
      const next = await repo.update('legacy', { name: 'After' }, { expectedRevision: 1 });
      expect(next).toMatchObject({ revision: 2, value: { name: 'After' } });
      await expect(repo.update('legacy', { name: 'Stale' }, { expectedRevision: 1 })).rejects.toThrow(/conflict/);
      const revised = arktypeJsonTable('Entry', schema, 'entries', adapter, ['active']);
      expect((await revised.planIndexes()).map(op => op.action)).toEqual(['create', 'drop']);
      await revised.applyIndexes({ dropObsolete: true });
      expect(await revised.planIndexes()).toEqual([]);
      expect(await repo.findByIdWithRevision('legacy')).toMatchObject({ revision: 2, version: 2 });
    } finally { await mf.dispose(); }
  }, 20_000);

});
