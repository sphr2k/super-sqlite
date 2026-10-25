# SuperSQLite

Typed JSON documents on SQLite, backed by **ArkType**, **SuperJSON** and
**Drizzle SQL expressions**. A single ArkType schema provides runtime
validation and TypeScript types; the database has only an `id` and a
`data` column. Queryable document fields use selective SQLite expression
indexes. No schema migrations are required for new document properties.

**Adapters:** local `better-sqlite3` and Cloudflare D1. All repository
methods return Promises. Note that `better-sqlite3` itself executes
synchronously; its adapter provides API compatibility, not non-blocking I/O.

## Get started

Requires Node.js 22.13+ (or 20.19+).

```bash
npm ci
npm run typecheck
npm test
npm start
```

```ts
import Database from 'better-sqlite3';
import { type } from 'arktype';
import { arktypeJsonTable } from 'supersqlite';
import { BetterSQLite3Adapter } from 'supersqlite/node';

const sqlite = new Database(':memory:');
const db = new BetterSQLite3Adapter(sqlite);

const Instance = type({
  id: 'string',
  provider: 'string',
  vcpu: 'number',
  'price?': 'number'
});

const instances = arktypeJsonTable('Instance', Instance, 'instances', db, [
  'provider', 'vcpu'
]);
await instances.initialize();
await instances.insert([
  { id: 'a', provider: 'oci', vcpu: 2, price: 1.5 },
  { id: 'b', provider: 'aws', vcpu: 4 }
]);
const oci = await instances.findByField('provider', 'oci');
const filtered = await instances.select({ provider: true, vcpu: true })
  .where({ vcpu: 2 }).all();
```

### Cloudflare D1

Bind a D1 database in your Worker as `DB`, then:

```ts
import { D1Adapter } from 'supersqlite/d1';
import { arktypeJsonTable } from 'supersqlite';
import { Instance } from './generated/instance.js';

const db = new D1Adapter(env.DB);
const instances = arktypeJsonTable('Instance', Instance, 'instances', db, ['provider']);
await instances.initialize();
await instances.insert({ id: 'a', provider: 'oci', vcpu: 2 });
const rows = await instances.getAll();
```

The adapters implement `run`, `all`, `get`, and atomic `batch`.
D1 uses bound parameters and `D1Database.batch()`, while better-sqlite3
uses native transactions. Array inserts are chunked into groups of 100
statements so D1 never receives a single oversized `INSERT`.

**Important:** `initialize()` creates tables and indexes; for production D1
deployments, run this from a provisioning/migration step rather than every
request. Batches are atomic *per group*, not across an arbitrarily large input.

### JSON → ArkType model CLI

Infer a model at **build time** from JSON samples. Generated TypeScript is
checked in and reviewed like any other schema; it isn't regenerated on every
Worker request.

```bash
npm run infer -- --input prices.json --out src/generated/instance.ts --name Instance
npm run infer -- --input api.json --path data.instances --out src/generated/instance.ts --name Instance
npm run infer -- --input large.ndjson --out src/generated/instance.ts --sample 2000
```

CLI options: `--input/-i` (JSON file, NDJSON file or `-` for JSON stdin),
`--out/-o`, `--name`, `--path` (dot-separated envelope path for JSON),
`--sample` (default: first 1,000 records; `0` means all records).

- Infers nested objects, arrays, optional fields and primitive unions.
- Empty arrays become `unknown[]`; unions of structurally incompatible
  objects fall back to `unknown`. Verify generated models before use.
- Does **not** guess semantic formats like dates from strings.
- NDJSON is sampled incrementally. Ordinary JSON is fully parsed into memory
  before sampling, so convert very large datasets to NDJSON if needed.
- Input fields are kept in the inferred schema. For a smaller persisted model,
  edit the generated schema and use ArkType's undeclared-key handling explicitly.

### Rich types and queries

`SuperJSON` round-trips `Date`, `Map`, `Set`, `BigInt`, and other supported
types. Scalar fields are queryable with `json_extract` and can be indexed.
For rich types, query only their serialized representation where it makes
sense; for instance, dates compare as ISO timestamps.

```ts
const results = await instances.select().where({ provider: 'oci' }).all();
const record = await instances.findById('a');
const joined = await instances.leftJoin(otherRepo, { id: 'instanceId' }).select().all();
```

Schema validation, including ArkType morphs, occurs before insert; **the
validated/transformed result is persisted**, not the unvalidated input.
The `insert()` API accepts ArkType's **input** type (`inferIn`) and returns
its **output** type (`infer`) with a generated or supplied string `id`.
Multiple `.where()` calls are combined with `AND`.

### Typed queries and projections

Field names, scalar filter values, join keys, and nested joined filters are
checked against ArkType's **output** types. This catches typos such as
`findByField('regoin', 'eu')` at compile time. Projected rows contain only
the requested fields plus `id`; joined rows have typed table-name keys, with
nullable records for left joins. Custom Drizzle SQL expressions remain
available, but their arbitrary projection values are typed as `unknown`.

By default, every read validates the **whole** persisted document using
`schema.out`, even without schema evolution configured. This catches corrupted
records and mismatches between the row ID and the stored JSON ID. Strict
projections hydrate the complete SuperJSON envelope, retaining correct
`Date`, `Set`, `Map`, and boolean values. This deliberately trades additional
DB payload for integrity.

For performance-sensitive **non-nullable scalar** projections, an explicitly
weaker alternative is available:

```ts
const results = await instances.selectScalar({ provider: true, vcpu: true })
  .where({ provider: 'aws' }).all();
```

