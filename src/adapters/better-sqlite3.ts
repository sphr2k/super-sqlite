import type Database from 'better-sqlite3';
import { bindParams, type SQLiteAdapter, type SqlStatement, type SqlRow } from './types.js';

export class BetterSQLite3Adapter implements SQLiteAdapter {
  constructor(readonly database: Database.Database) {}

  async run(statement: SqlStatement): Promise<void> {
    this.database.prepare(statement.sql).run(...bindParams(statement.params));
  }

  async all<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T[]> {
    return this.database.prepare(statement.sql).all(...bindParams(statement.params)) as T[];
  }

  async get<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T | undefined> {
    return this.database.prepare(statement.sql).get(...bindParams(statement.params)) as T | undefined;
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    this.database.transaction(() => {
      for (const statement of statements) {
        this.database.prepare(statement.sql).run(...bindParams(statement.params));
      }
    })();
  }
}
