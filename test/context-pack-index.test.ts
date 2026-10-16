import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { rebuildIndex } from '../src/indexer/sqlite.js';
import { writeMarkdown } from '../src/storage/markdown.js';
import { validateTask } from '../src/task-validation/task.js';

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
    aliases: [go]
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
  it('routes an exact work key before the default module and respects explicit scope', () => {
    record('TASK-SYNC', { type: 'task', status: 'in_progress', title: 'SD-14: Reconciliation', tags: ['sd-14'], modules: ['other'] });
    record('TASK-PREFIX', { type: 'task', status: 'confirmed', title: 'SD-1: Other work', modules: ['router'] });
    const pack = buildContextPack({ query: 'SD-14 reconciliation conflicts' });
    expect(pack.routing?.modules).toEqual(['other']);
    expect(pack.routing?.basis).toBe('task/backlog identifier');
    expect(pack.records[0].id).toBe('TASK-SYNC');
    expect(buildContextPack({ query: 'SD-14', modules: ['router'] }).routing?.modules).toEqual(['router']);
    expect(buildContextPack({ query: 'SD-14', files: ['src/file.ts'] }).routing?.modules).toEqual(['router']);
    expect(buildContextPack({ query: 'SD-140' }).routing?.modules).toEqual(['router']);
    expect(validateTask('SD-14 reconciliation conflicts').suggestedContract.modules).toEqual(['other']);
    expect(buildContextPack({ query: 'Unrelated', taskId: 'TASK-SYNC' }).routing?.modules).toEqual(['other']);
  });

  it('finds a directly requested completed task without exposing unrelated history', () => {
    record('CURRENT', { type: 'task', status: 'done', title: 'Repair DOC-05 and UX-12', tags: ['doc-05', 'ux-12'], updated_at: '2026-10-16' });
    for (let i = 0; i < 8; i++) record(`OLD-${i}`, { type: 'task', status: 'confirmed', title: 'Document UI repair', confirmed_by_human: true });
    record('OTHER-DONE', { type: 'task', status: 'done' });
    const pack = buildContextPack({ query: 'DOC-05 UX-12 document UI repair', workflow: 'fast' });
    expect(pack.records[0]).toMatchObject({ id: 'CURRENT', status: 'done', category: 'historical' });
    expect(pack.records.map(r => r.id)).not.toContain('OTHER-DONE');
  });

  it('uses task activity and update dates without letting unrelated new work displace a relevant decision', () => {
    record('OLD', { type: 'task', status: 'confirmed', updated_at: '2026-01-01', confirmed_at: '2026-01-01' });
    record('RECENT', { type: 'task', status: 'confirmed', updated_at: '2026-10-16', confirmed_at: '2026-01-01' });
    record('WORKING', { type: 'task', status: 'in_progress', updated_at: '2026-10-15' });
    record('DECISION', { confirmed_by_human: true });
    record('UNRELATED', { type: 'task', status: 'in_progress', title: 'Unrelated work', updated_at: '2026-10-17' });
    const ids = buildContextPack({ query: 'routing evidence', maxTokens: 10000 }).records.map(r => r.id);
    expect(ids[0]).toBe('DECISION');
    expect(ids.indexOf('WORKING')).toBeLessThan(ids.indexOf('OLD'));
    expect(ids.indexOf('RECENT')).toBeLessThan(ids.indexOf('OLD'));
  });

  it('recognizes short module aliases in hyphenated words without substring matches', () => {
    expect(buildContextPack({ query: 'go-widget' }).routing?.modules).toEqual(['other']);
    expect(buildContextPack({ query: 'golang' }).routing?.modules).toEqual(['router']);
  });

  it('ranks a task linked to explicit files above equally relevant unscoped work', () => {
    record('A-OLD', { type: 'task', status: 'confirmed', confirmed_by_human: true, updated_at: '2026-10-17' });
    record('Z-SCOPED', { type: 'task', status: 'confirmed', files: ['src/file.ts'], updated_at: '2026-01-01' });
    expect(buildContextPack({ query: 'routing evidence', files: ['src/file.ts'] }).records[0].id).toBe('Z-SCOPED');
  });

  it('compares update instants across timezones rather than timestamp strings', () => {
    record('EARLY', { type: 'task', status: 'in_progress', updated_at: '2026-10-16T12:00:00+03:00' });
    record('LATER', { type: 'task', status: 'confirmed', updated_at: '2026-10-16T10:00:00Z' });
    expect(buildContextPack({ query: 'routing evidence' }).records[0].id).toBe('LATER');
  });

  it('does not infer modules from draft keys, retired work or unknown modules', () => {
    record('DRAFT', { type: 'task', title: 'SD-14', modules: ['other'] }, 'drafts');
    record('RETIRED', { type: 'task', title: 'SD-14', status: 'retired', modules: ['other'] });
    record('UNKNOWN', { type: 'task', title: 'SD-14', modules: ['missing'] });
    const pack = buildContextPack({ query: 'SD-14' });
    expect(pack.routing).toMatchObject({ modules: ['router'], basis: 'configured fallback' });
    for (const id of ['DRAFT', 'RETIRED']) expect(pack.records.map(r => r.id)).not.toContain(id);
  });

  it.each([null, [], { toString: 1 }, 14])('ignores a malformed optional task_key: %j', (task_key) => {
    record('TASK-WRONG', { type: 'task', title: 'Other work', task_key, modules: ['other'] });
    expect(buildContextPack({ query: 'SD-14' }).routing?.modules).toEqual(['router']);
  });

  it('invalidates pack caches created before task-aware routing', () => {
    record('DECISION');
    const input = { query: 'routing evidence' };
    const first = buildContextPack(input);
    const file = resolve(root, first.cache!.path!);
    const cached = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...cached, version: 7 }));
    expect(buildContextPack(input).cache?.status).toBe('miss');
    expect(buildContextPack(input).cache?.status).toBe('hit');
  });

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
