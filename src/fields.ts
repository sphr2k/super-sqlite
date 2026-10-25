import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { Type } from 'arktype';

export function identifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

type SchemaProperty = { key: string; value: { json: unknown } };
function sqlCompatible(json: unknown): boolean {
  if (typeof json === 'string') return ['string', 'number', 'boolean', 'Date', 'null'].includes(json);
  if (Array.isArray(json)) return json.every(sqlCompatible);
  if (json && typeof json === 'object' && 'proto' in json) return (json as {proto: unknown}).proto === 'Date';
  if (json && typeof json === 'object' && 'domain' in json) {
    return ['string', 'number', 'boolean', 'null'].includes(String((json as {domain: unknown}).domain));
  }
  if (json && typeof json === 'object' && 'unit' in json) {
    const value = (json as { unit: unknown }).unit;
    return value === null || ['string', 'number', 'boolean'].includes(typeof value);
  }
  return false;
}

export function createFieldAccess(schema: Type<any>, id: SQLWrapper, data: SQLWrapper, rawTable?: unknown) {
  const properties = (schema.out as unknown as { props?: readonly SchemaProperty[] }).props;
  const fields = new Map<string, boolean>([['id', true]]);
  for (const prop of properties ?? []) fields.set(String(prop.key), sqlCompatible(prop.value.json));

  function assertField(name: string): void {
    identifier(name);
    if (!fields.has(name)) throw new Error(`Unknown ArkType field: ${name}`);
  }
  function assertQueryable(name: string): void {
    assertField(name);
    if (!fields.get(name)) throw new TypeError(`Field ${name} is not queryable through JSON1; use explicit Drizzle SQL`);
  }
  function field(name: string): SQL | SQLWrapper {
    assertQueryable(name);
    if (name === 'id') return id;
    return sql`json_extract(${data}, ${sql.raw(`'$.json.${name}'`)})`;
  }
  const proxy = new Proxy({} as Record<string, SQL>, {
    get(_, key) {
      if (key === '_raw') return sql`${data}`;
      if (key === '_rawTable') return rawTable;
      if (typeof key !== 'string' || ['then', 'constructor', 'toJSON', 'toString'].includes(key)) return undefined;
      return sql`${field(key)}`;
    }
  });
  return { field, assertField, assertQueryable, proxy, fields };
}
