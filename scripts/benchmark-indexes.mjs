/** Reproducible local SQLite microbenchmark. Not a Cloudflare latency claim. */
import { performance } from "node:perf_hooks";
import Database from "better-sqlite3";
import * as z from "zod";
import { documentTable, zodSchema } from "../dist/zod.js";
import { BetterSQLite3Adapter } from "../dist/node.js";

const total = Number(process.env.BENCH_DOCS ?? 3000);
const iterations = Number(process.env.BENCH_ITERS ?? 50);
if (
  !Number.isSafeInteger(total) ||
  total < 1 ||
  total > 100000 ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  iterations > 10000
)
  throw new RangeError("BENCH_DOCS and BENCH_ITERS must be safe positive integers within bounds");
const db = new Database(":memory:");
try {
  const Schema = z.strictObject({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
  });
  const records = documentTable(
    "Bookmark",
    zodSchema(Schema, {
      fields: {
        id: { kind: "string" },
        title: { kind: "string" },
        description: { kind: "string" },
        tags: { kind: "string-array" },
      },
    }),
    "bookmarks",
    new BetterSQLite3Adapter(db),
    [],
    {
      indexes: {
        fullText: { fields: ["title", "description"], weights: [3, 1] },
        arrays: ["tags"],
      },
    },
  );
  const t0 = performance.now();
  await records.initialize();
  for (let start = 0; start < total; start += 100) {
    const chunk = Array.from({ length: Math.min(100, total - start) }, (_, offset) => {
      const i = start + offset;
      return {
        id: `b-${i}`,
        title: i % 3 === 0 ? `Kubernetes guide ${i}` : `SQLite guide ${i}`,
        description: `Tracing and observability reference document ${i}`,
        tags: i % 5 === 0 ? ["k8s", "observability"] : ["sqlite", "bookmarks"],
      };
    });
    await records.insert(chunk);
  }
  const ingestMs = performance.now() - t0;
  const measure = async (fn) => {
    await fn(); // warmup
    const times = [];
    for (let i = 0; i < iterations; i++) {
      const t = performance.now();
      await fn();
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    return {
      medianMs: Number(times[Math.floor(times.length / 2)].toFixed(3)),
      p95Ms: Number(times[Math.floor(times.length * 0.95)].toFixed(3)),
    };
  };
  const fts = await measure(() => records.searchFullText("Kubernetes", { limit: 20 }));
  const tags = await measure(() => records.arrayCounts("tags"));
  const filter = await measure(() => records.findByArray("tags", ["k8s"], { limit: 20 }));
  const result = {
    environment: "local in-memory SQLite; Node; better-sqlite3; NOT Cloudflare",
    documents: total,
    iterations,
    sqliteVersion: db.prepare("select sqlite_version() as version").get().version,
    node: process.version,
    ingestMs: Number(ingestMs.toFixed(1)),
    fts,
    tags,
    filter,
  };
  console.log(JSON.stringify(result, null, 2));
} finally {
  db.close();
}
