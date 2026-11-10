import { describe, it, expect } from "vite-plus/test";
import Database from "better-sqlite3";
import * as z from "zod";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { standardSchema } from "./schema-standard.js";
import { zodSchema } from "./schema-zod.js";
import { documentTable } from "./factory-core.js";
import { createDocumentSnapshotStore } from "./snapshot-core.js";
import { BetterSQLite3Adapter } from "./adapters/better-sqlite3.js";
import type { SQLiteAdapter } from "./adapters/types.js";

const Output = z.strictObject({ id: z.string(), count: z.number(), label: z.string() });
const Input = z.strictObject({
  id: z.string(),
  count: z
    .string()
    .regex(/^\d+$/)
    .transform((s) => Number(s)),
  label: z.string().default("untitled"),
});
const Patch = z
  .strictObject({
    count: z
      .string()
      .regex(/^\d+$/)
      .transform((s) => Number(s)),
    label: z.string(),
  })
  .partial();
const fields = {
  id: { kind: "string" },
  count: { kind: "number" },
  label: { kind: "string" },
} as const;

type In = { id: string; count: string; label?: string };
type Out = { id: string; count: number; label: string };
const stdInput: StandardSchemaV1<In, Out> = {
  "~standard": {
    version: 1,
    vendor: "custom-unit",
    validate(v: unknown) {
      const input = v as Partial<In>;
      if (
        !input ||
        typeof input.id !== "string" ||
        typeof input.count !== "string" ||
        !/^\d+$/.test(input.count)
      )
        return { issues: [{ message: "Invalid custom input", path: ["count"] }] };
      return {
        value: { id: input.id, count: Number(input.count), label: input.label ?? "untitled" },
      };
    },
  },
};
const stdOutput: StandardSchemaV1<unknown, Out> = {
  "~standard": {
    version: 1,
    vendor: "custom-unit-output",
    validate(v: unknown) {
      const o = v as Partial<Out>;
      if (
        !o ||
        typeof o.id !== "string" ||
        typeof o.count !== "number" ||
        typeof o.label !== "string"
      )
        return { issues: [{ message: "Invalid persisted output" }] };
      return { value: { id: o.id, count: o.count, label: o.label } };
    },
  },
};
const stdPatch: StandardSchemaV1<unknown, Partial<Out>> = {
  "~standard": {
    version: 1,
    vendor: "custom-unit-patch",
    validate(v: unknown) {
      const p = v as { count?: string };
      if (typeof p.count !== "string" || !/^\d+$/.test(p.count))
        return { issues: [{ message: "Invalid count patch" }] };
      return { value: { count: Number(p.count) } };
    },
  },
};