`selectScalar()` fetches only the selected JSON1 fields, validates **those
fields only**, and converts booleans and dates back to their JS types. It does
**not** validate other fields or run upcasters; it rejects evolution-enabled
repositories, optional projections, and non-queryable complex types. Use
`select()` when full document validation is required.

A reproducible local benchmark is included: `npm run bench:projection`.
On one run using 2,000 documents with 4-KiB string payloads, 1,000 matching
rows and 15 alternating timing rounds, the median was **11.09 ms** for strict
hydration, **1.67 ms** for `selectScalar()` and **0.75 ms** for raw JSON1
projection. This is an in-memory SQLite microbenchmark, not representative of
Cloudflare D1 network behavior.


### Versioned schema evolution

Models may evolve without altering the SQLite document table:

```ts
const OldToNew = type({ id: 'string', region: 'string', enabled: 'boolean' });
const regions = arktypeJsonTable('Region', OldToNew, 'regions', db, ['region'], {
  evolution: {
    version: 2,
    upcasters: {
      1: document => {
        const old = document as { id: string; location: string };
        return { id: old.id, region: old.location, enabled: true };
      }
    }
  }
});

await regions.initialize();
const current = await regions.findById('one'); // legacy v1 documents are upcast in memory
const plan = await regions.upgradeDocuments({ dryRun: true, batchSize: 100 });
const result = await regions.upgradeDocuments({ batchSize: 100 });
```

Version and revision live in the top-level `_supersqlite` metadata of the
SuperJSON envelope, not in the user model or extra SQL columns. Existing
metadata-free documents are treated as version 1, revision 1.

Read-time upcasting is **lazy**: it never writes changes implicitly. Each
upcaster advances one version, and the final document is validated against
`schema.out`. Missing upcasters, invalid documents and future versions fail
explicitly. `upgradeDocuments()` iterates in bounded, keyset-paginated batches
and performs atomic, revision-conditional writes. Dry runs count candidates
without changing storage.

**Important:** JSON1 queries and expression indexes operate on **persisted**
JSON, not on the lazy upcasted view. When a field is renamed, run
`upgradeDocuments()` before querying or indexing the renamed field. Coordinate
logical version changes with application deployments; old readers reject
documents written at a newer version.

### Safe updates and optimistic concurrency

```ts
const snapshot = await regions.findByIdWithRevision('one');
if (snapshot) {
  const { value, revision } = await regions.update('one',
    { enabled: false },
    { expectedRevision: snapshot.revision }
  );
}
```

`update(id, patch, options)` applies ArkType morphs to changed fields, validates
the resulting **entire** document with `schema.out`, and performs one SQL
`UPDATE ... WHERE revision = ? RETURNING` for atomic compare-and-swap on both
backends. The revision increments on each successful write, and any updated
legacy document is persisted at the current logical schema version. Passing
`undefined` removes optional fields; required-field removal fails validation.
Invalid patches, missing IDs, and lost races raise distinct errors
(`DocumentNotFoundError`, `RevisionConflictError`). Callers can catch a
conflict, reload, and decide whether to retry; updates do **not** silently
overwrite another writer.

### Declarative indexes

```ts
const planned = await regions.planIndexes();  // read-only CREATE/DROP plan
await regions.applyIndexes();                // add missing managed indexes
await regions.applyIndexes({ dropObsolete: true }); // explicitly remove obsolete ones
```

`initialize()` only creates missing managed indexes, never drops indexes.
Index declarations are checked against ArkType fields at compile time. The
planner recognizes generated indexes from older SuperSQLite versions and
refuses to replace same-name indexes with unknown definitions. Manual indexes
are untouched. Treat destructive plans as provisioning operations and review
them before applying to production D1.

**Caveat:** Schema-less documents don't give you native relational foreign-key
constraints or column-level SQL typing. Expression indexes are appropriate for
a bounded set of frequently queried fields. For many joins or structured SQL
queries, consider ordinary Drizzle tables instead.

### Package architecture and runtime isolation

The ESM package publishes a side-effect-free core (`supersqlite`), a Node-only
adapter (`supersqlite/node`) and a Cloudflare D1 adapter (`supersqlite/d1`).
`better-sqlite3` is an **optional peer dependency**, so D1-only applications
do not need a native Node driver. The executable demo remains available via
`npm start` but is not imported by the library. `npm run smoke` validates
package exports, generated TypeScript declarations, CLI packaging, and D1
import isolation. `npm run build` emits both JS and `.d.ts` files.

The core code is separated into `factory.ts` (repository composition),
`query.ts` (query building and types), `fields.ts` (ArkType/SQL field metadata),
`document.ts` (SuperJSON codec and validation), `mutations.ts` (revision-safe
writes and schema upgrades), `projections.ts` (explicit scalar fast path),
`indexes.ts` (metadata-backed index plans) and `adapters/` (driver implementations).

Index reconciliation now inspects SQLite `PRAGMA index_list` and `index_xinfo`
in addition to canonical expression syntax. Unmanaged or ambiguous index
names remain protected; destructive actions still require explicit opt-in.

## Development

```bash
npm run typecheck
npm test
npm run ecommerce:seed
npm run ecommerce:bench
```

The tests exercise native SQLite, the D1 adapter with a D1-compatible mock,
**real local D1 via Miniflare/workerd**, joins, optional fields, serialized
rich types, morph persistence, batch rollback, chained filters, schema
upcasting, CAS conflicts, index planning, compile-time type regression
assertions and JSON/NDJSON inference. A deployed Cloudflare D1 integration
test is not included.
