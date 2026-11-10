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
const rich = arktypeJsonTable('Rich', type({id:'string', tags:type.instanceOf(Set)}), 'rich',
  new BetterSQLite3Adapter(new Database(':memory:')));
// @ts-expect-error Set is not comparable with SQL equality
rich.findByField('tags', new Set(['a']));
const richSchema = type({id:'string', tags:type.instanceOf(Set)});
// @ts-expect-error Set fields cannot be indexed
arktypeJsonTable('Rich', richSchema, 'rich', new BetterSQLite3Adapter(new Database(':memory:')), ['tags']);

// @ts-expect-error Rich document values are never valid for selectScalar
rich.selectScalar({ tags: true });
const scalarProjection: Promise<Array<{ id: string; active: boolean }>> = repo.selectScalar({ active: true }).all();
void scalarProjection;

// Portable validator/provider type inference
import * as z from "zod";
import { zodSchema } from "./schema-zod.js";
import { standardSchema } from "./schema-standard.js";
import { documentTable } from "./factory-core.js";
const inputWithMorph = z.strictObject({
  id: z.string(),
  age: z.string().regex(/^\d+$/).transform(Number),
  tags: z.array(z.string()),
});
const outputFromMorph = z.strictObject({
  id: z.string(),
  age: z.number(),
  tags: z.array(z.string()),
});
const genericDoc = zodSchema(inputWithMorph, {
  outputSchema: outputFromMorph,
  fields: { id: { kind: "string" }, age: { kind: "number" }, tags: { kind: "string-array" } },
});
const genericRepo = documentTable(
  "Person",
  genericDoc,
  "person",
  new BetterSQLite3Adapter(new Database(":memory:")),
  ["age"],
  { indexes: { arrays: ["tags"] } },
);
const typedInserted: Promise<{ id: string; age: number; tags: string[] }> = genericRepo.insert({
  id: "a",
  age: "23",
  tags: ["k8s"],
});
void typedInserted;
// @ts-expect-error transformed output cannot be inserted instead of string input
genericRepo.insert({ id: "b", age: 24, tags: [] });
// @ts-expect-error unknown field cannot be indexed
documentTable("Person", genericDoc, "person", new BetterSQLite3Adapter(new Database(":memory:")), ["unknown"]);
// @ts-expect-error arrays must be string-array output fields
documentTable("Person", genericDoc, "person", new BetterSQLite3Adapter(new Database(":memory:")), [], {indexes:{arrays:["age"]}});
const rawStandard = standardSchema(inputWithMorph, {
  outputSchema: outputFromMorph,
  fields: { id: { kind: "string" }, age: { kind: "number" }, tags: { kind: "string-array" } },
});
const standardRepo = documentTable(
  "Standard",
  rawStandard,
  "standard",
  new BetterSQLite3Adapter(new Database(":memory:")),
);
const typedStandardInserted: Promise<{ id: string; age: number; tags: string[] }> =
  standardRepo.insert({ id: "s", age: "3", tags: [] });
void typedStandardInserted;
