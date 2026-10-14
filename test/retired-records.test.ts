import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traceRequirement } from '../src/project-context/analytics.js';
import { proposeContextUpdateInputSchema, searchProjectContext } from '../src/project-context/project-context.js';
import { writeMarkdown, readRecords } from '../src/storage/markdown.js';
import { recordTypes, retiredRecordTypes } from '../src/storage/record-types.js';
import { promoteDraft } from '../src/promotion/promote.js';
import { archiveRecords, restore } from '../src/gc/gc.js';
import { initializeProjectContext } from '../src/scaffold/init.js';
import { buildContextPack } from '../src/context-pack/pack.js';

let cwd: string;
let root: string;
beforeEach(() => { cwd = process.cwd(); root = mkdtempSync(resolve(tmpdir(), 'router-record-retirement-')); process.chdir(root); });
afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });
function record(segment: string, id: string, type: string, fields = {}, body = '') {
  writeMarkdown(resolve(root, `.project-context/${segment}/${id}.md`), {
    id, type, title: id, status: 'draft', created_at: '2026-10-14T12:00:00Z', ...fields,
  }, body);
}

describe('requirement task links', () => {
  it('uses exact IDs or declared task keys, never prefixes or prose mentions', () => {
    record('active/requirements', 'REQUIREMENT-20261014-001', 'requirement', { requirement_key: 'REQ-1', task_keys: ['TASK-20261014-001', 'TASK-022', 'TASK-023'] });
    record('active/tasks', 'TASK-20261014-001', 'task');
    record('active/tasks', 'TASK-20261014-0010', 'task');
    record('active/tasks', 'TASK-20261014-002', 'task', {}, 'Depends on TASK-20261014-001 and TASK-022');
    record('active/tasks', 'TASK-20261014-003', 'task', { task_key: 'TASK-022' });
    record('active/backlog', 'BACKLOG-RP', 'backlog', { task_keys: ['TASK-023'] });
    record('active/tasks', 'TASK-20261014-004', 'task', { task_key: 'TASK-0220' });
    expect(traceRequirement({ requirementKey: 'REQ-1' }).traces[0]?.tasks.map((task) => task.id).sort())
      .toEqual(['BACKLOG-RP', 'TASK-20261014-001', 'TASK-20261014-003']);
  });
});

describe('retired record types', () => {
  it.each(retiredRecordTypes)('keeps %s readable and archivable while refusing new proposals, promotions and restores', (type) => {
    expect(recordTypes).not.toContain(type);
    expect(proposeContextUpdateInputSchema.safeParse({ type, title: 'Old knowledge', summary: 'Details' }).success).toBe(false);
    record('drafts/legacy', 'LEGACY-001', type);
    expect(searchProjectContext({ types: [type], includeDrafts: true }).records[0]?.type).toBe(type);
    expect(() => promoteDraft({ recordId: 'LEGACY-001', apply: true, approvedBy: 'reviewer' })).toThrow('retired');
    expect(readRecords()[0]?.path).toContain('/drafts/');
    expect(archiveRecords(['LEGACY-001']).archived).toHaveLength(1);
    expect(readRecords(true)[0]?.archived).toBe(true);
    expect(() => restore('LEGACY-001')).toThrow('retired');
  });

  it.each(['current', 'fts5'] as const)('hides retired records from default %s packs but keeps explicit history readable', (searchEngine) => {
    initializeProjectContext({ modules: [{ name: 'app', path: 'src' }] });
    mkdirSync(resolve(root, 'src'), { recursive: true });
    record('active/legacy', 'LEGACY-API', 'api', { status: 'active', modules: ['app'] }, 'LegacyReference');
    const input = { query: 'LegacyReference', modules: ['app'], searchEngine };
    expect(buildContextPack(input).records.some((r) => r.id === 'LEGACY-API')).toBe(false);
    expect(buildContextPack({ ...input, includeHistory: true }).records.some((r) => r.id === 'LEGACY-API')).toBe(true);
  });
});
