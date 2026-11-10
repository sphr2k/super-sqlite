import {
  bindParams,
  type SQLiteAdapter,
  type SqlStatement,
  type SqlRow,
  type BindValue,
} from "./types.js";

/** Structural types: no runtime dependency on Cloudflare's Workers SDK. */
export interface DurableObjectSqlStorage {
  exec(
    sql: string,
    ...bindings: BindValue[]
  ): {
    toArray(): SqlRow[];
  };
}
export interface DurableObjectStorageLike {
  readonly sql: DurableObjectSqlStorage;
  transactionSync<T>(callback: () => T): T;
}

/** SQLite-backed DO storage: local synchronous SQL behind the asynchronous adapter contract. */
export class DurableObjectAdapter implements SQLiteAdapter {
  constructor(readonly storage: DurableObjectStorageLike) {}

  async run(statement: SqlStatement): Promise<void> {
    this.storage.sql.exec(statement.sql, ...bindParams(statement.params)).toArray();
  }
  async all<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T[]> {
    return this.storage.sql.exec(statement.sql, ...bindParams(statement.params)).toArray() as T[];
  }
  async get<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T | undefined> {
    return this.storage.sql.exec(statement.sql, ...bindParams(statement.params)).toArray()[0] as
      | T
      | undefined;
  }
  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (!statements.length) return;
    this.storage.transactionSync(() => {
      for (const statement of statements) {
        this.storage.sql.exec(statement.sql, ...bindParams(statement.params)).toArray();
      }
    });
  }
}
