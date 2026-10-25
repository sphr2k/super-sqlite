import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

export function createRawTable<const Name extends string>(name: Name) {
  return sqliteTable(name, { id: text('id').primaryKey(), data: text('data').notNull() });
}
export type RawTable<Name extends string> = ReturnType<typeof createRawTable<Name>>;
