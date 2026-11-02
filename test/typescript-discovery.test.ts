import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCapabilities } from '../src/indexer/capabilities.js';
import { ensureFreshIndex, openDb, rebuildIndex } from '../src/indexer/sqlite.js';
import { findExistingCapability } from '../src/reuse-scan/reuse.js';
import { explainSymbol } from '../src/symbol-graph/graph.js';
import * as extraction from '../src/symbol-graph/extract.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let previous: string;
let root: string;

beforeEach(() => {
  previous = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'router-typescript-discovery-'));
  process.chdir(root);
  mkdirSync('src');
  mkdirSync('.project-context');
  writeFileSync('.project-context/project.yaml', 'project:\n  name: TypeScript discovery\nrouting:\n  default_modules: [app]\nmodules:\n  app:\n    path: src\ncommands: {}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
});

describe('shared TypeScript/JavaScript discovery', () => {
  it.each(['ts', 'js'])('ignores %s comments and strings in both reuse and graph results', (extension) => {
    writeFileSync(`src/sample.${extension}`, `// export function obsoleteHelper() {}
/* export class CommentService {} */
const example = "function imaginaryHelper() {}";
const template = \`class TemplateService {}\`;
export function realHelper() { return example; }
`);

    const discovered = discoverCapabilities();
    const names = discovered.capabilities.map(item => item.name);

    expect(names).toEqual(['example', 'template', 'realHelper']);
    expect(discovered.graph.nodes.filter(item => item.kind !== 'file')).toEqual(discovered.capabilities);
    rebuildIndex();
    expect(findExistingCapability('obsoleteHelper', ['app']).matches).toEqual([]);
    expect(findExistingCapability('imaginaryHelper', ['app']).matches.map(item => item.name)).not.toContain('imaginaryHelper');
    expect(findExistingCapability('realHelper', ['app']).matches).toContainEqual(expect.objectContaining({ name: 'realHelper' }));
    expect(explainSymbol({ symbol: 'obsoleteHelper' }).status).toBe('not_found');
    expect(explainSymbol({ symbol: 'realHelper' }).status).toBe('found');
  });

  it('preserves public signatures, exports and function/component/hook/type/class kinds', () => {
    writeFileSync('src/public.ts', `export function helper(value: string) { return value; }
export function useCustomer() { return helper("customer"); }
export function CustomerPanel() { return null; }
export const CustomerCard = () => null;
export const constantValue = 1;
export type CustomerId = string;
export interface Customer { id: CustomerId }
export class CustomerService { load() { return helper("customer"); } }
function privateHelper() { return "export"; }
const privateValue = "export const anotherFake = 1";
`);

    const { capabilities, graph } = discoverCapabilities();
    const expected = [
      ['helper', 'function', 'export function helper'], ['useCustomer', 'hook', 'export function useCustomer'],
      ['CustomerPanel', 'component', 'export function CustomerPanel'], ['CustomerCard', 'component', 'export const CustomerCard'],
      ['constantValue', 'constant', 'export const constantValue'], ['CustomerId', 'type', 'export type CustomerId'],
      ['Customer', 'type', 'export interface Customer'], ['CustomerService', 'class', 'export class CustomerService'],
    ];
    for (const [name, kind, signature] of expected) {
      const capability = capabilities.find(item => item.name === name);
      expect(capability).toMatchObject({ kind, exported: true, module: 'app', filePath: 'src/public.ts' });
      expect(capability?.signature).toContain(signature);
      expect(graph.nodes).toContainEqual(capability);
    }
    expect(capabilities.find(item => item.name === 'privateHelper')).toMatchObject({ exported: false });
    expect(capabilities.find(item => item.name === 'privateValue')).toMatchObject({ exported: false });
    expect(graph.edges).toContainEqual(expect.objectContaining({
      source: capabilities.find(item => item.name === 'useCustomer')?.id,
      target: capabilities.find(item => item.name === 'helper')?.id,
      relation: 'calls',
    }));
  });

  it('keeps separate same-line declarations without duplicate IDs', () => {
    writeFileSync('src/scopes.ts', 'export function first() { const value = 1; return value; } export function second() { const value = 2; return value; }\n');

    const { capabilities } = discoverCapabilities();

    expect(capabilities.filter(item => item.name === 'value')).toHaveLength(2);
    expect(new Set(capabilities.map(item => item.id)).size).toBe(capabilities.length);
  });

  it('extracts one shared graph when rebuilding the capability index', () => {
    writeFileSync('src/sample.ts', 'export function realHelper() {}\n');
    const extract = vi.spyOn(extraction, 'extractSymbolGraph');

    rebuildIndex();

    expect(extract).toHaveBeenCalledTimes(1);
  });

  it('uses the same declarations when index storage is unavailable', () => {
    writeFileSync('src/sample.ts', '// function obsoleteHelper() {}\nexport function realHelper() {}\n');
    mkdirSync('.project-context/indexes/context.sqlite', { recursive: true });

    expect(findExistingCapability('obsoleteHelper', ['app']).matches).toEqual([]);
    expect(findExistingCapability('realHelper', ['app']).matches).toContainEqual(expect.objectContaining({
      name: 'realHelper', reason: expect.stringContaining('Source scan'),
    }));
  });

  it('refreshes unchanged indexes made by the previous regex extractor', () => {
    writeFileSync('src/sample.ts', 'export function realHelper() {}\n');
    rebuildIndex();
    const stat = statSync('src/sample.ts');
    const previousState = createHash('sha256').update('symbol-graph-v4')
      .update('app').update('\0').update('src/sample.ts').update('\0')
      .update(`${stat.size}:${stat.mtimeMs}`).update('\0').digest('hex');
    const db = openDb();
    try {
      db.prepare('INSERT INTO symbols (id, name, kind, module, file_path) VALUES (?, ?, ?, ?, ?)')
        .run('legacy', 'obsoleteHelper', 'function', 'app', 'src/sample.ts');
      db.prepare('UPDATE index_metadata SET value = ? WHERE key = ?').run(previousState, 'capability_source_state');
    } finally { db.close(); }

    expect(ensureFreshIndex({ force: true }).status).toBe('rebuilt');
    expect(findExistingCapability('obsoleteHelper', ['app']).matches).toEqual([]);
    expect(findExistingCapability('realHelper', ['app']).matches).toContainEqual(expect.objectContaining({ name: 'realHelper' }));
  });

  it('does not load the compiler when importing discovery or indexing a repository without TS/JS', () => {
    const entry = pathToFileURL(resolve(packageRoot, 'src/indexer/sqlite.ts')).href;
    const output = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(entry)});
      process.chdir(${JSON.stringify(root)});
      const { rebuildIndex } = await import(${JSON.stringify(entry)});
      const before = Boolean(require.cache[require.resolve('typescript')]);
      rebuildIndex();
      console.log(JSON.stringify([before, Boolean(require.cache[require.resolve('typescript')])]));
    `], { cwd: packageRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

    expect(JSON.parse(output)).toEqual([false, false]);
  });
});
