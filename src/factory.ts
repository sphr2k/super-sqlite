import type { Type } from 'arktype';
import { sql, eq, and, isNull, type SQL, type SQLWrapper } from 'drizzle-orm';
import { createRawTable } from './table.js';
import type { SQLiteAdapter, SqlRow } from './adapters/types.js';
import { query, type QueryBuilder, type FieldNames, type FilterFields, type QueryableKeys, type SelectedKeys, type Projected, type DateFields } from './query.js';
import { createFieldAccess } from './fields.js';
import { readDocument, type DocumentEvolution } from './document.js';
import { createDocumentMutations } from './mutations.js';
import { makeScalarSelector } from './projections.js';
import type { Repository } from './repository-types.js';
export { RevisionConflictError, DocumentNotFoundError } from './mutations.js';
import { createIndexManager } from './indexes.js';

type Filter = Record<string, unknown> | SQL;

/**
 * ArkType is the single source of truth. Data is kept as SuperJSON,
 * with expression indexes on explicitly selected fields.
 */
export function arktypeJsonTable<T extends Type<any>, const Name extends string>(
  typeName: string,
  schema: T,
  tableName: Name,
  adapter: SQLiteAdapter,
  indexFields: readonly QueryableKeys<T['infer'] & { id: string }>[] = [],
  options: { evolution?: DocumentEvolution } = {}
): Repository<T, Name> {
  type DataType = T['infer'];
  type Persisted = DataType & { id: string };
  type Conditions = FilterFields<Persisted>;
  type Projection = Partial<Record<FieldNames<Persisted>, boolean>>;
  const nameOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName);
  if (!nameOk) throw new Error(`Invalid table identifier: ${tableName}`);
  const indexes = createIndexManager(adapter, tableName, indexFields);
  const mutations = createDocumentMutations(schema, tableName, adapter, options.evolution);

  const rawTable = createRawTable(tableName);

  const { field, proxy, assertQueryable, assertField } = createFieldAccess(schema, rawTable.id, rawTable.data, rawTable);
  indexFields.forEach(assertQueryable);

  function decode(row: SqlRow): Persisted {
    const parsed = readDocument(String(row.data), schema, options.evolution, String(row.id)).document;
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

  const { selectScalar } = makeScalarSelector(schema, adapter, rawTable, sql`${rawTable}`,
    field, assertQueryable, c => whereFilter(c as Filter), options.evolution);

  function select(): QueryBuilder<Persisted, Conditions>;
  function select<const S extends Projection>(selection: S): QueryBuilder<Projected<Persisted, S>, Conditions>;
  function select(selection?: Projection) {
    // Reading the SuperJSON envelope preserves correct Date, Set, Map and boolean
    // projection types. JSON1 scalar extraction alone loses rich-type metadata.
    const base = sql`SELECT ${rawTable.id} AS ${sql.identifier('id')}, ${rawTable.data} AS ${sql.identifier('data')} FROM ${rawTable}`;
    const selectedFields = selection ? Object.keys(selection).filter(k => selection[k]) : undefined;
    selectedFields?.forEach(assertField);
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
    _decodeStored(raw: string, id?: string): Record<string, unknown>;
    /** Phantom type; no dummy I/O methods in join metadata. */
    readonly _entityType?: Record<string, unknown>;
  };
  type JoinRow<O extends JoinTarget> = NonNullable<O['_entityType']>;
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
        { tableName, table: rawTable, proxy, _decodeStored: decodeStored },
        ...joins.map(j => j.repo)
      ];
      if (selection) Object.keys(selection).forEach(k => { if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`Invalid SQL alias: ${k}`); });
      const columns = selection
        ? Object.entries(selection).map(([key, expression]) => sql`${expression} AS ${sql.identifier(key)}`)
        : repos.flatMap(r => [
          sql`${r.table.id} AS ${sql.identifier(r.tableName + '__id')}`,
          sql`${r.table.data} AS ${sql.identifier(r.tableName + '__data')}`
        ]);
      const parts: SQL[] = [sql`SELECT ${sql.join(columns, sql`, `)} FROM ${rawTable}`];
      for (const join of joins) {
        const pairs = Object.entries(join.fields).map(([local, remote]) => eq(
          proxy[local], join.repo.proxy[remote]
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
            ...r._decodeStored(String(data), String(row[r.tableName + '__id'])),
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

  function decodeStored(raw: string, id?: string): Record<string, unknown> {
    return readDocument(raw, schema, options.evolution, id).document as Record<string, unknown>;
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

    ...mutations,


    select,
    selectScalar,
    join<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
      return createJoinBuilder<Record<Name, Persisted>>().join(otherRepo, fields);
    },
    leftJoin<const O extends JoinTarget>(otherRepo: O, fields: JoinFields<O>) {
      return createJoinBuilder<Record<Name, Persisted>>().leftJoin(otherRepo, fields);
    },

    async findById(id: string): Promise<Persisted | undefined> {
      return select().where({ id } as Conditions).get();
    },
    async findByField<K extends QueryableKeys<Persisted>>(fieldName: K, value: Persisted[K]): Promise<Persisted[]> {
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
  } as unknown as Repository<T, Name>;
}
