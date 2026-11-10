import { describe, it, expect } from "vite-plus/test";
import { Miniflare } from "miniflare";
import Database from "better-sqlite3";
import * as z from "zod";
import type { SQLiteAdapter } from "./adapters/types.js";
import { BetterSQLite3Adapter } from "./adapters/better-sqlite3.js";
import { D1Adapter } from "./adapters/d1.js";
import { documentTable } from "./factory-core.js";
import { zodSchema } from "./schema-zod.js";
import { createDocumentSnapshotStore } from "./snapshot-core.js";

const Schema = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
});
const metadata = {
  id: { kind: "string" },
  title: { kind: "string" },
  description: { kind: "string" },
  tags: { kind: "string-array" },
} as const;
function repo(adapter: SQLiteAdapter, tokenizer: "unicode61" | "porter" = "unicode61") {
  return documentTable("Page", zodSchema(Schema, { fields: metadata }), "pages", adapter, [], {
    indexes: { fullText: { fields: ["title", "description"], tokenizer }, arrays: ["tags"] },
  });
}
async function exercise(adapter: SQLiteAdapter) {
  const raw = documentTable("Page", zodSchema(Schema, { fields: metadata }), "pages", adapter);
  await raw.initialize();
  await raw.insert({
    id: "pre",
    title: "Kubernetes Grüße",
    description: "Cluster tracing",
    tags: ["k8s", "k8s", "ops"],
  });
  const managed = repo(adapter);
  expect((await managed.planDerivedIndexes()).map((x) => x.status)).toEqual(["create", "create"]);
  await managed.initialize();
  expect((await managed.planDerivedIndexes()).map((x) => x.status)).toEqual(["current", "current"]);
  expect((await managed.searchFullText("Kubernetes")).map((x) => x.id)).toEqual(["pre"]);
  expect((await managed.searchFullText("Grüße")).map((x) => x.id)).toEqual(["pre"]);
  expect(await managed.arrayCounts("tags")).toEqual([
    { value: "k8s", count: 1 },
    { value: "ops", count: 1 },
  ]);
  expect(
    (await managed.findByArray("tags", ["ops", "k8s"], { mode: "all" })).map((x) => x.id),
  ).toEqual(["pre"]);
  await adapter.run({ sql: 'DROP TRIGGER "__ss_pages_fts_update"' });
  expect((await managed.planDerivedIndexes())[0]).toMatchObject({ status: "missing" });
  await expect(managed.applyDerivedIndexes()).rejects.toThrow(/integrity/);
  await expect(managed.rebuildDerivedIndexes()).rejects.toThrow(/Cannot rebuild damaged/);
  expect((await managed.planDerivedIndexes())[1].status).toBe("current");
  await managed.applyDerivedIndexes({ allowRepair: true });
  await managed.update("pre", { title: "Observability Guides", tags: ["otel", "ops"] });
  expect((await managed.searchFullText("Observability")).map((x) => x.id)).toEqual(["pre"]);
  expect((await managed.searchFullText("Kubernetes")).map((x) => x.id)).toEqual([]);
  expect((await managed.planDerivedIndexes())[0].status).toBe("current");
  // Altered trigger SQL with the original trigger name is not a valid managed index.
  await adapter.run({ sql: 'DROP TRIGGER "__ss_pages_fts_insert"' });
  await adapter.run({
    sql: `CREATE TRIGGER "__ss_pages_fts_insert" AFTER INSERT ON "pages" BEGIN SELECT 1; END`,
  });
  expect((await managed.planDerivedIndexes())[0].status).toBe("drift");
  await expect(managed.applyDerivedIndexes()).rejects.toThrow(/integrity/);
  await managed.applyDerivedIndexes({ allowRepair: true });
  expect((await managed.planDerivedIndexes())[0].status).toBe("current");
  // Explicit schema changes must be opt-in and atomic.
  const porter = repo(adapter, "porter");
  expect((await porter.planDerivedIndexes())[0].status).toBe("changed");
  await expect(porter.applyDerivedIndexes()).rejects.toThrow(/definition changed/);
  await porter.applyDerivedIndexes({ allowDefinitionChange: true });
  expect((await porter.searchFullText("Observability")).map((x) => x.id)).toEqual(["pre"]);
  expect((await porter.planDerivedIndexes())[0].status).toBe("current");
  await adapter.run({ sql: 'DROP TRIGGER "__ss_pages_tags_delete"' });
  expect((await porter.planDerivedIndexes())[1].status).toBe("missing");
  await porter.applyDerivedIndexes({ allowRepair: true });
  await porter.delete("pre");
  expect(await porter.arrayCounts("tags")).toEqual([]);
  expect(await porter.searchFullText("Observability")).toEqual([]);
  // A lookalike table without metadata must never be automatically overwritten.
  await adapter.run({
    sql: 'DELETE FROM "__supersqlite_derived_indexes" WHERE index_name = ?',
    params: ["__ss_arr_pages_tags"],
  });
  expect((await porter.planDerivedIndexes())[1].status).toBe("drift");
  await expect(porter.applyDerivedIndexes({ allowRepair: true })).rejects.toThrow(/collision/);
}
async function exerciseFailedBootstrap(adapter: SQLiteAdapter) {
  const raw = documentTable(
    "Page",
    zodSchema(Schema, { fields: metadata }),
    "unsafe_pages",
    adapter,
  );
  await raw.initialize();
  await adapter.run({
    sql: `INSERT INTO unsafe_pages (id,data) VALUES ('corrupt','this is not json')`,
  });
  const idx = documentTable(
    "Page",
    zodSchema(Schema, { fields: metadata }),
    "unsafe_pages",
    adapter,
    [],
    {
      indexes: { fullText: { fields: ["title"] }, arrays: ["tags"] },
    },
  );
  await expect(idx.initialize()).rejects.toThrow();
  expect((await idx.planDerivedIndexes()).map((i) => i.status)).toEqual(["create", "create"]);
  const remain = await adapter.get<{ sql: string }>({
    sql: "SELECT sql FROM sqlite_master WHERE name = '__ss_fts_unsafe_pages'",
  });
  expect(remain).toBeUndefined();
  await adapter.run({ sql: "DELETE FROM unsafe_pages WHERE id = 'corrupt'" });
  await idx.initialize();
  await idx.insert({ id: "corrected", title: "Recovery", description: "", tags: ["ops"] });
  expect((await idx.searchFullText("Recovery")).map((r) => r.id)).toEqual(["corrected"]);
  expect(await idx.arrayCounts("tags")).toEqual([{ value: "ops", count: 1 }]);
}
describe("derived-index lifecycle conformance", () => {
  it("detects missing triggers and requires explicit repair / schema replacement on native SQLite", async () => {
    const db = new Database(":memory:");
    try {
      await exercise(new BetterSQLite3Adapter(db));
      await exerciseFailedBootstrap(new BetterSQLite3Adapter(db));
    } finally {
      db.close();
    }
  });
  it("enforces the same rules on actual D1/workerd and snapshots with Zod", async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { DB: "lifecycle-d1" },
    });
    try {
      const db = new D1Adapter(await mf.getD1Database("DB"));
      await exercise(db);
      await exerciseFailedBootstrap(db);
      const snapshots = createDocumentSnapshotStore(
        "lifecycleSnap",
        zodSchema(z.strictObject({ id: z.string(), title: z.string() }), {
          fields: { id: { kind: "string" }, title: { kind: "string" } },
        }),
        db,
      );
      await snapshots.initialize();
      const batch = await snapshots.begin("links", "sha-test", 1);
      if (batch.status !== "upload") throw new Error("unexpected batch result");
      await snapshots.append(batch.batchId, 0, [{ id: "x", title: "D1" }]);
      await snapshots.publish(batch.batchId);
      expect((await snapshots.readActivePage("links")).documents).toEqual([
        { id: "x", title: "D1" },
      ]);
    } finally {
      await mf.dispose();
    }
  }, 30_000);
});
