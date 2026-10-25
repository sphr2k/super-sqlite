/** Run after npm run build. Local SQLite microbenchmark, not D1 network data. */
import Database from 'better-sqlite3';
import { type } from 'arktype';
import { performance } from 'node:perf_hooks';
import { BetterSQLite3Adapter } from '../dist/node.js';
import { arktypeJsonTable } from '../dist/index.js';

const sqlite = new Database(':memory:');
try {
  const repo = arktypeJsonTable('Document', type({ id: 'string', region: 'string', payload: 'string' }),
    'documents', new BetterSQLite3Adapter(sqlite), ['region']);
  await repo.initialize();
  const records = Array.from({ length: 2000 }, (_, i) => ({
    id: `r${i}`, region: i % 2 ? 'eu' : 'us', payload: 'x'.repeat(4096)
  }));
  await repo.insert(records);
  const scalar = sqlite.prepare(`SELECT id, json_extract(data, '$.json.region') AS region
    FROM documents WHERE json_extract(data, '$.json.region') = ?`);
  const full = sqlite.prepare(`SELECT id, data FROM documents WHERE json_extract(data, '$.json.region') = ?`);
  const hydrated = async () => repo.select({ region: true }).where({ region: 'eu' }).all();
  const scalarQuery = () => scalar.all('eu');
  const scalarRepo = async () => repo.selectScalar({ region: true }).where({ region: 'eu' }).all();
  for (let i = 0; i < 5; i++) { await hydrated(); await scalarRepo(); scalarQuery(); }
  const n = 15;
  const results = { hydrated: [], scalar: [], scalarRepo: [] };
  for (let i = 0; i < n; i++) {
    // Alternate order to reduce systematic measurement bias.
    for (const which of (i % 2 ? ['scalarRepo', 'scalar', 'hydrated'] : ['hydrated', 'scalar', 'scalarRepo'])) {
      const t0 = performance.now();
      const rows = which === 'scalar' ? scalarQuery() : which === 'scalarRepo' ? await scalarRepo() : await hydrated();
      results[which].push(performance.now() - t0);
      if (rows.length !== 1000) throw new Error('Benchmark returned unexpected result count');
    }
  }
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const fullBytes = Buffer.byteLength(JSON.stringify(full.all('eu')));
  const scalarBytes = Buffer.byteLength(JSON.stringify(scalarQuery()));
  console.log(JSON.stringify({
    workload: { documents: 2000, matched: 1000, payloadBytes: 4096, rounds: n },
    hydratedMsMedian: +median(results.hydrated).toFixed(2),
    scalarMsMedian: +median(results.scalar).toFixed(2),
    scalarRepoMsMedian: +median(results.scalarRepo).toFixed(2),
    hydratedSqlBytes: fullBytes,
    scalarSqlBytes: scalarBytes,
    note: 'Scalar-only query does not validate full documents; timings local in-memory SQLite, not D1'
  }, null, 2));
} finally { sqlite.close(); }
