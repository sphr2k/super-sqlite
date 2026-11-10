import type { DocumentSchema } from "./schema-port.js";
import { ulid } from "ulid";
import type { SQLiteAdapter } from "./adapters/types.js";
import { readDocument, serializeDocument, type DocumentEvolution } from "./document.js";

const BATCH_SIZE = 100;
export class RevisionConflictError extends Error {
  constructor(id: string) {
    super(`Concurrent update conflict for document ${id}`);
    this.name = "RevisionConflictError";
  }
}
export class DocumentNotFoundError extends Error {
  constructor(id: string) {
    super(`Document not found: ${id}`);
    this.name = "DocumentNotFoundError";
  }
}

export function createDocumentMutations<T extends DocumentSchema<any, any>>(
  schema: T,
  tableName: string,
  adapter: SQLiteAdapter,
  evolution?: DocumentEvolution,
) {
  type DataInput = T["inferIn"];
  type DataType = T["infer"];
  type Persisted = DataType & { id: string };
  async function insert(values: DataInput): Promise<Persisted>;
  async function insert(values: DataInput[]): Promise<Persisted[]>;
  async function insert(values: DataInput | DataInput[]): Promise<Persisted | Persisted[]> {
    const arr = Array.isArray(values) ? values : [values];
    const stored = arr.map((value) => {
      const validated = schema.parseInput(value) as DataType; // Persist morph output.
      const suppliedId = (validated as { id?: unknown }).id;
      const id = typeof suppliedId === "string" && suppliedId.length > 0 ? suppliedId : ulid();
      return {
        id,
        data: serializeDocument(validated, 1, evolution?.version ?? 1),
        value: { ...validated, id } as Persisted,
      };
    });
    for (let i = 0; i < stored.length; i += BATCH_SIZE) {
      const chunk = stored.slice(i, i + BATCH_SIZE);
      await adapter.batch(
        chunk.map(({ id, data }) => ({
          sql: `INSERT INTO "${tableName}" (id, data) VALUES (?, ?)`,
          params: [id, data],
        })),
      );
    }
    const result = stored.map((v) => v.value);
    return Array.isArray(values) ? result : result[0];
  }

  async function remove(id: string, options: { expectedRevision?: number } = {}): Promise<void> {
    const predicates =
      options.expectedRevision === undefined
        ? { sql: `DELETE FROM "${tableName}" WHERE id = ? RETURNING id`, params: [id] }
        : {
            sql: `DELETE FROM "${tableName}" WHERE id = ? AND COALESCE(json_extract(data, '$._supersqlite.revision'), 1) = ? RETURNING id`,
            params: [id, options.expectedRevision],
          };
    const row = await adapter.get<{ id: string }>(predicates);
    if (row) return;
    const stillThere = await adapter.get<{ id: string }>({
      sql: `SELECT id FROM "${tableName}" WHERE id = ?`,
      params: [id],
    });
    if (stillThere) throw new RevisionConflictError(id);
    throw new DocumentNotFoundError(id);
  }

  return {
    insert,
    delete: remove,
    /**
     * Explicitly rewrite legacy documents to the current logical version.
     * Lazy read upcasting cannot make new document fields queryable by JSON1
     * until this method materializes them. Each write uses a revision CAS.
     */
    async upgradeDocuments(
      config: { batchSize?: number; dryRun?: boolean } = {},
    ): Promise<{ scanned: number; upgraded: number }> {
      const target = evolution?.version;
      if (target == null) throw new Error("Document evolution is not configured");
      const size = config.batchSize ?? 100;
      if (!Number.isSafeInteger(size) || size < 1 || size > 1000) {
        throw new RangeError("batchSize must be an integer from 1 to 1000");
      }
      let scanned = 0;
      let upgraded = 0;
      let lastId = "";
      while (true) {
        const rows = await adapter.all<{ id: string; data: string }>({
          sql: `SELECT id, data FROM "${tableName}" WHERE id > ? ORDER BY id LIMIT ?`,
          params: [lastId, size],
        });
        if (!rows.length) break;
        for (const row of rows) {
          scanned++;
          const result = readDocument(row.data, schema, evolution, row.id);
          if (result.version === target) continue;
          upgraded++;
          if (config.dryRun) continue;
          const data = serializeDocument(result.document, result.revision + 1, target);
          const updated = await adapter.get<{ id: string }>({
            sql: `UPDATE "${tableName}" SET data = ? WHERE id = ? AND COALESCE(json_extract(data, '$._supersqlite.revision'), 1) = ? RETURNING id`,
            params: [data, row.id, result.revision],
          });
          if (!updated) throw new RevisionConflictError(row.id);
        }
        lastId = rows[rows.length - 1].id;
        if (rows.length < size) break;
      }
      return { scanned, upgraded };
    },

    async findByIdWithRevision(
      id: string,
    ): Promise<{ value: Persisted; revision: number; version: number } | undefined> {
      const row = await adapter.get<{ id: string; data: string }>({
        sql: `SELECT id, data FROM "${tableName}" WHERE id = ?`,
        params: [id],
      });
      if (!row) return undefined;
      const { document, revision, version } = readDocument(row.data, schema, evolution, row.id);
      return { value: { ...document, id } as Persisted, revision, version };
    },

    async update(
      id: string,
      patch: Partial<Omit<DataInput, "id">>,
      updateOptions: { expectedRevision?: number } = {},
    ): Promise<{ value: Persisted; revision: number }> {
      const current = await adapter.get<{ id: string; data: string }>({
        sql: `SELECT id, data FROM "${tableName}" WHERE id = ?`,
        params: [id],
      });
      if (!current) throw new DocumentNotFoundError(id);
      const { document, revision } = readDocument(current.data, schema, evolution, id);
      if (
        updateOptions.expectedRevision !== undefined &&
        updateOptions.expectedRevision !== revision
      ) {
        throw new RevisionConflictError(id);
      }
      if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
        throw new TypeError("Patch must be a plain object");
      }
      const patchRecord = patch as Record<string, unknown>;
      if (Object.hasOwn(patchRecord, "id")) throw new Error("Document id cannot be modified");
      const entries = Object.entries(patchRecord).filter(([, value]) => value !== undefined);
      let transformed: Record<string, unknown> = {};
      if (entries.length) {
        transformed = schema.parsePatch(Object.fromEntries(entries)) as Record<string, unknown>;
      }
      const candidate: Record<string, unknown> = { ...document, ...transformed, id };
      for (const [key, value] of Object.entries(patchRecord)) {
        if (value === undefined) delete candidate[key];
      }
      const validated = schema.parseOutput(candidate);
      const next = revision + 1;
      const data = serializeDocument(validated, next, evolution?.version ?? 1);
      // One conditional statement, atomic on both backends, including D1.
      const updated = await adapter.get<{ data: string }>({
        sql: `UPDATE "${tableName}" SET data = ? WHERE id = ? AND COALESCE(json_extract(data, '$._supersqlite.revision'), 1) = ? RETURNING data`,
        params: [data, id, revision],
      });
      if (!updated) throw new RevisionConflictError(id);
      return { value: { ...validated, id } as Persisted, revision: next };
    },
  };
}
