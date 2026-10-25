import Database from 'better-sqlite3';
import { BetterSQLite3Adapter } from './adapters/better-sqlite3.js';

export const sqlite: Database.Database = new Database('sqlite.db');
export const db = new BetterSQLite3Adapter(sqlite);
