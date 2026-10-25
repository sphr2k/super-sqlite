import { type } from 'arktype';
import Database from 'better-sqlite3';
import { arktypeJsonTable } from './factory.js';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';

// Compile-time checks only: this file is included in 'tsc --noEmit', not Vitest.
const schema = type({
  id: 'string', name: 'string', active: 'boolean',
  createdAt: type.instanceOf(Date), 'region?': 'string',
  age: 'string.numeric.parse'
});
const repo = arktypeJsonTable('Entity', schema, 'entities', new BetterSQLite3Adapter(new Database(':memory:')), ['name', 'active']);
const insertion: Promise<{ id: string; age: number }> = repo.insert({
  id: 'a', name: 'Alice', active: true, createdAt: new Date(), age: '42'
});
const filtered: Promise<Array<{ id: string; name: string }>> = repo.select({ name: true }).where({ active: true }).all();
const projected: Promise<Array<{ id: string; active: boolean; createdAt: Date }>> =
  repo.select({ active: true, createdAt: true }).all();
const maybe = repo.select({ name: true }).get();
void insertion;
void filtered;
void projected;
void maybe;

// @ts-expect-error unknown index field
arktypeJsonTable('Entity', schema, 'entities', new BetterSQLite3Adapter(new Database(':memory:')), ['regoin']);
// @ts-expect-error unknown selected property
repo.select({ regoin: true });
// @ts-expect-error unknown filter property
repo.select().where({ regoin: 'EU' });
// @ts-expect-error boolean query value must be boolean
repo.select().where({ active: 'yes' });
// @ts-expect-error only selected fields are available in the projection result
repo.select({ name: true }).get().then(v => v?.active);
// @ts-expect-error findByField restricts field name
repo.findByField('regoin', 'EU');
// @ts-expect-error findByField restricts value to field type
repo.findByField('active', 'true');
// @ts-expect-error Date range fields must have Date output type
repo.findDateRange('active', { start: new Date() });
// @ts-expect-error update rejects id mutation in the TS API
repo.update('a', { id: 'b' });
// @ts-expect-error update input type must match ArkType morph input
repo.update('a', { age: 43 });
// @ts-expect-error findByField uses post-morph output type
repo.findByField('age', '42');
const profiles = arktypeJsonTable('Profile', type({ id: 'string', userId: 'string', bio: 'string' }),
  'profiles', new BetterSQLite3Adapter(new Database(':memory:')));
const joinedResult: Promise<Array<{
  entities: { id: string; name: string; active: boolean };
  profiles: { id: string; userId: string; bio: string } | null;
}>> = repo.leftJoin(profiles, { id: 'userId' })
  .select().where({ profiles: { bio: 'hello' }, entities: { active: true } }).all();
void joinedResult;
// @ts-expect-error invalid joined property
repo.leftJoin(profiles, { id: 'userId' }).where({ profiles: { bibio: 'wrong' } });
// @ts-expect-error join field must exist in the source repository
repo.leftJoin(profiles, { nonExisting: 'userId' });
// @ts-expect-error join target field must exist in the target repository
repo.leftJoin(profiles, { id: 'userIDD' });
