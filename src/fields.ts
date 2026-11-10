import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { DocumentSchema } from "./schema-port.js";

export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

/** SQL field metadata is supplied by the schema adapter, never reflected from its validator AST. */
export function createFieldAccess(
  schema: DocumentSchema<any, any>,
  id: SQLWrapper,
  data: SQLWrapper,
  rawTable?: unknown,
) {
  const fields = new Map<string, boolean>([["id", true]]);
  for (const [name, meta] of Object.entries(schema.fields))
    fields.set(name, meta.kind !== "other" && meta.kind !== "string-array");

  function assertField(name: string): void {
    identifier(name);
    if (!fields.has(name))
      throw new Error(
        `Unknown ${schema.provider === "arktype" ? "ArkType" : "document"} field: ${name}`,
      );
  }
  function assertQueryable(name: string): void {
    assertField(name);
    if (!fields.get(name))
      throw new TypeError(`Field ${name} is not queryable through JSON1; use explicit Drizzle SQL`);
  }
  function field(name: string): SQL | SQLWrapper {
    assertQueryable(name);
    if (name === "id") return id;
    return sql`json_extract(${data}, ${sql.raw(`'$.json.${name}'`)})`;
  }
  const proxy = new Proxy({} as Record<string, SQL>, {
    get(_, key) {
      if (key === "_raw") return sql`${data}`;
      if (key === "_rawTable") return rawTable;
      if (typeof key !== "string" || ["then", "constructor", "toJSON", "toString"].includes(key))
        return undefined;
      return sql`${field(key)}`;
    },
  });
  return { field, assertField, assertQueryable, proxy, fields };
}
