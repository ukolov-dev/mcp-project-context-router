import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureFreshIndex, openDb, rebuildIndex, searchIndex } from '../src/indexer/sqlite.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-index-freshness-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), 'project:\n  name: PPM\nmodules: {}\ncommands: {}\n', 'utf8');
  writeBacklog('BACKLOG-FIRST', 'Initial index record');
});

afterEach(() => {
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
