import { describe, expect, it } from "vite-plus/test";
import { Miniflare } from "miniflare";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

describe("SQLite-backed DO full application / real workerd", () => {
  it("runs bundled SuperSQLite + Zod with FTS5, array triggers, CAS and rollback", async () => {
    const dir = mkdtempSync(join(tmpdir(), "supersqlite-workerd-"));
    let mf: Miniflare | undefined;
    try {
      const bundle = join(dir, "do.mjs");
      execFileSync(
        "bun",
        [
          "build",
          "src/fixtures/do.worker.ts",
          "--target=browser",
          "--format=esm",
          "--outfile",
          bundle,
        ],
        {
          cwd: process.cwd(),
          stdio: "pipe",
        },
      );
      mf = new Miniflare({
        modules: true,
        script: readFileSync(bundle, "utf8"),
        compatibilityDate: "2026-08-06",
        durableObjects: { STORE: { className: "Store", useSQLite: true } },
      });
      const invoke = async (path: string, body?: unknown) => {
        const result = await mf!.dispatchFetch(
          "http://worker.test" + path,
          body === undefined
            ? {}
            : {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              },
        );
        return { status: result.status, json: (await result.json()) as any };
      };
      expect(
        (await invoke("/bookmarks", { id: "a", title: "Durable SQLite", tags: ["cloudflare"] }))
          .status,
      ).toBe(200);
      expect((await invoke("/search?q=Durable")).json.map((r: any) => r.id)).toEqual(["a"]);
      expect((await invoke("/tags")).json).toEqual([{ value: "cloudflare", count: 1 }]);
      expect(
        (await invoke("/update", { id: "a", title: "Workers API", tags: ["typescript"] })).status,
      ).toBe(200);
      expect((await invoke("/search?q=Durable")).json).toEqual([]);
      expect((await invoke("/tags")).json).toEqual([{ value: "typescript", count: 1 }]);
      const rollback = await invoke("/rollback", {});
      expect(rollback.status).toBe(500);
      expect((await invoke("/search?q=Workers")).json.map((r: any) => r.id)).toEqual(["a"]);
      expect((await invoke("/delete", { id: "a" })).status).toBe(200);
      expect((await invoke("/tags")).json).toEqual([]);
      expect((await invoke("/index/plan")).json.every((r: any) => r.status === "current")).toBe(
        true,
      );
      expect((await invoke("/index/drop-trigger", {})).status).toBe(200);
      expect((await invoke("/index/plan")).json[0].status).toBe("missing");
      expect((await invoke("/index/repair", {})).status).toBe(200);
      expect((await invoke("/index/plan")).json[0].status).toBe("current");
      expect((await invoke("/snapshots/seed", {})).status).toBe(200);
      const first = await invoke("/snapshots/page");
      expect(first.json.documents).toEqual([{ id: "a", count: 5 }]);
      expect(first.json.nextCursor).toBeTruthy();
      const second = await invoke(
        "/snapshots/page?cursor=" + encodeURIComponent(first.json.nextCursor),
      );
      expect(second.json.documents).toEqual([{ id: "b", count: 7 }]);
    } finally {
      await mf?.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
