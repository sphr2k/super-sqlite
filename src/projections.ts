import { type, type Type } from 'arktype';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { SQLiteAdapter, SqlRow } from './adapters/types.js';
import { query, type QueryBuilder, type FilterFields, type Projected, type QueryableKeys } from './query.js';
import type { DocumentEvolution } from './document.js';
import { identifier } from './fields.js';

type Full<T extends Type<any>> = T['infer'] & { id: string };
type Selection<T extends Type<any>> = Partial<Record<QueryableKeys<Full<T>>, boolean>>;

/**
 * Explicit performance escape hatch: only the selected scalar fields are
 * validated. NEVER use this when full-document validation/upcasting is needed.
 */
export function makeScalarSelector<T extends Type<any>>(
  schema: T,
  adapter: SQLiteAdapter,
  table: { id: SQLWrapper; data: SQLWrapper },
  tableSql: SQL,
  field: (name: string) => SQL | SQLWrapper,
  assertQueryable: (name: string) => void,
  where: (condition: FilterFields<Full<T>> | SQL) => SQL | undefined,
  evolution?: DocumentEvolution
) {
  function selectScalar<const S extends Selection<T>>(selection: S): QueryBuilder<Projected<Full<T>, S>, FilterFields<Full<T>>> {
    if (evolution) throw new Error('selectScalar is unavailable on evolution-enabled repositories; use select()');
    const keys = Object.entries(selection).filter(([, enabled]) => enabled).map(([key]) => key).filter(k => k !== 'id');
    for (const key of keys) { identifier(key); assertQueryable(key); }
    const props = (schema.out as unknown as { props?: readonly { key: string; optional?: boolean; value: { expression: string; json: unknown } }[] }).props ?? [];
    const byName = new Map(props.map(p => [String(p.key), p]));
    for (const key of keys) {
      const prop = byName.get(key);
      if (!prop || prop.optional || prop.value.expression.includes('null')) {
        throw new TypeError(`selectScalar currently requires non-optional, non-nullable scalar fields: ${key}`);
      }
    }
    const selectedSchema = (schema.out as unknown as {
      pick(...names: string[]): (value: Record<string, unknown>) => Record<string, unknown>
    }).pick(...keys);
    const columns = [sql`${table.id} AS ${sql.identifier('id')}`,
      ...keys.map(key => sql`${field(key)} AS ${sql.identifier(key)}`)];
    const base = sql`SELECT ${sql.join(columns, sql`, `)} FROM ${tableSql}`;
    const decode = (row: SqlRow): Projected<Full<T>, S> => {
      const projected: Record<string, unknown> = { id: String(row.id) };
      for (const key of keys) {
        let value = row[key];
        const expression = byName.get(key)!.value.expression;
        if (value === null || value === undefined) {
          throw new TypeError(`Missing required scalar value for ${key}`);
        }
        if (expression === 'boolean') {
          if (![0, 1, false, true].includes(value as number)) throw new TypeError(`Invalid boolean scalar: ${key}`);
          value = value === 1 || value === true;
        }
        else if (expression === 'Date') {
          value = new Date(String(value));
          if (Number.isNaN((value as Date).getTime())) throw new TypeError(`Invalid date scalar: ${key}`);
        }
        projected[key] = value;
      }
      const verified = selectedSchema(Object.fromEntries(keys.map(key => [key, projected[key]])));
      if (verified instanceof type.errors) throw new Error(`Invalid scalar projection: ${verified.summary}`);
      return { ...verified, id: projected.id } as Projected<Full<T>, S>;
    };
    return query(adapter, base, decode, where);
  }
  return { selectScalar };
}
