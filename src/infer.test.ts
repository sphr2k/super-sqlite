import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateArkTypeSource, inferJsonShape } from './infer.js';
import { inferCli } from './cli.js';

describe('ArkType model inference', () => {
  it('infers optional keys, nested records, primitive unions and object arrays', () => {
    const data = [
      { id: 'a', vcpu: 2, active: true, metadata: { region: 'eu', zone: 1 }, tags: [{ key: 'x' }] },
      { id: 'b', vcpu: null, metadata: { region: 'us' }, tags: [{ key: 'y', value: 5 }] }
    ];
    const source = generateArkTypeSource('Instance', inferJsonShape(data));
    expect(source).toContain('export const Instance = type(');
    expect(source).toContain('"active?": "boolean"');
    expect(source).toContain('"vcpu": "null | number"');
    expect(source).toContain('"zone?": "number"');
    expect(source).toContain('"value?": "number"');
    expect(source).toContain('type({');
    expect(() => generateArkTypeSource('bad-name', inferJsonShape(data))).toThrow();
  });

  it('generates a file from an enveloped JSON dataset', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supersqlite-infer-'));
    try {
      const input = join(dir, 'instances.json');
      const out = join(dir, 'models', 'instance.ts');
      writeFileSync(input, JSON.stringify({ result: [{ id: 'x', price: 2.5 }, { id: 'y', price: 3.5 }] }));
      expect(await inferCli(['infer', '--input', input, '--out', out, '--name', 'Instance', '--path', 'result'])).toBe(out);
      expect(readFileSync(out, 'utf8')).toContain('"price": "number"');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('samples newline-delimited JSON without materializing the entire file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supersqlite-ndjson-'));
    try {
      const input = join(dir, 'input.ndjson');
      const output = join(dir, 'out.ts');
      writeFileSync(input, '{"id":"1"}\n{"id":"2","optional":true}\n{"id":"3","late":false}\n');
      await inferCli(['--input', input, '--out', output, '--sample', '2']);
      const code = readFileSync(output, 'utf8');
      expect(code).toContain('"optional?": "boolean"');
      expect(code).not.toContain('"late');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
