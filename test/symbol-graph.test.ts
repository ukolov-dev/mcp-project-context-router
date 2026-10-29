import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { explainSymbol, affectedSymbols, symbolPath } from '../src/symbol-graph/graph.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let root: string, previous: string;
function write(file: string, text: string) {
  mkdirSync(dirname(resolve(root, file)), { recursive: true });
  writeFileSync(resolve(root, file), text);
}
beforeEach(() => {
  previous = process.cwd(); root = mkdtempSync(resolve(tmpdir(), 'router-symbols-'));
  execFileSync('git', ['init', '-q'], { cwd: root }); process.chdir(root);
  write('.project-context/project.yaml', 'project:\n  name: Graph Test\nmodules:\n  app:\n    path: src\n    source_globs: ["src/**/*.ts"]\ncommands: {}\n');
  write('src/target.ts', 'export function redactSecrets() { return "safe"; }\n');
  write('src/pack.ts', 'import { redactSecrets as clean } from "./target.js";\nexport function withFileExcerpt() { const text = clean(); return text; }\nexport const run = () => withFileExcerpt();\n');
});
afterEach(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });

it('resolves aliases and returns call-site and declaration lines in both directions', () => {
  expect(explainSymbol({ symbol: 'redactSecrets' })).toMatchObject({ status: 'found', symbol: { file: 'src/target.ts', line: 1 }, connections: [
    { relation: 'imports', file: 'src/pack.ts', line: 1 },
    { relation: 'calls', file: 'src/pack.ts', line: 2, source: { name: 'withFileExcerpt' } },
  ] });
  expect(symbolPath({ from: 'run', to: 'redactSecrets' })).toMatchObject({ status: 'found', nodes: [
    { name: 'run' }, { name: 'withFileExcerpt' }, { name: 'redactSecrets' },
  ], edges: [{ line: 3 }, { line: 2 }] });
  expect(affectedSymbols({ symbol: 'redactSecrets' })).toMatchObject({ status: 'found', affected: expect.arrayContaining([
    expect.objectContaining({ symbol: expect.objectContaining({ name: 'run' }), depth: 2 }),
  ]) });
});

it('distinguishes shadowed parameters, comments, strings, duplicate names and qualified IDs', () => {
  write('src/other.ts', 'export function redactSecrets() {}\nexport function shadow(redactSecrets: () => void) { redactSecrets(); }\n');
  write('src/noise.ts', '// redactSecrets()\nconst text = "function redactSecrets() {}";\n');
  expect(explainSymbol({ symbol: 'redactSecrets' })).toMatchObject({ status: 'ambiguous', candidates: expect.any(Array) });
  expect(explainSymbol({ symbol: 'src/other.ts#redactSecrets' })).toMatchObject({ status: 'found', connections: [] });
  expect(symbolPath({ from: 'shadow', to: 'src/other.ts#redactSecrets' })).toMatchObject({ status: 'no_path' });
  expect(explainSymbol({ symbol: 'doesNotExist' })).toMatchObject({ status: 'not_found' });
});

it('bounds cycles and distinguishes a depth cutoff from absence of a path', () => {
  write('src/cycle.ts', 'export function a() { b(); }\nexport function b() { a(); c(); }\nexport function c() {}\n');
  expect(symbolPath({ from: 'a', to: 'c', depth: 1 })).toMatchObject({ status: 'truncated', truncated: true });
  expect(symbolPath({ from: 'a', to: 'a' })).toMatchObject({ status: 'found', edges: [] });
  expect(affectedSymbols({ symbol: 'c', limit: 1 })).toMatchObject({ truncated: true, affected: [expect.any(Object)] });
  expect(affectedSymbols({ symbol: 'c', depth: 1 })).toMatchObject({ truncated: true });
  expect(explainSymbol({ symbol: 'b', limit: 1 })).toMatchObject({ truncated: true, connections: [expect.any(Object)] });
  expect(() => affectedSymbols({ symbol: 'a', depth: -1 })).toThrow();
  expect(() => symbolPath({ from: '', to: 'a' })).toThrow();
});

