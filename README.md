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
import { arktypeJsonTable } from './src/factory.js';
import { BetterSQLite3Adapter } from './src/adapters/better-sqlite3.js';

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
import { D1Adapter } from './src/adapters/d1.js';
import { arktypeJsonTable } from './src/factory.js';
import { Instance } from './src/generated/instance.js';

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

**Caveat:** Schema-less documents don't give you native relational foreign-key
constraints or column-level SQL typing. Expression indexes are appropriate for
a bounded set of frequently queried fields. For many joins or structured SQL
queries, consider ordinary Drizzle tables instead.

## Development

```bash
npm run typecheck
npm test
npm run ecommerce:seed
npm run ecommerce:bench
```

The tests exercise native SQLite, the D1 adapter with a D1-compatible mock,
joins, optional fields, serialized rich types, morph persistence, batch
rollback and JSON/NDJSON inference. A deployed Cloudflare D1 integration test
is not included.
