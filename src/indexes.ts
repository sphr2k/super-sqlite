import type { SQLiteAdapter } from './adapters/types.js';

export interface IndexOperation {
  action: 'create' | 'drop';
  name: string;
  sql: string;
}
export interface IndexApplyOptions {
  /** Explicitly allow removal of obsolete indexes that match SuperSQLite-managed definitions. */
  dropObsolete?: boolean;
}

const identifier = (value: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid SQL identifier: ${value}`);
  return value;
};

function expectedSql(tableName: string, field: string): string {
  return `CREATE INDEX "idx_${tableName}_${field}" ON "${tableName}" (json_extract(data, '$.json.${field}'))`;
}

/** Match only exactly the managed expression, allowing harmless SQL formatting
 * differences without treating different JSON paths as equivalent. */
function isManagedExpression(definition: string, table: string, name: string, field: string): boolean {
  const ident = (word: string) => `(?:"${word}"|\`${word}\`|\[${word}\]|${word})`;
  const grammar = [
    '^CREATE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?',
    ident(name), '\\s+ON\\s+', ident(table),
    '\\s*\\(\\s*json_extract\\s*\\(\\s*(?:"data"|`data`|data)\\s*,\\s*',
    "'([^']+)'",
    '\\s*\\)\\s*\\)\\s*;?\\s*$'
  ].join('');
  const matched = new RegExp(grammar, 'i').exec(definition);
  return matched !== null && matched[1] === `$.json.${field}`;
}

export function createIndexManager(adapter: SQLiteAdapter, tableName: string, desiredFields: readonly string[]) {
  identifier(tableName);
  desiredFields.forEach(identifier);
  const prefix = `idx_${tableName}_`;
  const desired = new Set(desiredFields);

  async function planIndexes(): Promise<IndexOperation[]> {
    const existing = await adapter.all<{ name: string; sql: string | null }>({
      sql: 'SELECT name, sql FROM sqlite_master WHERE type = ? AND tbl_name = ? ORDER BY name',
      params: ['index', tableName]
    });
    const metadata = await adapter.all<{ name: string; unique: number; origin: string; partial: number }>({
      sql: `PRAGMA index_list("${tableName}")`
    });
    const byName = new Map(metadata.map(item => [item.name, item]));
    const found = new Set<string>();
    const operations: IndexOperation[] = [];
    for (const index of existing) {
      if (!index.name.startsWith(prefix)) continue;
      const field = index.name.slice(prefix.length);
      // Treat only exact generated definitions as managed; don't delete user/manual indexes.
      const meta = byName.get(index.name);
      const columns = await adapter.all<{ cid: number; key: number; desc: number; coll: string }>({
        sql: `PRAGMA index_xinfo("${index.name}")`
      });
      const keyColumns = columns.filter(column => column.key === 1);
      const generated = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) &&
        meta?.origin === 'c' && meta.unique === 0 && meta.partial === 0 &&
        keyColumns.length === 1 && keyColumns[0].cid === -2 &&
        keyColumns[0].desc === 0 && keyColumns[0].coll === 'BINARY' &&
        index.sql != null && isManagedExpression(index.sql, tableName, index.name, field);
      if (!generated) {
        if (desired.has(field)) throw new Error(`Conflicting unmanaged index: ${index.name}`);
        continue;
      }
      if (desired.has(field)) found.add(field);
      else operations.push({ action: 'drop', name: index.name, sql: `DROP INDEX "${index.name}"` });
    }
    for (const field of [...desired].sort()) {
      if (!found.has(field)) {
        const name = prefix + field;
        // Check any conflicting name, even if its definition isn't managed.
        if (existing.some(index => index.name === name)) throw new Error(`Conflicting unmanaged index: ${name}`);
        operations.push({ action: 'create', name, sql: expectedSql(tableName, field) });
      }
    }
    return operations.sort((a, b) => a.name.localeCompare(b.name) || a.action.localeCompare(b.action));
  }

  async function applyIndexes(options: IndexApplyOptions = {}): Promise<IndexOperation[]> {
    const plan = await planIndexes();
    const selected = plan.filter(operation => operation.action === 'create' || options.dropObsolete);
    if (selected.length) await adapter.batch(selected.map(operation => ({ sql: operation.sql })));
    return selected;
  }
  return { planIndexes, applyIndexes };
}
