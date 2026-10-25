#!/usr/bin/env node
import { createReadStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { generateArkTypeSource, inferJsonShape } from './infer.js';

export async function inferCli(argv: string[]): Promise<string> {
  if (argv[0] === 'infer') argv = argv.slice(1);
  function option(flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index < 0 ? undefined : argv[index + 1];
  }
  const input = option('--input') ?? option('-i');
  const output = option('--out') ?? option('-o');
  const name = option('--name') ?? 'InferredModel';
  const path = option('--path');
  const limit = Number(option('--sample') ?? '1000');
  if (!input || !output || !Number.isSafeInteger(limit) || limit < 0) {
    throw new Error('Usage: super-sqlite infer --input data.json --out model.ts [--name Instance] [--path records] [--sample 1000|0]');
  }
  let records: unknown[];
  if (input.endsWith('.ndjson') && input !== '-') {
    records = [];
    const lines = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      records.push(JSON.parse(line));
      if (limit && records.length >= limit) break;
    }
    lines.close();
  } else {
    let json: unknown = JSON.parse(readFileSync(input === '-' ? 0 : input, 'utf8'));
    if (path) for (const field of path.split('.')) json = (json as Record<string, unknown>)?.[field];
    if (!Array.isArray(json) && (!json || typeof json !== 'object')) throw new Error('Expected JSON object or array (use --path for envelopes)');
    records = Array.isArray(json) ? json.slice(0, limit || undefined) : [json];
  }
  const source = generateArkTypeSource(name, inferJsonShape(records));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, source);
  return resolve(output);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  inferCli(process.argv.slice(2))
    .then(output => console.log(`Generated ${output}`))
    .catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
