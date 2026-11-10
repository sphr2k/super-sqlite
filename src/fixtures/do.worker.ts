/// <reference types="@cloudflare/workers-types" />
import * as z from "zod";
import { zodSchema } from "../schema-zod.js";
import { documentTable } from "../factory-core.js";
import { DurableObjectAdapter } from "../adapters/durable-object.js";
import { createDocumentSnapshotStore } from "../snapshot-core.js";

const schema = z.strictObject({ id: z.string(), title: z.string(), tags: z.array(z.string()) });
type Env = { STORE: DurableObjectNamespace };
export class Store {
  private repo;
  private snapshots;
  private adapter: DurableObjectAdapter;
  private ready: Promise<void>;
  constructor(ctx: DurableObjectState) {
    const adapter = new DurableObjectAdapter(ctx.storage);
    this.adapter = adapter;
    this.repo = documentTable(
      "Bookmark",
      zodSchema(schema, {
        fields: {
          id: { kind: "string" },
          title: { kind: "string" },
          tags: { kind: "string-array" },
        },
      }),
      "bookmarks",
      adapter,
      [],
      { indexes: { fullText: { fields: ["title"] }, arrays: ["tags"] } },
    );
    this.snapshots = createDocumentSnapshotStore(
      "snapshots",
      zodSchema(z.strictObject({ id: z.string(), count: z.number() }), {
        fields: { id: { kind: "string" }, count: { kind: "number" } },
      }),
      adapter,
    );
    this.ready = ctx.blockConcurrencyWhile(async () => {
      await this.repo.initialize();
      await this.snapshots.initialize();
    });
  }
  async fetch(request: Request) {
    try {
      await this.ready;
      const url = new URL(request.url);
      if (request.method === "POST" && url.pathname === "/bookmarks") {
        const input = await request.json();
        return Response.json(await this.repo.insert(input as z.input<typeof schema>));
      }
      if (request.method === "POST" && url.pathname === "/update") {
        const input = (await request.json()) as { id: string; title: string; tags: string[] };
        return Response.json(
          await this.repo.update(input.id, { title: input.title, tags: input.tags }),
        );
      }
      if (request.method === "POST" && url.pathname === "/delete") {
        await this.repo.delete(((await request.json()) as { id: string }).id);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/search")
        return Response.json(await this.repo.searchFullText(url.searchParams.get("q") ?? ""));
      if (url.pathname === "/tags") return Response.json(await this.repo.arrayCounts("tags"));
      if (url.pathname === "/index/plan")
        return Response.json(await this.repo.planDerivedIndexes());
      if (url.pathname === "/index/drop-trigger") {
        await this.adapter.run({ sql: 'DROP TRIGGER "__ss_bookmarks_fts_update"' });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/index/repair") {
        await this.repo.applyDerivedIndexes({ allowRepair: true });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/snapshots/seed") {
        const begun = await this.snapshots.begin("do", "digest-one", 2);
        if (begun.status !== "upload") throw new Error("Expected snapshot upload");
        await this.snapshots.append(begun.batchId, 0, [
          { id: "a", count: 5 },
          { id: "b", count: 7 },
        ]);
        await this.snapshots.publish(begun.batchId);
        return Response.json({ batchId: begun.batchId });
      }
      if (url.pathname === "/snapshots/page")
        return Response.json(
          await this.snapshots.readActivePage("do", {
            limit: 1,
            cursor: url.searchParams.get("cursor") ?? undefined,
          }),
        );
      if (url.pathname === "/rollback") {
        const a = this.adapter;
        await a.batch([
          { sql: "INSERT INTO bookmarks (id,data) VALUES ('err','{}')" },
          { sql: "INSERT INTO bookmarks (id,data) VALUES ('err','{}')" },
        ]);
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      return Response.json({ error: String(error) }, { status: 500 });
    }
  }
}
export default {
  fetch(request: Request, env: Env) {
    return env.STORE.get(env.STORE.idFromName("single")).fetch(request);
  },
};
