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

function canonicalSql(value: string): string {
  // SQLite stores the original CREATE statement, including IF NOT EXISTS.
  // Earlier SuperSQLite releases used that clause for every generated index.
  return value.replace(/^CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+/i, 'CREATE INDEX ').trim();
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
    const found = new Set<string>();
    const operations: IndexOperation[] = [];
    for (const index of existing) {
      if (!index.name.startsWith(prefix)) continue;
      const field = index.name.slice(prefix.length);
      // Treat only exact generated definitions as managed; don't delete user/manual indexes.
      const generated = /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) &&
        index.sql != null && canonicalSql(index.sql) === expectedSql(tableName, field);
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
