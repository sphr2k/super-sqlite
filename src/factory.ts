import { type, type Type } from 'arktype';
import superjson from 'superjson';
import { sql, eq, and, isNull, type SQL, type SQLWrapper } from 'drizzle-orm';
import { sqliteTable, text, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { ulid } from 'ulid';
import type { SQLiteAdapter, SqlStatement, SqlRow } from './adapters/types.js';

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
type Projection = Record<string, boolean>;

function query<T>(adapter: SQLiteAdapter, base: SQL, decode: (row: SqlRow) => T, filter: (condition: Filter) => SQL | undefined) {
  function withWhere(predicates: SQL[] = []) {
    const current = () => predicates.length > 0
      ? sql`${base} WHERE ${and(...predicates)}`
      : base;
    return {
      where(condition: Filter) {
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
export function arktypeJsonTable<T extends Type<any>>(
  typeName: string,
  schema: T,
  tableName: string,
  adapter: SQLiteAdapter,
  indexFields: string[] = []
) {
  type DataInput = T['inferIn'];
  type DataType = T['infer'];
  type Persisted = DataType & { id: string };
  identifier(tableName);
  indexFields.forEach(identifier);

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
    const parsed = superjson.parse<DataType>(String(row.data));
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

  function select(selection?: Projection) {
    const selected = selection
      ? [sql`${rawTable.id} AS ${sql.identifier('id')}`,
        ...Object.keys(selection).filter(k => selection[k]).map(k =>
          sql`${field(k)} AS ${sql.identifier(k)}`)]
      : [sql`${rawTable.id} AS ${sql.identifier('id')}`, sql`${rawTable.data} AS ${sql.identifier('data')}`];
    const base = sql`SELECT ${sql.join(selected, sql`, `)} FROM ${rawTable}`;
    return query(adapter, base, selection ? (row => row as DataType) : decode, c => whereFilter(c));
  }

  type Join = { repo: { tableName: string; table: typeof rawTable; proxy: typeof proxy }; type: 'inner' | 'left'; fields: Record<string, string> };

  function createJoinBuilder(joins: Join[] = []) {
    const builder = {
      join(otherRepo: any, fields: Record<string, string>, joinType: 'inner' | 'left' = 'inner') {
        if (otherRepo.tableName === tableName || joins.some(j => j.repo.tableName === otherRepo.tableName)) {
          throw new Error('Joined table names must be unique');
        }
        return createJoinBuilder([...joins, { repo: otherRepo, fields, type: joinType }]);
      },
      leftJoin(otherRepo: any, fields: Record<string, string>) {
        return builder.join(otherRepo, fields, 'left');
      },
      select(selection?: Record<string, any>) {
        const repos = [{ tableName, table: rawTable, proxy }, ...joins.map(j => j.repo)];
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
              ...superjson.parse<Record<string, unknown>>(String(data)),
              id: row[r.tableName + '__id']
            };
          }
          return result;
        };
        return query(adapter, sql.join(parts, sql``), decodeJoin, c => whereFilter(c, proxy, involved));
      },
      where(condition: Filter) {
        return builder.select().where(condition);
      }
    };
    return builder;
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
      return { id, data: superjson.stringify(validated), value: { ...validated, id } as Persisted };
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

    async initialize(): Promise<void> {
      await adapter.run({ sql: `CREATE TABLE IF NOT EXISTS "${tableName}" (id TEXT PRIMARY KEY, data TEXT NOT NULL)` });
      for (const key of indexFields) {
        await adapter.run({ sql: `CREATE INDEX IF NOT EXISTS "idx_${tableName}_${key}" ON "${tableName}" (json_extract(data, '$.json.${key}'))` });
      }
    },

    insert,

    select,
    join: (otherRepo: any, fields: Record<string, string>) => createJoinBuilder().join(otherRepo, fields),
    leftJoin: (otherRepo: any, fields: Record<string, string>) => createJoinBuilder().leftJoin(otherRepo, fields),

    async findById(id: string): Promise<Persisted | undefined> {
      return select().where({ id }).get();
    },
    async findByField(fieldName: string, value: unknown): Promise<DataType[]> {
      return select().where({ [fieldName]: value }).all();
    },
    async findDateRange(fieldName: string, options: { start?: Date; end?: Date }): Promise<DataType[]> {
      const expr = field(fieldName);
      const predicates: SQL[] = [];
      if (options.start) predicates.push(sql`${expr} >= ${options.start.toISOString()}`);
      if (options.end) predicates.push(sql`${expr} <= ${options.end.toISOString()}`);
      return predicates.length
        ? select().where(and(...predicates)!).all()
        : select().all();
    },
    async getAll(): Promise<DataType[]> {
      return select().all();
    }
  };
}
