import type { SQLiteAdapter, SqlRow, SqlStatement } from "./adapters/types.js";
import { identifier } from "./fields.js";

export type TextField<T> = Extract<
  { [K in keyof T]-?: NonNullable<T[K]> extends string ? K : never }[keyof T],
  string
>;
export type StringArrayField<T> = Extract<
  { [K in keyof T]-?: NonNullable<T[K]> extends readonly string[] ? K : never }[keyof T],
  string
>;

export interface DerivedIndexOptions<T extends object> {
  fullText?: {
    fields: readonly TextField<T>[];
    weights?: readonly number[];
    tokenizer?: "unicode61" | "porter";
  };
  arrays?: readonly StringArrayField<T>[];
}
export interface DerivedIndexPlan {
  name: string;
  status: "create" | "current" | "changed" | "missing" | "drift";
  reason?: string;
  signature: string;
}

/** Explicitly managed materialized SQLite indexes, kept in sync by database triggers. */
export function createDerivedIndexManager<T extends object>(
  adapter: SQLiteAdapter,
  tableName: string,
  options: DerivedIndexOptions<T> = {},
) {
  identifier(tableName);
  const quote = (name: string) => `"${identifier(name)}"`;
  const source = quote(tableName);
  const metaTable = '"__supersqlite_derived_indexes"';
  const fts = options.fullText;
  const arrays = options.arrays ?? [];
  if (new Set(arrays).size !== arrays.length)
    throw new TypeError("Duplicate array-index field names");
  const specs: {
    name: string;
    signature: string;
    ddl: string[];
    backfill: string;
    drop: string[];
  }[] = [];
  const jsonColumn = (alias: string, field: string) =>
    `json_extract(${alias}.data, '$.json.${identifier(field)}')`;

  if (fts) {
    if (!fts.fields.length || new Set(fts.fields).size !== fts.fields.length)
      throw new TypeError("FTS fields must be nonempty and unique");
    const fields = fts.fields.map(identifier);
    if (
      fts.weights &&
      (fts.weights.length !== fields.length ||
        fts.weights.some((w) => !Number.isFinite(w) || w < 0))
    )
      throw new TypeError("FTS weights must match fields and be finite/nonnegative");
    const name = identifier(`__ss_fts_${tableName}`);
    const q = quote(name);
    const cols = fields.map(quote).join(", ");
    const exprs = fields.map((f) => `COALESCE(${jsonColumn("NEW", f)}, '')`).join(", ");
    const srcExprs = fields.map((f) => `COALESCE(${jsonColumn("b", f)}, '')`).join(", ");
    const trig = (action: string) => quote(`__ss_${tableName}_fts_${action}`);
    const tokenizer = fts.tokenizer ?? "unicode61";
    specs.push({
      name,
      signature: JSON.stringify({ kind: "fts5", fields, tokenizer, weights: fts.weights ?? null }),
      ddl: [
        `CREATE VIRTUAL TABLE ${q} USING fts5(doc_id UNINDEXED, ${cols}, tokenize='${tokenizer}')`,
        `CREATE TRIGGER ${trig("insert")} AFTER INSERT ON ${source} BEGIN INSERT INTO ${q} (doc_id, ${cols}) VALUES (NEW.id, ${exprs}); END`,
        `CREATE TRIGGER ${trig("update")} AFTER UPDATE ON ${source} BEGIN DELETE FROM ${q} WHERE doc_id = OLD.id; INSERT INTO ${q} (doc_id, ${cols}) VALUES (NEW.id, ${exprs}); END`,
        `CREATE TRIGGER ${trig("delete")} AFTER DELETE ON ${source} BEGIN DELETE FROM ${q} WHERE doc_id = OLD.id; END`,
      ],
      backfill: `INSERT INTO ${q} (doc_id, ${cols}) SELECT b.id, ${srcExprs} FROM ${source} AS b`,
      drop: [
        ...["insert", "update", "delete"].map((a) => `DROP TRIGGER IF EXISTS ${trig(a)}`),
        `DROP TABLE IF EXISTS ${q}`,
      ],
    });
  }
  for (const field of arrays) {
    identifier(field);
    const name = identifier(`__ss_arr_${tableName}_${field}`);
    const q = quote(name);
    const idx = quote(`__ss_idx_${tableName}_${field}_value`);
    const trig = (action: string) => quote(`__ss_${tableName}_${field}_${action}`);
    const add = (alias: string) =>
      `INSERT OR IGNORE INTO ${q} (document_id, value) SELECT ${alias}.id, j.value FROM json_each(${alias}.data, '$.json.${field}') AS j WHERE j.type = 'text'`;
    specs.push({
      name,
      signature: JSON.stringify({ kind: "string-array", field }),
      ddl: [
        `CREATE TABLE ${q} (document_id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(document_id, value))`,
        `CREATE INDEX ${idx} ON ${q} (value, document_id)`,
        `CREATE TRIGGER ${trig("insert")} AFTER INSERT ON ${source} BEGIN ${add("NEW")}; END`,
        `CREATE TRIGGER ${trig("update")} AFTER UPDATE ON ${source} BEGIN DELETE FROM ${q} WHERE document_id = OLD.id; ${add("NEW")}; END`,
        `CREATE TRIGGER ${trig("delete")} AFTER DELETE ON ${source} BEGIN DELETE FROM ${q} WHERE document_id = OLD.id; END`,
      ],
      backfill: `INSERT OR IGNORE INTO ${q} (document_id, value) SELECT b.id, j.value FROM ${source} AS b, json_each(b.data, '$.json.${field}') AS j WHERE j.type = 'text'`,
      drop: [
        ...["insert", "update", "delete"].map((a) => `DROP TRIGGER IF EXISTS ${trig(a)}`),
        `DROP TABLE IF EXISTS ${q}`,
      ],
    });
  }

  const exists = async (name: string): Promise<boolean> =>
    !!(await adapter.get({
      sql: "SELECT name FROM sqlite_master WHERE name = ? LIMIT 1",
      params: [name],
    }));
  const readStored = async (name: string): Promise<string | null> => {
    if (!(await exists("__supersqlite_derived_indexes"))) return null;
    const result = await adapter.get<{ signature: string }>({
      sql: `SELECT signature FROM ${metaTable} WHERE table_name = ? AND index_name = ?`,
      params: [tableName, name],
    });
    return result?.signature ?? null;
  };

  type PhysicalObject = { name: string; type: string; sql: string | null };
  function expectedObjects(spec: (typeof specs)[number]) {
    return spec.ddl.map((ddl) => {
      const match =
        /^CREATE\s+(?:VIRTUAL\s+)?(TABLE|TRIGGER|INDEX)\s+"([A-Za-z_][A-Za-z0-9_]*)"/i.exec(ddl);
      if (!match) throw new TypeError(`Unrecognized managed index DDL: ${ddl}`);
      return { name: match[2], type: match[1].toLowerCase(), sql: ddl };
    });
  }
  const normalizedSql = (sql: string) => sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
  async function physicalObjects(spec: (typeof specs)[number]) {
    const expected = expectedObjects(spec);
    return adapter.all<PhysicalObject>({
      sql: `SELECT name,type,sql FROM sqlite_master WHERE name IN (${expected.map(() => "?").join(", ")})`,
      params: expected.map((object) => object.name),
    });
  }
  async function plan(): Promise<DerivedIndexPlan[]> {
    return Promise.all(
      specs.map(async (spec) => {
        const stored = await readStored(spec.name);
        const expected = expectedObjects(spec);
        const found = new Map((await physicalObjects(spec)).map((o) => [o.name, o]));
        const missing = expected.filter((o) => !found.has(o.name));
        const tampered = expected.filter((o) => {
          const actual = found.get(o.name);
          return (
            actual &&
            (actual.type !== o.type || normalizedSql(actual.sql ?? "") !== normalizedSql(o.sql))
          );
        });
        if (stored === null) {
          return {
            name: spec.name,
            signature: spec.signature,
            status: found.size ? "drift" : "create",
            ...(found.size ? { reason: "Managed-name collision without metadata" } : {}),
          } as DerivedIndexPlan;
        }
        if (missing.length)
          return {
            name: spec.name,
            signature: spec.signature,
            status: "missing",
            reason: `Missing managed SQLite objects: ${missing.map((o) => o.name).join(", ")}`,
          } as DerivedIndexPlan;
        if (stored === spec.signature && tampered.length)
          return {
            name: spec.name,
            signature: spec.signature,
            status: "drift",
            reason: `Modified managed SQLite objects: ${tampered.map((o) => o.name).join(", ")}`,
          } as DerivedIndexPlan;
        return {
          name: spec.name,
          signature: spec.signature,
          status: stored === spec.signature ? "current" : "changed",
        } as DerivedIndexPlan;
      }),
    );
  }
  async function apply(
    options: { allowDefinitionChange?: boolean; allowRepair?: boolean } = {},
  ): Promise<DerivedIndexPlan[]> {
    if (!specs.length) return [];
    // The plan is read-only. Preflight *all* definitions before changing anything.
    const summary = await plan();
    for (const state of summary) {
      if (state.status === "changed" && !options.allowDefinitionChange)
        throw new Error(
          `Index definition changed for ${state.name}: explicit replacement required`,
        );
      if ((state.status === "missing" || state.status === "drift") && !options.allowRepair)
        throw new Error(
          `Index integrity error for ${state.name}: ${state.reason ?? state.status}; explicit repair required`,
        );
      if (state.status === "drift" && state.reason?.includes("collision"))
        throw new Error(
          `Unmanaged SQLite object collision for ${state.name}; manual recovery required`,
        );
    }
    // Register the metadata table once, only during provisioning.
    await adapter.run({
      sql: `CREATE TABLE IF NOT EXISTS ${metaTable} (
        table_name TEXT NOT NULL, index_name TEXT NOT NULL, signature TEXT NOT NULL,
        PRIMARY KEY(table_name, index_name))`,
    });
    for (const [i, spec] of specs.entries()) {
      const state = summary[i];
      if (state.status === "current") continue;
      const replace = state.status !== "create";
      const statements: SqlStatement[] = [
        ...(replace ? spec.drop.map((sql) => ({ sql })) : []),
        ...spec.ddl.map((sql) => ({ sql })),
        { sql: spec.backfill },
        {
          sql: `INSERT INTO ${metaTable} (table_name,index_name,signature) VALUES (?,?,?)
          ON CONFLICT(table_name,index_name) DO UPDATE SET signature=excluded.signature`,
          params: [tableName, spec.name, spec.signature],
        },
      ];
      await adapter.batch(statements);
    }
    return summary;
  }
  async function rebuild(): Promise<void> {
    const planned = await plan();
    for (const state of planned) {
      if (state.status !== "current")
        throw new Error(`Cannot rebuild damaged or outdated index ${state.name}: ${state.status}`);
    }
    for (const spec of specs) {
      await adapter.batch([{ sql: `DELETE FROM ${quote(spec.name)}` }, { sql: spec.backfill }]);
    }
  }
  async function search(
    text: string,
    config: { limit?: number } = {},
  ): Promise<Array<SqlRow & { score: number }>> {
    if (!fts) throw new Error("No full-text index configured");
    if (!text.trim()) return [];
    const name = quote(`__ss_fts_${tableName}`);
    const weights = fts.fields.map((_, i) => fts.weights?.[i] ?? 1);
    const limit = Math.min(1000, Math.max(1, config.limit ?? 50));
    return adapter.all({
      sql: `SELECT b.id, b.data, bm25(${name}, 0, ${weights.join(", ")}) AS score
        FROM ${source} AS b JOIN ${name} ON ${name}.doc_id = b.id
        WHERE ${name} MATCH ? ORDER BY score, b.id LIMIT ?`,
      params: [text, limit],
    }) as Promise<Array<SqlRow & { score: number }>>;
  }
  async function findArray(
    field: StringArrayField<T>,
    values: readonly string[],
    config: { mode?: "all" | "any"; limit?: number } = {},
  ): Promise<SqlRow[]> {
    if (!arrays.includes(field)) throw new Error(`No array index configured: ${field}`);
    if (!values.length) return [];
    const items = [...new Set(values)];
    const q = quote(`__ss_arr_${tableName}_${field}`);
    const placeholders = items.map(() => "?").join(", ");
    return adapter.all({
      sql: `SELECT b.id, b.data FROM ${source} AS b
      WHERE b.id IN (SELECT document_id FROM ${q} WHERE value IN (${placeholders})
        GROUP BY document_id HAVING COUNT(*) >= ?)
      ORDER BY b.id LIMIT ?`,
      params: [
        ...items,
        config.mode === "all" ? items.length : 1,
        Math.min(1000, Math.max(1, config.limit ?? 50)),
      ],
    });
  }
  async function arrayCounts(
    field: StringArrayField<T>,
  ): Promise<{ value: string; count: number }[]> {
    if (!arrays.includes(field)) throw new Error(`No array index configured: ${field}`);
    return adapter.all<{ value: string; count: number }>({
      sql: `SELECT value, COUNT(*) AS count FROM ${quote(`__ss_arr_${tableName}_${field}`)} GROUP BY value ORDER BY count DESC, value`,
    });
  }
  return { plan, apply, rebuild, search, findArray, arrayCounts };
}
