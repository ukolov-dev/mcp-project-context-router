import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { ensureFreshIndex, openDb, rebuildIndex, searchFtsRecords, searchIndex } from '../src/indexer/sqlite.js';
import { buildProjectContextPack, buildProjectContextPackInputSchema } from '../src/project-context/project-context.js';
import { writeMarkdown } from '../src/storage/markdown.js';

const cli = resolve('bin/project-context');
let originalCwd: string;
let root: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'fts-search-test-'));
  process.chdir(root);
  mkdirSync('.project-context', { recursive: true });
  writeFileSync('.project-context/project.yaml', `project:\n  name: Optional search\nmodules:\n  router:\n    path: src\n    aliases: [engine]\n  other:\n    path: other\ncommands: {}\n`);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});
function record(id: string, body: string, fields: Record<string, unknown> = {}, area = 'active') {
  writeMarkdown(resolve(`.project-context/${area}/records/${id}.md`), {
    id, type: 'decision', title: id, status: 'active', modules: ['router'], ...fields,
  }, body);
}
function ids(query: string, options: Parameters<typeof searchFtsRecords>[1] = {}) {
  const result = searchFtsRecords(query, options);
  expect(result.available).toBe(true);
  return result.records.map((record) => record.id);
}

describe('optional FTS5 with identifier reserve', () => {
  it('reads direct and reserve results from one snapshot when another connection rebuilds between them', () => {
    record('FIRST', 'quick_valid');
    record('THIRD', 'quick_validation');
    expect(ids('quick_valid')).toEqual(['FIRST', 'THIRD']);
    const prepare = DatabaseSync.prototype.prepare;
    let changed = false;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.includes('ORDER BY bm25(record_fts')) {
        const all = statement.all.bind(statement);
        vi.spyOn(statement, 'all').mockImplementation((...args) => {
          const rows = all(...args);
          if (!changed) {
            changed = true;
            record('THIRD', 'unrelated new content');
            record('SECOND', 'quick_validation');
            rebuildIndex();
          }
          return rows;
        });
      }
      return statement;
    });
    const result = searchFtsRecords('quick_valid');
    expect(result.available).toBe(true);
    expect(result.records.map((r) => r.id)).toEqual(['FIRST', 'THIRD']);
    expect(result.records[1].body.trim()).toBe('quick_validation');
    expect(ids('quick_valid')).toEqual(['FIRST', 'SECOND']);
  });
  it('publishes one coherent lazy projection for concurrent first requests', async () => {
    record('RECORD', 'quick_validation');
    rebuildIndex();
    const outputs = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
      [cli, '--json', 'search', 'quick_valid', '--search-engine', 'fts5'], { cwd: root })));
    for (const output of outputs) expect(JSON.parse(output.stdout).records.map((r: { id: string }) => r.id)).toEqual(['RECORD']);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS count FROM record_fts').get()).toEqual({ count: 1 });
    db.close();
  });

  it('rolls back a failed projection refresh without deleting records or publishing its marker', () => {
    record('FIRST', 'quick_validation');
    expect(ids('quick_valid')).toEqual(['FIRST']);
    record('SECOND', 'quick_validation');
    ensureFreshIndex({ force: true });
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
      const result = exec.call(this, sql);
      if (sql.includes('INSERT INTO record_fts')) throw Object.assign(new Error('projection write failed'), { errcode: 5 });
      return result;
    });
    expect(searchFtsRecords('quick_valid').available).toBe(false);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS count FROM records').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT count(*) AS count FROM record_fts').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT value FROM index_metadata WHERE key = 'fts_projection_version'").get()).toBeUndefined();
    db.close();
    spy.mockRestore();
    expect(ids('quick_valid')).toEqual(['FIRST', 'SECOND']);
  });
  it('preserves current default and FTS prefix, appends proper identifiers, and respects the total limit', () => {
    for (let i = 0; i < 8; i++) record(`GLOSSARY-${i}`, 'quick_valid');
    for (let i = 0; i < 12; i++) record(`PROPER-${i}`, 'quick_validation');
    record('LOWER', 'ordinaryfragmentLonger');
    rebuildIndex();
    expect(searchIndex('quick_valid').map((r) => r.id)).toEqual(searchIndex('quick_valid', 10, false, [], 'current').map((r) => r.id));
    const db = openDb();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'record_fts'").get()).toBeUndefined();
    db.close();
    const five = ids('quick_valid', { limit: 5 });
    const ten = searchFtsRecords('quick_valid');
    expect(ten.available).toBe(true);
    expect(ten.records.slice(0, 5).map((r) => r.id)).toEqual(five);
    expect(ten.identifierIds).toHaveLength(5);
    expect(ten.identifierIds.every((id) => id.startsWith('PROPER-'))).toBe(true);
    expect(new Set(ten.records.map((r) => r.id)).size).toBe(10);
    expect(searchIndex('quick_valid', 7, false, [], 'fts5')).toHaveLength(7);
    expect(ids('ordinaryfragment')).toEqual([]);
    expect(() => searchIndex('quick_valid', 10, false, [], 'wrong' as never)).toThrow('searchEngine');
  });

  it('filters aliases, global records, archives, drafts and history before choosing direct and reserve hits', () => {
    for (let i = 0; i < 12; i++) record(`OTHER-${i}`, 'quick_valid quick_validation', { modules: ['other'] });
    record('ALIAS', 'quick_validation', { modules: ['engine'] });
    record('GLOBAL', 'quick_validation', { modules: [] });
    record('ARCHIVE', 'quick_validation', {}, 'archive');
    record('DRAFT', 'quick_validation', {}, 'drafts');
    record('DONE', 'quick_validation', { type: 'task', status: 'done' });
    record('EVIDENCE', 'quick_validation', { type: 'verification-evidence' });
    record('RETIRED', 'quick_validation', { status: 'retired' });
    const options = { modules: ['engine'], excludeDrafts: true, includeHistory: false };
    expect(ids('quick_valid', options).sort()).toEqual(['ALIAS', 'GLOBAL']);
    expect(ids('quick_valid', { ...options, includeArchive: true }).sort()).toEqual(['ALIAS', 'ARCHIVE', 'GLOBAL']);
    expect(ids('quick_valid', { ...options, includeHistory: true }).sort()).toEqual(['ALIAS', 'DONE', 'EVIDENCE', 'GLOBAL', 'RETIRED']);
    record('EXPLICIT', 'unrelated task', { type: 'task', status: 'done' }, 'drafts');
    expect(buildContextPack({ query: 'quick_valid', searchEngine: 'fts5', modules: ['router'], taskId: 'EXPLICIT', maxTokens: 10000 }).records[0].id).toBe('EXPLICIT');
  });

  it('retains Unicode folding, field weights, query-term order, and duplicate suppression', () => {
    record('BODY', 'quick_validation');
    record('TITLE', 'other', { title: 'quick_validation' });
    record('TAG', 'other', { tags: ['quick_validation'] });
    record('UNICODE', 'ЁжикФункция');
    record('SECOND', 'OtherIdentifierLonger');
    expect(ids('quick_valid OtherIdentifier')).toEqual(['TITLE', 'TAG', 'BODY', 'SECOND']);
    expect(ids('ЁжикФунк')).toEqual(['UNICODE']);
    expect(ids('quick_valid quick_validation')).toEqual(['TITLE', 'TAG', 'BODY']);
    expect(new Set(ids('quick_valid quick_validation')).size).toBe(3);
    expect(ids('" OR * : ()')).toEqual([]);
  });

  it('refreshes projections after additions, edits, deletions and moves, and recovers missing or corrupt indexes', () => {
    record('FIRST', 'quick_validation');
    const input = { query: 'quick_valid', searchEngine: 'fts5' as const, modules: ['router'], maxTokens: 10000 };
    expect(buildContextPack(input).records.map((r) => r.id)).toEqual(['FIRST']);
    record('SECOND', 'quick_validation');
    expect(buildContextPack(input).records.map((r) => r.id)).toEqual(['FIRST', 'SECOND']);
    record('FIRST', 'unrelated');
    expect(buildContextPack(input).records.map((r) => r.id)).toEqual(['SECOND']);
    mkdirSync('.project-context/archive/records', { recursive: true });
    renameSync('.project-context/active/records/SECOND.md', '.project-context/archive/records/SECOND.md');
    expect(buildContextPack(input).records).toEqual([]);
    expect(buildContextPack({ ...input, includeArchive: true }).records.map((r) => r.id)).toEqual(['SECOND']);
    for (const contents of [null, 'not a sqlite database']) {
      const path = resolve('.project-context/indexes/context.sqlite');
      if (contents === null) rmSync(path); else writeFileSync(path, contents);
      expect(ids('quick_valid', { includeArchive: true })).toEqual(['SECOND']);
    }
    rmSync('.project-context/archive/records/SECOND.md');
    ensureFreshIndex({ force: true });
    expect(ids('quick_valid', { includeArchive: true })).toEqual([]);
  });

  it('falls back visibly without caching or deleting a healthy index when FTS5 setup fails', () => {
    record('RECORD', 'quick_validation');
    rebuildIndex();
    const exec = DatabaseSync.prototype.exec;
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
      if (sql.includes('CREATE VIRTUAL TABLE')) throw new Error('no such module: fts5');
      return exec.call(this, sql);
    });
    const input = { query: 'quick_valid', modules: ['router'], maxTokens: 10000 };
    expect(searchIndex(input.query, 10, false, [], 'fts5').map((r) => r.id)).toEqual(['RECORD']);
    const fallback = buildContextPack({ ...input, searchEngine: 'fts5' });
    expect(fallback.records).toEqual(buildContextPack(input).records);
    expect(fallback.cache?.status).toBe('disabled');
    expect(fallback.warnings.some((w) => w.includes('FTS5 unavailable'))).toBe(true);
    const db = openDb();
    expect(db.prepare('SELECT count(*) AS count FROM records').get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT value FROM index_metadata WHERE key = 'fts_projection_version'").get()).toBeUndefined();
    db.close();
    spy.mockRestore();
    expect(buildContextPack({ ...input, searchEngine: 'fts5' }).cache?.status).toBe('miss');
  });

  it('keeps cache keys separate, uses actual excerpts and budgets, and exposes the mode through CLI and sourced packs', () => {
    record('RECORD', 'quick_validation '.repeat(60));
    record('UNRELATED', 'unrelated knowledge', { confirmed_by_human: true });
    const input = { query: 'quick_valid', modules: ['router'], maxTokens: 4000 };
    const current = buildContextPack(input);
    expect(buildContextPack({ ...input, searchEngine: 'current' }).cache?.key).toBe(current.cache?.key);
    const fts = buildContextPack({ ...input, searchEngine: 'fts5' });
    expect(fts.cache?.key).not.toBe(current.cache?.key);
    expect(fts.records.map((r) => r.id)).toEqual(['RECORD']);
    expect(buildContextPack({ ...input, searchEngine: 'fts5' }).cache?.status).toBe('hit');
    for (const maxTokens of [500, 1000, 2000, 4000]) {
      const pack = buildContextPack({ ...input, maxTokens, searchEngine: 'fts5' });
      expect(pack.budget.estimatedTokens).toBeLessThanOrEqual(maxTokens);
      expect(pack.budget.exceedsLimit).toBe(false);
    }
    expect(fts.records[0].excerpt).toContain('quick_validation');
    const sourced = buildProjectContextPack({ ...input, searchEngine: 'fts5' });
    expect(sourced.sources.map((s) => s.id)).toEqual(['RECORD']);
    expect(() => buildProjectContextPackInputSchema.parse({ ...input, searchEngine: 'wrong' })).toThrow();
    expect(() => buildContextPack({ ...input, searchEngine: 'wrong' as never })).toThrow('searchEngine');
    const output = JSON.parse(execFileSync(process.execPath, [cli, '--json', 'pack', 'quick_valid', '--search-engine', 'fts5', '--modules', 'router'], { encoding: 'utf8' }));
    expect(output.records.map((r: { id: string }) => r.id)).toEqual(['RECORD']);
    const search = JSON.parse(execFileSync(process.execPath, [cli, '--json', 'search', 'quick_valid', '--search-engine', 'fts5'], { encoding: 'utf8' }));
    expect(search.records.map((r: { id: string }) => r.id)).toEqual(['RECORD']);
    expect(readFileSync(resolve(root, '.project-context/active/records/RECORD.md'), 'utf8')).toContain('quick_validation');
  });
});
