import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { rebuildIndex } from '../src/indexer/sqlite.js';
import { writeMarkdown } from '../src/storage/markdown.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

let originalCwd: string;
let root: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'context-pack-index-test-'));
  process.chdir(root);
  mkdirSync(resolve(root, '.project-context'), { recursive: true });
  writeFileSync(resolve(root, '.project-context/project.yaml'), `project:
  name: Context pack index tests
routing:
  default_modules: [router]
modules:
  router:
    path: src
    aliases: [engine]
    source_globs: ["src/**/*.ts"]
  other:
    path: other
commands: {}
`);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function record(id: string, fields: Record<string, unknown> = {}, area = 'active') {
  writeMarkdown(resolve(root, `.project-context/${area}/records/${id}.md`), {
    id, type: 'decision', title: 'Routing evidence', status: 'active', modules: ['router'], ...fields,
  }, 'Routing evidence for context retrieval.');
}

describe('context packs backed by the disposable index', () => {
  it.each([false, true])('reads only selected Markdown records on a fresh-index cache miss (explicit task: %s)', (withTask) => {
    for (let i = 0; i < 80; i++) record(`RECORD-${i}`, { type: 'source' });
    record('DECISION', { confirmed_by_human: true });
    record('TASK', { type: 'task', status: 'confirmed' });
    rebuildIndex();
    vi.mocked(readFileSync).mockClear();

    const pack = buildContextPack({ query: 'routing evidence', modules: ['router'], taskId: withTask ? 'TASK' : undefined });
    const recordReads = vi.mocked(readFileSync).mock.calls.filter(([path]) => String(path).includes(`${resolve(root, '.project-context/active')}/`));

    expect(pack.cache?.status).toBe('miss');
    expect(pack.records.map((item) => item.id)).toContain('DECISION');
    if (withTask) expect(pack.records[0].id).toBe('TASK');
    expect(recordReads.length).toBeLessThanOrEqual(pack.records.length);
  });

  it('keeps confirmed decisions beyond an initial search limit and applies history, draft and archive policy', () => {
    for (let i = 0; i < 60; i++) record(`A-SOURCE-${i}`, { type: 'source' });
    record('Z-CONFIRMED', { confirmed_by_human: true, confirmed_at: '2026-01-02' });
    record('Z-UNCONFIRMED');
    record('HISTORY', { type: 'task', status: 'done' });
    record('DRAFT', { confirmed_by_human: true }, 'drafts');
    record('ARCHIVE', {}, 'archive');
    record('OTHER', { modules: ['other'], confirmed_by_human: true });
    const input = { query: 'routing evidence', modules: ['router'], maxTokens: 10000 };

    const pack = buildContextPack(input);
    const ids = pack.records.map((item) => item.id);
    expect(ids[0]).toBe('Z-CONFIRMED');
    expect(ids.indexOf('Z-UNCONFIRMED')).toBeGreaterThan(ids.indexOf('Z-CONFIRMED'));
    for (const hidden of ['HISTORY', 'DRAFT', 'ARCHIVE', 'OTHER']) expect(ids).not.toContain(hidden);
    expect(pack.records[0]).toMatchObject({ authority: 'user-confirmed', as_of: '2026-01-02' });
    const history = buildContextPack({ ...input, includeHistory: true, includeArchive: true });
    expect(history.records.map((item) => item.id)).toEqual(expect.arrayContaining(['HISTORY', 'ARCHIVE']));
    expect(buildContextPack({ ...input, taskId: 'DRAFT' }).records[0].id).toBe('DRAFT');
  });

  it('sees additions, edits and deletions immediately, including within the search freshness TTL', () => {
    record('FIRST');
    const input = { query: 'routing evidence', modules: ['router'] };
    buildContextPack(input);
    record('LATEST', { confirmed_by_human: true });
    expect(buildContextPack(input).records[0].id).toBe('LATEST');
    record('LATEST', { status: 'retired', title: 'Retired routing evidence' });
    expect(buildContextPack(input).records.map((item) => item.id)).not.toContain('LATEST');
    rmSync(resolve(root, '.project-context/active/records/FIRST.md'));
    expect(buildContextPack(input).records).toEqual([]);
  });

  it('recovers a corrupted database before returning a cached or newly built pack', () => {
    record('DECISION');
    const input = { query: 'routing evidence', modules: ['router'] };
    buildContextPack(input);
    writeFileSync(resolve(root, '.project-context/indexes/context.sqlite'), 'not a database');
    const recovered = buildContextPack(input);
    expect(recovered.records.map((item) => item.id)).toContain('DECISION');
    expect(recovered.cache?.status).toBe('miss');
    expect(buildContextPack(input).cache?.status).toBe('hit');
  });

  it('builds a scoped uncached pack when index storage is unavailable, and resumes caching after recovery', () => {
    record('DECISION', { modules: ['engine'], confirmed_by_human: true });
    record('OTHER', { modules: ['other'], confirmed_by_human: true });
    record('DRAFT', {}, 'drafts');
    const input = { query: 'routing evidence', modules: ['router'] };
    const healthy = buildContextPack(input);
    const indexes = resolve(root, '.project-context/indexes');
    rmSync(indexes, { recursive: true });
    writeFileSync(indexes, 'unavailable index directory');

    const fallback = buildContextPack(input);
    expect(fallback.records).toEqual(healthy.records);
    expect(fallback.records.map((item) => item.id)).toEqual(['DECISION']);
    expect(fallback.cache?.status).toBe('disabled');
    expect(fallback.warnings.some((warning) => warning.includes('directly from Markdown'))).toBe(true);
    expect(readFileSync(indexes, 'utf8')).toBe('unavailable index directory');
    expect(existsSync(resolve(indexes, 'pack-cache'))).toBe(false);

    rmSync(indexes);
    expect(buildContextPack(input).cache?.status).toBe('miss');
    expect(buildContextPack(input).cache?.status).toBe('hit');
  });
});
