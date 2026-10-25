import { bindParams, type SQLiteAdapter, type SqlStatement, type SqlRow } from './types.js';

/** Structural Cloudflare D1 types, avoiding a dependency on workers-types in Node builds. */
export interface D1StatementLike {
  bind(...values: any[]): D1StatementLike;
  run(): Promise<unknown>;
  all<T = SqlRow>(): Promise<{ results: T[] }>;
  first<T = SqlRow>(column?: string): Promise<T | null>;
}
export interface D1DatabaseLike {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

export class D1Adapter implements SQLiteAdapter {
  constructor(readonly database: D1DatabaseLike) {}

  private prepare(statement: SqlStatement): D1StatementLike {
    const prepared = this.database.prepare(statement.sql);
    const params = bindParams(statement.params);
    return params.length ? prepared.bind(...params) : prepared;
  }

  async run(statement: SqlStatement): Promise<void> {
    await this.prepare(statement).run();
  }

  async all<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T[]> {
    return (await this.prepare(statement).all<T>()).results;
  }

  async get<T extends SqlRow = SqlRow>(statement: SqlStatement): Promise<T | undefined> {
    return (await this.prepare(statement).first<T>()) ?? undefined;
  }

  async batch(statements: readonly SqlStatement[]): Promise<void> {
    if (statements.length === 0) return;
    await this.database.batch(statements.map((statement) => this.prepare(statement)));
  }
}
