import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
const core = await import('../dist/index.js');
const node = await import('../dist/node.js');
const d1 = await import('../dist/cloudflare.js');
assert.equal(typeof core.arktypeJsonTable, 'function');
assert.equal(typeof node.BetterSQLite3Adapter, 'function');
assert.equal(typeof d1.D1Adapter, 'function');
const build = spawnSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' });
assert.equal(build.status, 0, build.stderr);
const files = new Set(JSON.parse(build.stdout)[0].files.map(v => v.path));
for (const path of ['dist/index.js', 'dist/index.d.ts', 'dist/node.js', 'dist/cloudflare.js', 'dist/cli.js']) {
  assert.ok(files.has(path), `Missing package file: ${path}`);
}
const fs = await import('node:fs');
const source = ['index.js', 'factory.js', 'fields.js', 'query.js', 'cloudflare.js', 'mutations.js']
  .map(name => fs.readFileSync(new URL(`../dist/${name}`, import.meta.url), 'utf8')).join('\n');
assert.ok(!source.includes('better-sqlite3'), 'Core/D1 entrypoints must not import native driver');
console.log('Package exports, declaration files, CLI and D1 isolation: OK');
