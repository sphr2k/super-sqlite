/** Shared async SQLite execution contract. Callers never depend on a driver's sync/async behavior. */
export type BindValue = string | number | null | Uint8Array;
export type SqlStatement = { sql: string; params?: readonly unknown[] };
export type SqlRow = Record<string, unknown>;

export interface SQLiteAdapter {
  run(statement: SqlStatement): Promise<void>;
  all<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T[]>;
  get<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T | undefined>;
  /** Execute a group of mutations transactionally, when supported by the driver. */
  batch(statements: readonly SqlStatement[]): Promise<void>;
}

export function bindParams(params: readonly unknown[] = []): BindValue[] {
  return params.map((value) => {
    if (value == null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string' || typeof value === 'number' || value instanceof Uint8Array) return value;
    throw new TypeError(`Unsupported SQLite bind parameter type: ${typeof value}`);
  });
}
