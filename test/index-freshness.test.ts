import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureFreshIndex, openDb, readSearchRecords, rebuildIndex, searchIndex } from '../src/indexer/sqlite.js';
import { writeMarkdown } from '../src/storage/markdown.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'context-index-freshness-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), 'project:\n  name: Index tests\nmodules: {}\ncommands: {}\n', 'utf8');
  writeBacklog('BACKLOG-FIRST', 'Initial index record');
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('automatic index freshness', () => {
  it('rebuilds a stale index before subsequent reads', () => {
    rebuildIndex();
    writeBacklog('BACKLOG-SECOND', 'Freshly added routing record');

    const refresh = ensureFreshIndex({ force: true });
    const records = searchIndex('Freshly added routing', 5);

    expect(refresh.status).toBe('rebuilt');
    expect(records.map((record) => record.id)).toContain('BACKLOG-SECOND');
  });

  it('uses a bounded SQLite busy timeout for concurrent hooks and agents', () => {
    const db = openDb();
    try {
      expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    } finally {
      db.close();
    }
  });

  it.each(['missing', 'corrupt'])('recovers a %s index even inside the freshness TTL', (state) => {
    rebuildIndex();
    const path = resolve(tempDir, '.project-context/indexes/context.sqlite');
    rmSync(path);
    if (state === 'corrupt') writeFileSync(path, 'not a SQLite database');

    expect(searchIndex('Initial index', 5).map((record) => record.id)).toContain('BACKLOG-FIRST');
    expect(readSearchRecords().source).toBe('index');
    expect(ensureFreshIndex({ force: true }).status).toBe('fresh');
  });

  it.each([5, 8])('preserves a healthy cache on SQLite error %s (busy or readonly)', (errcode) => {
    rebuildIndex();
    const path = resolve(tempDir, '.project-context/indexes/context.sqlite');
    const before = readFileSync(path);
    const error = Object.assign(new Error('Index temporarily unavailable'), { errcode });
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementationOnce(() => { throw error; });

    expect(() => openDb()).toThrow(error);
    expect(readFileSync(path)).toEqual(before);
    expect(searchIndex('Initial index', 5).map((record) => record.id)).toContain('BACKLOG-FIRST');
  });

  it('recovers corruption reported while reading indexed records, after the schema was opened', () => {
    rebuildIndex();
    const prepare = DatabaseSync.prototype.prepare;
    let corrupt = true;
    vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql) {
      if (corrupt && sql.includes('SELECT search_index.body')) {
        corrupt = false;
        throw Object.assign(new Error('database disk image is malformed'), { errcode: 267 });
      }
      return prepare.call(this, sql);
    });

    const result = readSearchRecords();
    expect(result.source).toBe('index');
    expect(result.records.map((record) => record.id)).toContain('BACKLOG-FIRST');
    expect(corrupt).toBe(false);
  });

  it('migrates an old search table and rebuilds its record metadata', () => {
    rebuildIndex();
    const db = openDb();
    db.exec(`DROP TABLE search_index;
CREATE TABLE search_index (record_id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, tags TEXT NOT NULL);
UPDATE index_metadata SET value = '4' WHERE key = 'schema_version';`);
    db.close();

    const result = readSearchRecords({ recordId: 'BACKLOG-FIRST' });
    expect(result.source).toBe('index');
    expect(result.records[0]).toMatchObject({
      id: 'BACKLOG-FIRST', modules: ['tools'], tags: ['routing'],
      frontmatter: { priority: 'P1', agent_size: 'small' },
    });
  });

  it('preserves module aliases, global records, archive selection and duplicate precedence during fallback', () => {
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:\n  name: Scoped search\nmodules:\n  router:\n    path: src\n    aliases: [engine]\n  other:\n    path: other\ncommands: {}\n`);
    for (const [id, modules, area] of [
      ['ROUTER', ['router'], 'active'], ['ALIAS', ['engine'], 'active'],
      ['GLOBAL', [], 'active'], ['OTHER', ['other'], 'active'],
      ['ARCHIVED', ['router'], 'archive'], ['ROUTER', ['other'], 'drafts'],
    ] as const) {
      writeMarkdown(resolve(tempDir, `.project-context/${area}/decisions/${id}.md`), {
        id, type: 'decision', title: 'Scope probe', status: 'active', modules: [...modules],
      }, 'Scope probe');
    }
    rebuildIndex();
    const ids = (includeArchive: boolean) => searchIndex('scope probe', 20, includeArchive, ['engine']).map((record) => record.id).sort();
    const active = ids(false);
    const archived = ids(true);
    expect(active).toEqual(['ALIAS', 'GLOBAL', 'ROUTER']);
    expect(archived).toEqual(['ALIAS', 'ARCHIVED', 'GLOBAL', 'ROUTER']);

    const path = resolve(tempDir, '.project-context/indexes/context.sqlite');
    rmSync(path);
    mkdirSync(path);
    expect(ids(false)).toEqual(active);
    expect(ids(true)).toEqual(archived);
    expect(readSearchRecords({ modules: ['engine'] }).source).toBe('markdown');
    expect(statSync(path).isDirectory()).toBe(true);
  });
});

function writeBacklog(id: string, title: string): void {
  writeFileSync(resolve(tempDir, `.project-context/active/backlog/${id}.md`), `---
id: ${id}
type: backlog
status: ready
priority: P1
agent_size: small
title: ${title}
modules:
  - tools
tags:
  - routing
depends_on: []
acceptance_criteria: []
checks: []
retention: keep
---

# ${title}

Freshly added routing content.
`, 'utf8');
}
