import { describe, expect, it } from "vite-plus/test";
import Database from "better-sqlite3";
import { Miniflare } from "miniflare";
import * as z from "zod";
import { type } from "arktype";
import { zodSchema } from "./schema.js";
import { documentTable, arktypeJsonTable } from "./factory.js";
import { BetterSQLite3Adapter } from "./adapters/better-sqlite3.js";
import { D1Adapter } from "./adapters/d1.js";
import type { SQLiteAdapter } from "./adapters/types.js";

const Bookmark = z.strictObject({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  tags: z.array(z.string()).default([]),
});
const create = (db: SQLiteAdapter) =>
  documentTable(
    "Bookmark",
    zodSchema(Bookmark, {
      fields: {
        id: { kind: "string" },
        title: { kind: "string" },
        description: { kind: "string" },
        tags: { kind: "string-array" },
      },
    }),
    "bookmarks",
    db,
    ["title"],
    {
      indexes: {
        fullText: { fields: ["title", "description"], weights: [3, 1] },
        arrays: ["tags"],
      },
    },
  );
async function exercise(adapter: SQLiteAdapter) {
  const plain = arktypeJsonTable(
    "Bookmark",
    type({ id: "string", title: "string", description: "string", tags: "string[]" }),
    "bookmarks",
    adapter,
  );
  await plain.initialize();
  await plain.insert({
    id: "legacy",
    title: "Kubernetes notes",
    description: "Cluster deployment",
    tags: ["k8s", "devops"],
  });
  const repo = create(adapter);
  expect((await repo.planDerivedIndexes()).map((i) => i.status)).toEqual(["create", "create"]);
  await repo.initialize();
  expect((await repo.planDerivedIndexes()).every((i) => i.status === "current")).toBe(true);
  expect((await repo.searchFullText("kubernetes")).map((b) => b.id)).toEqual(["legacy"]);
  expect((await repo.findByArray("tags", ["k8s"])).map((b) => b.id)).toEqual(["legacy"]);
  await repo.insert({
    id: "new",
    title: "Observability",
    description: "OpenTelemetry trace",
    tags: ["devops", "otel"],
  });
  expect((await repo.searchFullText("OpenTelemetry")).map((b) => b.id)).toEqual(["new"]);
  expect(
    (await repo.findByArray("tags", ["devops", "k8s"], { mode: "all" })).map((b) => b.id),
  ).toEqual(["legacy"]);
  expect((await repo.arrayCounts("tags")).find((x) => x.value === "devops")?.count).toBe(2);
  await repo.update(
    "legacy",
    { tags: ["kubernetes", "otel"], title: "K8s best practices" },
    { expectedRevision: 1 },
  );
  expect(await repo.findByArray("tags", ["k8s"])).toEqual([]);
  expect((await repo.searchFullText("kubernetes")).map((b) => b.id)).toEqual([]);
  expect((await repo.searchFullText("practices")).map((b) => b.id)).toEqual(["legacy"]);
  await expect(repo.delete("legacy", { expectedRevision: 1 })).rejects.toThrow(/conflict/);
  await repo.delete("legacy", { expectedRevision: 2 });
  expect(await repo.arrayCounts("tags")).toEqual([
    { value: "devops", count: 1 },
    { value: "otel", count: 1 },
  ]);
  expect(await repo.searchFullText("practices")).toEqual([]);
  await repo.rebuildDerivedIndexes();
  expect((await repo.searchFullText("OpenTelemetry")).map((b) => b.id)).toEqual(["new"]);
  await repo.initialize(); // idempotence
  expect((await repo.searchFullText("OpenTelemetry")).map((b) => b.id)).toEqual(["new"]);
}

describe("derived indexes / schema providers", () => {
  it("supports Zod 4, FTS5, relation backfill, CAS updates and deletes on native SQLite", async () => {
    const db = new Database(":memory:");
    try {
      await exercise(new BetterSQLite3Adapter(db));
    } finally {
      db.close();
    }
  });
  it("supports same index semantics on actual D1/workerd", async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: { DB: "derived-index-real" },
    });
    try {
      await exercise(new D1Adapter(await mf.getD1Database("DB")));
    } finally {
      await mf.dispose();
    }
  }, 25_000);
});