it('refreshes edges and line numbers immediately after edits, renames and deletion', () => {
  expect(symbolPath({ from: 'withFileExcerpt', to: 'redactSecrets' })).toMatchObject({ status: 'found' });
  write('src/pack.ts', 'import { redactSecrets } from "./target.js";\n\nexport function replacement() { redactSecrets(); }\n');
  expect(explainSymbol({ symbol: 'withFileExcerpt' })).toMatchObject({ status: 'not_found' });
  expect(symbolPath({ from: 'replacement', to: 'redactSecrets' })).toMatchObject({ status: 'found', edges: [{ line: 3 }] });
  unlinkSync(resolve(root, 'src/target.ts'));
  expect(explainSymbol({ symbol: 'redactSecrets' })).toMatchObject({ status: 'not_found' });
  expect(explainSymbol({ symbol: 'replacement' })).toMatchObject({ connections: [] });
});

it('supports namespace imports and methods without linking to unrelated same-name methods', () => {
  write('src/classes.ts', 'export class A { work() {} }\nexport class B { work() {} }\nexport function use() { const a = new A(); a.work(); }\n');
  write('src/ns.ts', 'import * as target from "./target.js";\nexport function ns() { target.redactSecrets(); }\n');
  expect(symbolPath({ from: 'ns', to: 'redactSecrets' })).toMatchObject({ status: 'found' });
  expect(explainSymbol({ symbol: 'work' })).toMatchObject({ status: 'ambiguous' });
  const result = explainSymbol({ symbol: 'use' });
  expect(result).toMatchObject({ connections: expect.arrayContaining([expect.objectContaining({ target: expect.objectContaining({ name: 'work', line: 1 }) })]) });
  expect(JSON.stringify(result)).not.toContain('\"name\":\"B\"');
});

it('exposes matching results through CLI and the core MCP profile', async () => {
  const operations = [
    { tool: 'explain', args: { symbol: 'redactSecrets' }, cli: ['explain', 'redactSecrets'], expected: explainSymbol({ symbol: 'redactSecrets' }) },
    { tool: 'affected', args: { symbol: 'redactSecrets' }, cli: ['affected', 'redactSecrets'], expected: affectedSymbols({ symbol: 'redactSecrets' }) },
    { tool: 'path', args: { from: 'run', to: 'redactSecrets' }, cli: ['path', 'run', 'redactSecrets'], expected: symbolPath({ from: 'run', to: 'redactSecrets' }) },
  ];
  const client = new Client({ name: 'symbol-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(packageRoot, 'bin/project-context-mcp')], cwd: root,
    env: { ...process.env, PROJECT_CONTEXT_TOOL_PROFILE: 'core' } as Record<string, string>, stderr: 'pipe' });
  try {
    await client.connect(transport);
    for (const op of operations) {
      const cli = JSON.parse(execFileSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), ...op.cli, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
      expect(cli).toEqual(op.expected);
      const response = await client.callTool({ name: op.tool, arguments: op.args });
      expect(response.isError).not.toBe(true);
      const { brand, ...data } = response.structuredContent!;
      expect(brand).toBeDefined(); expect(data).toEqual(op.expected);
    }
  } finally { await client.close(); }
});

it('loads the Compiler API only when building a graph, not on lightweight startup', () => {
  const script = `import { createRequire } from 'node:module';
    const require = createRequire(import.meta.url);
    const { rebuildIndex } = await import(${JSON.stringify(pathToFileURL(resolve(packageRoot, 'dist/indexer/sqlite.js')).href)});
    const loaded = () => Object.keys(require.cache).some(path => path.split(String.fromCharCode(92)).join('/').includes('typescript/lib/typescript.js'));
    const before = loaded(); rebuildIndex();
    console.log(JSON.stringify({ before, after: loaded() }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  expect(result).toEqual({ before: false, after: true });
});
