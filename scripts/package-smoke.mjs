import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
const core = await import("../dist/index.js");
const node = await import("../dist/node.js");
const d1 = await import("../dist/cloudflare.js");
const portable = await import("../dist/core.js");
const zod = await import("../dist/zod.js");
const durable = await import("../dist/durable-object.js");
assert.equal(typeof core.arktypeJsonTable, "function");
assert.equal(typeof node.BetterSQLite3Adapter, "function");
assert.equal(typeof d1.D1Adapter, "function");
assert.equal(typeof portable.documentTable, "function");
assert.equal(typeof zod.zodSchema, "function");
assert.equal(typeof durable.DurableObjectAdapter, "function");
const build = spawnSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
assert.equal(build.status, 0, build.stderr);
const files = new Set(JSON.parse(build.stdout)[0].files.map((v) => v.path));
for (const path of [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/node.js",
  "dist/cloudflare.js",
  "dist/cli.js",
  "dist/core.js",
  "dist/core.d.ts",
  "dist/zod.js",
  "dist/zod.d.ts",
  "dist/durable-object.js",
  "dist/durable-object.d.ts",
]) {
  assert.ok(files.has(path), `Missing package file: ${path}`);
}
const fs = await import("node:fs");
const source = ["index.js", "factory.js", "fields.js", "query.js", "cloudflare.js", "mutations.js"]
  .map((name) => fs.readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8"))
  .join("\n");
assert.ok(!source.includes("better-sqlite3"), "Core/D1 entrypoints must not import native driver");
const neutral = [
  "core.js",
  "factory-core.js",
  "document.js",
  "fields.js",
  "projections.js",
  "mutations.js",
  "durable-object.js",
];
for (const name of neutral) {
  const contents = fs.readFileSync(new URL(`../dist/${name}`, import.meta.url), "utf8");
  assert.ok(
    !/from ['"](?:arktype|zod|better-sqlite3)['"]/.test(contents),
    `Unexpected vendor/native import in ${name}`,
  );
}
const zodEntry = fs.readFileSync(new URL("../dist/zod.js", import.meta.url), "utf8");
assert.ok(!/from ['"]arktype['"]/.test(zodEntry), "Zod entrypoint imports ArkType");
console.log("Package exports, declarations, CLI and schema/native isolation: OK");