describe("validator-neutral schema providers", () => {
  function setup() {
    const sqlite = new Database(":memory:");
    const adapter = new BetterSQLite3Adapter(sqlite);
    return { sqlite, adapter };
  }
  it("accepts independent Standard Schema v1 implementations without Zod/ArkType", async () => {
    const { sqlite, adapter } = setup();
    try {
      const doc = documentTable(
        "Unit",
        standardSchema(stdInput, {
          outputSchema: stdOutput,
          patchSchema: stdPatch,
          fields,
        }),
        "units",
        adapter,
        ["count"],
      );
      await doc.initialize();
      const inserted = await doc.insert({ id: "s", count: "12" });
      const compiled: number = inserted.count;
      expect(compiled).toBe(12);
      expect((await doc.findById("s"))?.count).toBe(12);
      expect((await doc.update("s", { count: "19" }, { expectedRevision: 1 })).value.count).toBe(
        19,
      );
      expect((await doc.selectScalar({ count: true }).get())?.count).toBe(19);
      await expect(doc.update("s", { count: "twenty" })).rejects.toThrow(/Invalid count patch/);
      await expect(doc.update("s", { extra: 4 } as never)).rejects.toThrow(/Unknown/);
      const broken = { id: "s", count: "19", label: "untitled" };
      sqlite
        .prepare("UPDATE units SET data = ? WHERE id = ?")
        .run(JSON.stringify({ json: broken }), "s");
      await expect(doc.findById("s")).rejects.toThrow(/Invalid document/);
    } finally {
      sqlite.close();
    }
  });
  it("rejects async Standard Schema validators and output mutation", () => {
    const asyncInput: StandardSchemaV1<unknown, Out> = {
      "~standard": {
        version: 1,
        vendor: "async",
        validate: async () => ({ value: { id: "x", count: 1, label: "x" } }),
      },
    };
    const schema = standardSchema(asyncInput, { fields });
    expect(() => schema.parseInput({})).toThrow(/synchronous/);
    const invalidOutput: StandardSchemaV1<unknown, Out> = {
      "~standard": {
        version: 1,
        vendor: "mutating",
        validate: (v) => ({ value: { ...(v as Out), label: "changed" } }),
      },
    };
    const wrapper = standardSchema(stdInput, { fields, outputSchema: invalidOutput });
    expect(() => wrapper.parseOutput({ id: "x", count: 1, label: "original" })).toThrow(
      /modified data/,
    );
  });
  it("validates Zod 4 transforms, defaults, strict patches and scalar projections", async () => {
    const { sqlite, adapter } = setup();
    try {
      const repo = documentTable(
        "Unit",
        zodSchema(Input, {
          outputSchema: Output,
          patchSchema: Patch,
          fields,
        }),
        "units",
        adapter,
        ["count"],
      );
      await repo.initialize();
      expect(await repo.insert({ id: "a", count: "42" })).toEqual({
        id: "a",
        count: 42,
        label: "untitled",
      });
      expect((await repo.findById("a"))?.count).toBe(42);
      expect((await repo.update("a", { count: "43" })).value.count).toBe(43);
      expect(await repo.selectScalar({ count: true }).all()).toEqual([{ id: "a", count: 43 }]);
      await expect(repo.update("a", { unknown: true } as never)).rejects.toThrow(/Unknown/);
      await expect(repo.update("a", { count: "NaN" })).rejects.toThrow();
      const missing = { json: { id: "a", count: 43 } };
      sqlite.prepare("UPDATE units SET data = ? WHERE id = ?").run(JSON.stringify(missing), "a");
      await expect(repo.findById("a")).rejects.toThrow(/Invalid document/);
      const zinputOnly = zodSchema(Input, { fields });
      const unworkable = documentTable("Unit", zinputOnly, "newunits", adapter);
      await unworkable.initialize();
      await expect(unworkable.insert({ id: "bad", count: "8" })).rejects.toThrow();
      expect(await unworkable.getAll()).toEqual([]);
      const coerced = zodSchema(Input, { outputSchema: Output, fields });
      expect(() => coerced.parsePatch({ count: "10" })).toThrow(/Patch validator added/);
    } finally {
      sqlite.close();
    }
  });
  it("supports a top-level Zod pipeline with explicit stored-output and patch schemas", async () => {
    const { sqlite, adapter } = setup();
    try {
      const transformed = z
        .strictObject({ id: z.string(), count: z.string(), label: z.string() })
        .transform((row) => ({ ...row, count: Number(row.count) }));
      const typed = zodSchema(transformed, { outputSchema: Output, patchSchema: Patch, fields });
      const table = documentTable("Pipeline", typed, "pipelines", adapter, ["count"]);
      await table.initialize();
      expect((await table.insert({ id: "p", count: "15", label: "pipeline" })).count).toBe(15);
      expect((await table.findById("p"))?.count).toBe(15);
      expect((await table.update("p", { count: "25" })).value.count).toBe(25);
      expect((await table.selectScalar({ count: true }).get())?.count).toBe(25);
      expect(() => zodSchema(transformed, { fields })).toThrow(/outputSchema/);
      const noPatch = zodSchema(transformed, { outputSchema: Output, fields });
      expect(() => noPatch.parsePatch({ count: "26" })).toThrow(/patchSchema/);
    } finally {
      sqlite.close();
    }
  });
  it("persists snapshot transform outputs using a validator-neutral snapshot store", async () => {
    const { sqlite, adapter } = setup();
    try {
      await exerciseSnapshot(adapter);
    } finally {
      sqlite.close();
    }
  });
});

export async function exerciseSnapshot(adapter: SQLiteAdapter) {
  const schema = zodSchema(Input, { outputSchema: Output, patchSchema: Patch, fields });
  const store = createDocumentSnapshotStore("snaptest", schema, adapter);
  await store.initialize();
  const begun = await store.begin("unit", "digest-snap-1", 2);
  if (begun.status !== "upload") throw new Error("expected import");
  await store.append(begun.batchId, 0, [
    { id: "a", count: "12" },
    { id: "b", count: "15", label: "fifteen" },
  ]);
  expect(await store.countBatch(begun.batchId)).toBe(2);
  expect(await store.publish(begun.batchId)).toMatchObject({ status: "committed" });
  const page = await store.readActivePage("unit", { limit: 1 });
  expect(page.documents[0]).toEqual({ id: "a", count: 12, label: "untitled" });
  expect(page.nextCursor).toBeTruthy();
  expect(
    (await store.readActivePage("unit", { limit: 1, cursor: page.nextCursor! })).documents[0]
      ?.count,
  ).toBe(15);
  await expect(store.prune(begun.batchId)).rejects.toThrow(/active/);
}
