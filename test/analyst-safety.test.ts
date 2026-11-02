import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildAnalystContextPack,
  findRequirements,
  findSourceChunks,
  getConflicts,
  getOpenQuestions,
  traceRequirement,
} from '../src/project-context/analytics.js';
import { proposeAnalystSource } from '../src/project-context/rp-import.js';
import * as markdown from '../src/storage/markdown.js';

let previous: string;
let root: string;
const secret = 'sensitive-value-'.repeat(3);

beforeEach(() => {
  previous = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'router-analyst-safety-'));
  process.chdir(root);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-02T10:00:00Z'));
  mkdirSync(resolve(root, '.project-context'), { recursive: true });
  writeFileSync(resolve(root, '.project-context/project.yaml'), 'project:\n  name: Analyst safety\nmodules:\n  docs:\n    path: docs\ncommands: {}\n');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  process.chdir(previous);
  rmSync(root, { recursive: true, force: true });
});

function record(id: string, type: string, fields: Record<string, unknown> = {}) {
  const path = resolve(root, `.project-context/active/records/${id}.md`);
  markdown.writeMarkdown(path, {
    id, type, title: 'Routing evidence', status: 'active', modules: [], ...fields,
  }, `Routing evidence.\npassword: ${secret}\nSafe source details.`);
  return path;
}

describe('analyst excerpt safety', () => {
  it.each([
    ['requirements', 'requirement', () => findRequirements({ query: 'routing' })],
    ['source chunks', 'source_chunk', () => findSourceChunks({ query: 'routing' })],
    ['open questions', 'open_question', () => getOpenQuestions({ query: 'routing' })],
    ['conflicts', 'open_question', () => getConflicts({ query: 'routing' })],
  ] as const)('redacts secrets from %s before shortening the excerpt', (_name, type, search) => {
    const path = record('RECORD', type, { question_kind: 'conflict' });

    const result = search();

    expect(result.records).toHaveLength(1);
    expect(result.records[0].excerpt).toContain('[REDACTED: secret-like assignment]');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(readFileSync(path, 'utf8')).toContain(secret);
  });

  it('redacts linked trace records and analyst packs through the shared excerpt helper', () => {
    record('REQ', 'requirement', { requirement_key: 'REQ-1', source_ids: ['SRC-1'], chunk_ids: ['CHUNK-1'], task_keys: ['TASK-1'] });
    record('SOURCE', 'source', { source_id: 'SRC-1' });
    record('CHUNK', 'source_chunk', { source_id: 'SRC-1', chunk_id: 'CHUNK-1' });
    record('TASK-1', 'task');
    record('DECISION', 'decision');

    const trace = traceRequirement({ requirementKey: 'REQ-1' });
    const pack = buildAnalystContextPack({ query: 'routing' });

    expect(trace.traces[0].sources).toHaveLength(1);
    expect(trace.traces[0].chunks).toHaveLength(1);
    expect(trace.traces[0].tasks).toHaveLength(1);
    expect(pack.decisions).toHaveLength(1);
    expect(JSON.stringify([trace, pack])).not.toContain(secret);
  });
});

describe('analyst source draft safety', () => {
  it('keeps distinct sources that previously mapped to the same draft path', () => {
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    markdown.writeMarkdown(resolve(root, 'docs/input.md'), {}, 'Input document.');
    const first = proposeAnalystSource({ sourceId: 'SRC-0', title: 'First source', summary: 'First summary.', sourcePath: 'docs/input.md', apply: true });
    const firstText = readFileSync(resolve(root, first.record.path), 'utf8');

    const second = proposeAnalystSource({ sourceId: 'SRC-84', title: 'Second source', summary: 'Second summary.', sourcePath: 'docs/input.md', apply: true });

    expect(second.record.id).not.toBe(first.record.id);
    expect(second.record.path).not.toBe(first.record.path);
    expect(readFileSync(resolve(root, first.record.path), 'utf8')).toBe(firstText);
    expect(markdown.parseRecord(resolve(root, first.record.path)).frontmatter.source_id).toBe('SRC-0');
    expect(markdown.parseRecord(resolve(root, second.record.path)).frontmatter.source_id).toBe('SRC-84');
  });

  it('creates a source without the optional sourcePath and preserves earlier proposals', () => {
    const input = { sourceId: 'LOGICAL-SOURCE', title: 'Incoming source', summary: 'Review this document.', apply: true };
    const first = proposeAnalystSource(input);
    const firstText = readFileSync(resolve(root, first.record.path), 'utf8');

    const second = proposeAnalystSource({ ...input, summary: 'A different proposal.' });

    expect(second.record.id).not.toBe(first.record.id);
    expect(readFileSync(resolve(root, first.record.path), 'utf8')).toBe(firstText);
    expect(markdown.parseRecord(resolve(root, second.record.path))).toMatchObject({ files: [], frontmatter: { source_id: 'LOGICAL-SOURCE' } });
    expect(markdown.parseRecord(resolve(root, second.record.path)).frontmatter).not.toHaveProperty('source_path');
  });

  it('rejects a raced destination instead of overwriting the existing draft', () => {
    mkdirSync(resolve(root, 'docs'), { recursive: true });
    markdown.writeMarkdown(resolve(root, 'docs/input.md'), {}, 'Input document.');
    const input = { title: 'Incoming source', summary: 'Keep this proposal.', sourcePath: 'docs/input.md', apply: true };
    const first = proposeAnalystSource(input);
    const firstText = readFileSync(resolve(root, first.record.path), 'utf8');
    vi.spyOn(markdown, 'nextRecordId').mockReturnValue(first.record.id);

    expect(() => proposeAnalystSource({ ...input, summary: 'Do not overwrite.' })).toThrow();

    expect(readFileSync(resolve(root, first.record.path), 'utf8')).toBe(firstText);
  });

  it('rejects a symlinked source directory before writing outside the repository', () => {
    const external = mkdtempSync(resolve(tmpdir(), 'router-analyst-external-'));
    const link = resolve(root, '.project-context/drafts/sources');
    mkdirSync(resolve(link, '..'), { recursive: true });
    symlinkSync(external, link, 'dir');
    try {
      expect(() => proposeAnalystSource({ title: 'Incoming source', summary: 'Keep this inside the repository.', apply: true })).toThrow(/symlink/i);

      expect(readdirSync(external)).toEqual([]);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});
