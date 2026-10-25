import { and, sql, type SQL } from 'drizzle-orm';
import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import type { SQLiteAdapter, SqlRow, SqlStatement } from './adapters/types.js';

const dialect = new SQLiteSyncDialect();
export function compileSql(fragment: SQL): SqlStatement {
  const compiled = dialect.sqlToQuery(fragment);
  return { sql: compiled.sql, params: compiled.params };
}

export type FieldNames<T> = Extract<keyof T, string>;
export type SqlScalar = string | number | boolean | Date | null;
export type QueryableKeys<T> = Extract<{
  [K in keyof T]-?: Exclude<T[K], undefined> extends SqlScalar ? K : never;
}[keyof T], string>;
export type FilterFields<T> = Partial<Pick<T, QueryableKeys<T>>>;
export type SelectedKeys<S> = { [K in keyof S]: S[K] extends true ? K : never }[keyof S];
export type Projected<T, S> = Pick<T, Extract<'id' | SelectedKeys<S>, keyof T>>;
export type DateFields<T> = { [K in keyof T]-?: NonNullable<T[K]> extends Date ? K : never }[keyof T] & string;

export interface QueryBuilder<Result, Condition> {
  where(condition: Condition | SQL): QueryBuilder<Result, Condition>;
  all(): Promise<Result[]>;
  get(): Promise<Result | undefined>;
}
export function query<T, F>(adapter: SQLiteAdapter, base: SQL, decode: (row: SqlRow) => T, filter: (condition: F | SQL) => SQL | undefined): QueryBuilder<T, F> {
  const withWhere = (predicates: SQL[] = []): QueryBuilder<T, F> => {
    const current = () => predicates.length ? sql`${base} WHERE ${and(...predicates)}` : base;
    return {
      where(condition) {
        const predicate = filter(condition);
        return withWhere(predicate ? [...predicates, predicate] : predicates);
      },
      async all() {
        return (await adapter.all(compileSql(current()))).map(decode);
      },
      async get() {
        const row = await adapter.get(compileSql(sql`${current()} LIMIT 1`));
        return row === undefined ? undefined : decode(row);
      }
    };
  };
  return withWhere();
}
