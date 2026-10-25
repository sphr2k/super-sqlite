import { type, type Type } from 'arktype';
import { sql, eq, and, isNull, type SQL, type SQLWrapper } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import type { SQLiteAdapter, SqlStatement, SqlRow } from './adapters/types.js';
import { readDocument, serializeDocument, type DocumentEvolution } from './document.js';
import { createIndexManager } from './indexes.js';

const dialect = new SQLiteSyncDialect();
const BATCH_SIZE = 100;

function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid SQL identifier: ${name}`);
  }
  return name;
}

function statement(fragment: SQL): SqlStatement {
  const compiled = dialect.sqlToQuery(fragment);
  return { sql: compiled.sql, params: compiled.params };
}

type Filter = Record<string, unknown> | SQL;
type FieldNames<T> = Extract<keyof T, string>;
type FilterFields<T> = Partial<{ [K in keyof T]: T[K] }>;
type SelectedKeys<S> = { [K in keyof S]: S[K] extends true ? K : never }[keyof S];
type Projected<T, S> = Pick<T, Extract<'id' | SelectedKeys<S>, keyof T>>;
type DateFields<T> = { [K in keyof T]-?: NonNullable<T[K]> extends Date ? K : never }[keyof T] & string;

interface QueryBuilder<Result, Condition> {
  where(condition: Condition | SQL): QueryBuilder<Result, Condition>;
  all(): Promise<Result[]>;
  get(): Promise<Result | undefined>;
}

function query<T, F>(adapter: SQLiteAdapter, base: SQL, decode: (row: SqlRow) => T, filter: (condition: F | SQL) => SQL | undefined): QueryBuilder<T, F> {
  function withWhere(predicates: SQL[] = []) {
    const current = () => predicates.length > 0
      ? sql`${base} WHERE ${and(...predicates)}`
      : base;
    return {
      where(condition: F | SQL) {
        const predicate = filter(condition);
        return withWhere(predicate ? [...predicates, predicate] : predicates);
      },
      async all(): Promise<T[]> {
        return (await adapter.all(statement(current()))).map(decode);
      },
      async get(): Promise<T | undefined> {
        const row = await adapter.get(statement(sql`${current()} LIMIT 1`));
        return row === undefined ? undefined : decode(row);
      }
    };
  }
  return withWhere();
}

/**
 * ArkType is the single source of truth. Data is kept as SuperJSON,
 * with expression indexes on explicitly selected fields.
 */
export class RevisionConflictError extends Error {
  constructor(id: string) { super(`Concurrent update conflict for document ${id}`); this.name = 'RevisionConflictError'; }
}
export class DocumentNotFoundError extends Error {
  constructor(id: string) { super(`Document not found: ${id}`); this.name = 'DocumentNotFoundError'; }
}

export function arktypeJsonTable<T extends Type<any>, const Name extends string>(
  typeName: string,
  schema: T,
  tableName: Name,
  adapter: SQLiteAdapter,
  indexFields: readonly FieldNames<T['infer'] & { id: string }>[] = [],
  options: { evolution?: DocumentEvolution } = {}
) {
  type DataInput = T['inferIn'];
  type DataType = T['infer'];
  type Persisted = DataType & { id: string };
  type Conditions = FilterFields<Persisted>;
  type Projection = Partial<Record<FieldNames<Persisted>, boolean>>;
  identifier(tableName);
  indexFields.forEach(identifier);
  const indexes = createIndexManager(adapter, tableName, indexFields);

  const rawTable = sqliteTable(tableName, {
    id: text('id').primaryKey(),
    data: text('data').notNull()
  });

  function field(column: string): SQL | SQLWrapper {
    identifier(column);
    if (column === 'id') return rawTable.id;
    return sql`json_extract(${rawTable.data}, ${sql.raw(`'$.json.${column}'`)})`;
  }

  // Maintains the Drizzle expression API for advanced SQL queries.
  const proxy = new Proxy({} as Record<string, any>, {
    get(_, key) {
      if (key === 'id') return rawTable.id;
      if (key === '_raw') return rawTable.data;
      if (key === '_rawTable') return rawTable;
      if (typeof key !== 'string' || ['then', 'constructor', 'toJSON', 'toString'].includes(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return undefined;
      return field(key);
    }
  });

  function decode(row: SqlRow): Persisted {
    const parsed = readDocument(String(row.data), schema, options.evolution).document;
    return { ...parsed, id: String(row.id) };
  }

  function whereFilter(condition: Filter, defaultProxy: typeof proxy = proxy, involved?: Record<string, typeof proxy>): SQL | undefined {
    if (condition instanceof Object && 'queryChunks' in condition) return condition as SQL;
    const predicates: SQL[] = [];
    const walk = (values: Record<string, unknown>, currentProxy: typeof proxy) => {
      for (const [key, value] of Object.entries(values)) {
        if (involved?.[key] && value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date)) {
          walk(value as Record<string, unknown>, involved[key]);
        } else {
          const column = currentProxy[key];
          if (!column) throw new Error(`Invalid query field: ${key}`);
          predicates.push(value == null
            ? isNull(column as any)
            : eq(column as any, value instanceof Date ? value.toISOString() : value as any));
        }
      }
    };
    walk(condition as Record<string, unknown>, defaultProxy);
    return predicates.length > 0 ? and(...predicates) : undefined;
  }

  function select(): QueryBuilder<Persisted, Conditions>;
  function select<const S extends Projection>(selection: S): QueryBuilder<Projected<Persisted, S>, Conditions>;
  function select(selection?: Projection) {
    // Reading the SuperJSON envelope preserves correct Date, Set, Map and boolean
    // projection types. JSON1 scalar extraction alone loses rich-type metadata.
    const base = sql`SELECT ${rawTable.id} AS ${sql.identifier('id')}, ${rawTable.data} AS ${sql.identifier('data')} FROM ${rawTable}`;
    const selectedFields = selection ? Object.keys(selection).filter(k => selection[k]) : undefined;
    selectedFields?.forEach(identifier);
    const decodeRow = (row: SqlRow) => {
      const document = decode(row);
      if (!selectedFields) return document;
      const projected: Record<string, unknown> = { id: document.id };
      for (const key of selectedFields) projected[key] = document[key as keyof Persisted];
      return projected;
    };
    return query<ReturnType<typeof decodeRow>, Conditions>(adapter, base, decodeRow, c => whereFilter(c as Filter));
  }

  type JoinTarget = {
    tableName: string;
    table: SQLWrapper & { id: SQLWrapper; data: SQLWrapper };
    proxy: Record<string, any>;
    _decodeStored(raw: string): Record<string, unknown>;
    findById(id: string): Promise<object | undefined>;
  };
  type JoinRow<O extends JoinTarget> = NonNullable<Awaited<ReturnType<O['findById']>>>;
  type JoinedFilters<J> = { [K in keyof J]?: FilterFields<NonNullable<J[K]>> };
  type JoinFields<O extends JoinTarget> = Partial<Record<FieldNames<Persisted>, FieldNames<JoinRow<O>>>>;
  type Join = { repo: JoinTarget; type: 'inner' | 'left'; fields: Record<string, string> };

  function createJoinBuilder<J extends Record<string, unknown>>(joins: Join[] = []) {
    type JoinConditions = Conditions | JoinedFilters<J>;
    function extend<O extends JoinTarget>(otherRepo: O, fields: Record<string, string>, joinType: 'inner' | 'left') {
      if (otherRepo.tableName === tableName || joins.some(j => j.repo.tableName === otherRepo.tableName)) {
        throw new Error('Joined table names must be unique');
      }
      return [...joins, { repo: otherRepo, fields, type: joinType }];
    }
    function select(): QueryBuilder<J, JoinConditions>;
    function select(selection: Record<string, SQL | SQLWrapper>): QueryBuilder<Record<string, unknown>, JoinConditions>;
    function select(selection?: Record<string, SQL | SQLWrapper>) {
      const repos: JoinTarget[] = [
        { tableName, table: rawTable, proxy, _decodeStored: decodeStored, findById: async () => undefined },
        ...joins.map(j => j.repo)
      ];
      const columns = selection
        ? Object.entries(selection).map(([key, expression]) => sql`${expression} AS ${sql.identifier(identifier(key))}`)
        : repos.flatMap(r => [
          sql`${r.table.id} AS ${sql.identifier(r.tableName + '__id')}`,
          sql`${r.table.data} AS ${sql.identifier(r.tableName + '__data')}`
        ]);
      const parts: SQL[] = [sql`SELECT ${sql.join(columns, sql`, `)} FROM ${rawTable}`];
      for (const join of joins) {
        const pairs = Object.entries(join.fields).map(([local, remote]) => eq(
          proxy[local] as any, join.repo.proxy[remote] as any
        ));
        if (!pairs.length) throw new Error('Join requires at least one field pair');
        const joinKind = join.type === 'left' ? sql`LEFT JOIN` : sql`INNER JOIN`;
        parts.push(sql` ${joinKind} ${join.repo.table} ON ${and(...pairs)}`);
      }
      const involved = Object.fromEntries(repos.map(r => [r.tableName, r.proxy]));
      const decodeJoin = (row: SqlRow) => {
        if (selection) return row;
        const result: Record<string, unknown> = {};
        for (const r of repos) {
          const data = row[r.tableName + '__data'];
          result[r.tableName] = data == null ? null : {
            ...r._decodeStored(String(data)),
            id: row[r.tableName + '__id']
          };
        }
        return result;
      };
      return query<Record<string, unknown>, JoinConditions>(adapter, sql.join(parts, sql``), decodeJoin, c => whereFilter(c as Filter, proxy, involved));
    }
    return {
      join<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
        return createJoinBuilder<J & Record<O['tableName'], JoinRow<O>>>(extend(otherRepo, fields as Record<string, string>, 'inner'));
      },
      leftJoin<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
        return createJoinBuilder<J & Record<O['tableName'], JoinRow<O> | null>>(extend(otherRepo, fields as Record<string, string>, 'left'));
      },
      select,
      where(condition: JoinConditions | SQL): QueryBuilder<J, JoinConditions> {
        return select().where(condition);
      }
    };
  }

  function decodeStored(raw: string): Record<string, unknown> {
    return readDocument(raw, schema, options.evolution).document as Record<string, unknown>;
  }

  async function insert(values: DataInput): Promise<Persisted>;
  async function insert(values: DataInput[]): Promise<Persisted[]>;
  async function insert(values: DataInput | DataInput[]): Promise<Persisted | Persisted[]> {
    const arr = Array.isArray(values) ? values : [values];
    const stored = arr.map(value => {
      const result = schema(value);
      if (result instanceof type.errors) throw new Error(`Validation Error: ${result.summary}`);
      const validated = result as DataType; // Persist morph output, never the raw input.
      const suppliedId = (validated as { id?: unknown }).id;
      const id = typeof suppliedId === 'string' && suppliedId.length > 0 ? suppliedId : ulid();
      return { id, data: serializeDocument(validated, 1, options.evolution?.version ?? 1), value: { ...validated, id } as Persisted };
    });
    for (let i = 0; i < stored.length; i += BATCH_SIZE) {
      const chunk = stored.slice(i, i + BATCH_SIZE);
      await adapter.batch(chunk.map(({ id, data }) => ({
        sql: `INSERT INTO "${tableName}" (id, data) VALUES (?, ?)`,
        params: [id, data]
      })));
    }
    const result = stored.map(v => v.value);
    return Array.isArray(values) ? result : result[0];
  }

  return {
    table: rawTable,
    proxy,
    tableName,
    typeName,
    _decodeStored: decodeStored,

    async initialize(): Promise<void> {
      await adapter.run({ sql: `CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)` });
      await indexes.applyIndexes(); // additive only; never silently drop indexes
    },

    planIndexes: indexes.planIndexes,
    applyIndexes: indexes.applyIndexes,

    insert,

    /**
     * Explicitly rewrite legacy documents to the current logical version.
     * Lazy read upcasting cannot make new document fields queryable by JSON1
     * until this method materializes them. Each write uses a revision CAS.
     */
    async upgradeDocuments(config: { batchSize?: number; dryRun?: boolean } = {}): Promise<{ scanned: number; upgraded: number }> {
      const target = options.evolution?.version;
      if (target == null) throw new Error('Document evolution is not configured');
      const size = config.batchSize ?? 100;
      if (!Number.isSafeInteger(size) || size < 1 || size > 1000) {
        throw new RangeError('batchSize must be an integer from 1 to 1000');
      }
      let scanned = 0;
      let upgraded = 0;
      let lastId = '';
      while (true) {
        const rows = await adapter.all<{ id: string; data: string }>({
          sql: `SELECT id, data FROM "${tableName}" WHERE id > ? ORDER BY id LIMIT ?`,
          params: [lastId, size]
        });
        if (!rows.length) break;
        for (const row of rows) {
          scanned++;
          const result = readDocument(row.data, schema, options.evolution);
          if (result.version === target) continue;
          upgraded++;
          if (config.dryRun) continue;
          const data = serializeDocument(result.document, result.revision + 1, target);
          const updated = await adapter.get<{ id: string }>({
            sql: `UPDATE "${tableName}" SET data = ? WHERE id = ? AND COALESCE(json_extract(data, '$._supersqlite.revision'), 1) = ? RETURNING id`,
            params: [data, row.id, result.revision]
          });
          if (!updated) throw new RevisionConflictError(row.id);
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < size) break;
      }
      return { scanned, upgraded };
    },

    async findByIdWithRevision(id: string): Promise<{ value: Persisted; revision: number; version: number } | undefined> {
      const row = await adapter.get<{ id: string; data: string }>({
        sql: `SELECT id, data FROM "${tableName}" WHERE id = ?`, params: [id]
      });
      if (!row) return undefined;
      const { document, revision, version } = readDocument(row.data, schema, options.evolution);
      return { value: { ...document, id } as Persisted, revision, version };
    },

    async update(id: string, patch: Partial<Omit<DataInput, 'id'>>, updateOptions: { expectedRevision?: number } = {}): Promise<{ value: Persisted; revision: number }> {
      const current = await adapter.get<{ id: string; data: string }>({
        sql: `SELECT id, data FROM "${tableName}" WHERE id = ?`, params: [id]
      });
      if (!current) throw new DocumentNotFoundError(id);
      const { document, revision } = readDocument(current.data, schema, options.evolution);
      if (updateOptions.expectedRevision !== undefined && updateOptions.expectedRevision !== revision) {
        throw new RevisionConflictError(id);
      }
      if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new TypeError('Patch must be a plain object');
      }
      const patchRecord = patch as Record<string, unknown>;
      if (Object.hasOwn(patchRecord, 'id')) throw new Error('Document id cannot be modified');
      const entries = Object.entries(patchRecord).filter(([, value]) => value !== undefined);
      let transformed: Record<string, unknown> = {};
      if (entries.length) {
        const patchSchema = (schema as any).pick(...entries.map(([key]) => key));
        const output = patchSchema(Object.fromEntries(entries));
        if (output instanceof type.errors) throw new Error(`Validation Error: ${output.summary}`);
        transformed = output as Record<string, unknown>;
      }
      const candidate: Record<string, unknown> = { ...document, ...transformed, id };
      for (const [key, value] of Object.entries(patchRecord)) {
        if (value === undefined) delete candidate[key];
      }
      const validated = schema.out(candidate);
      if (validated instanceof type.errors) throw new Error(`Validation Error: ${validated.summary}`);
      const next = revision + 1;
      const data = serializeDocument(validated, next, options.evolution?.version ?? 1);
      // One conditional statement, atomic on both backends, including D1.
      const updated = await adapter.get<{ data: string }>({
        sql: `UPDATE "${tableName}" SET data = ? WHERE id = ? AND COALESCE(json_extract(data, '$._supersqlite.revision'), 1) = ? RETURNING data`,
        params: [data, id, revision]
      });
      if (!updated) throw new RevisionConflictError(id);
      return { value: { ...validated, id } as Persisted, revision: next };
    },

    select,
    join<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
      return createJoinBuilder<Record<Name, Persisted>>().join(otherRepo, fields);
    },
    leftJoin<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
      return createJoinBuilder<Record<Name, Persisted>>().leftJoin(otherRepo, fields);
    },

    async findById(id: string): Promise<Persisted | undefined> {
      return select().where({ id } as Conditions).get();
    },
    async findByField<K extends FieldNames<Persisted>>(fieldName: K, value: Persisted[K]): Promise<Persisted[]> {
      return select().where({ [fieldName]: value } as Conditions).all();
    },
    async findDateRange<K extends DateFields<Persisted>>(fieldName: K, options: { start?: Date; end?: Date }): Promise<Persisted[]> {
      const expr = field(fieldName);
      const predicates: SQL[] = [];
      if (options.start) predicates.push(sql`${expr} >= ${options.start.toISOString()}`);
      if (options.end) predicates.push(sql`${expr} <= ${options.end.toISOString()}`);
      return predicates.length
        ? select().where(and(...predicates)!).all()
        : select().all();
    },

    async getAll(): Promise<Persisted[]> {
      return select().all();
    }
  };
}
