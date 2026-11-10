import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SQLiteAdapter, SqlRow } from "./adapters/types.js";
import {
  query,
  type QueryBuilder,
  type FilterFields,
  type Projected,
  type QueryableKeys,
} from "./query.js";
import type { DocumentEvolution } from "./document.js";
import { identifier } from "./fields.js";
import type { DocumentSchema } from "./schema-port.js";

type Full<T extends DocumentSchema<any, any>> = T["infer"] & { id: string };
type Selection<T extends DocumentSchema<any, any>> = Partial<
  Record<QueryableKeys<Full<T>>, boolean>
>;

/** Performance escape hatch: only selected scalar fields are validated. */
export function makeScalarSelector<T extends DocumentSchema<any, any>>(
  schema: T,
  adapter: SQLiteAdapter,
  table: { id: SQLWrapper; data: SQLWrapper },
  tableSql: SQL,
  field: (name: string) => SQL | SQLWrapper,
  assertQueryable: (name: string) => void,
  where: (condition: FilterFields<Full<T>> | SQL) => SQL | undefined,
  evolution?: DocumentEvolution,
) {
  function selectScalar<const S extends Selection<T>>(
    selection: S,
  ): QueryBuilder<Projected<Full<T>, S>, FilterFields<Full<T>>> {
    if (evolution)
      throw new Error(
        "selectScalar is unavailable on evolution-enabled repositories; use select()",
      );
    const keys = Object.entries(selection)
      .filter(([, v]) => v)
      .map(([key]) => key)
      .filter((k) => k !== "id");
    for (const key of keys) {
      identifier(key);
      assertQueryable(key);
      const meta = schema.fields[key];
      if (!meta || meta.optional || meta.nullable || meta.kind === "other")
        throw new TypeError(
          `selectScalar requires non-optional, non-nullable scalar fields: ${key}`,
        );
    }
    const columns = [
      sql`${table.id} AS ${sql.identifier("id")}`,
      ...keys.map((key) => sql`${field(key)} AS ${sql.identifier(key)}`),
    ];
    const base = sql`SELECT ${sql.join(columns, sql`, `)} FROM ${tableSql}`;
    const decode = (row: SqlRow): Projected<Full<T>, S> => {
      const projected: Record<string, unknown> = { id: String(row.id) };
      for (const key of keys) {
        let value = row[key];
        const meta = schema.fields[key]!;
        if (value == null) throw new TypeError(`Missing required scalar: ${key}`);
        if (meta.kind === "boolean") {
          if (![0, 1, true, false].includes(value as number))
            throw new TypeError(`Invalid boolean scalar: ${key}`);
          value = value === 1 || value === true;
        } else if (meta.kind === "date") {
          value = new Date(String(value));
          if (Number.isNaN((value as Date).getTime())) throw new TypeError(`Invalid date: ${key}`);
        } else if (typeof value !== meta.kind) throw new TypeError(`Invalid scalar: ${key}`);
        projected[key] = value;
      }
      const validated = schema.parseProjection(
        Object.fromEntries(keys.map((k) => [k, projected[k]])),
        keys,
      );
      return { ...validated, id: projected.id } as Projected<Full<T>, S>;
    };
    return query(adapter, base, decode, where);
  }
  return { selectScalar };
}
