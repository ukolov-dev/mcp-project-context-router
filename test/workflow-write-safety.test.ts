import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveStale, restore } from '../src/gc/gc.js';
import { writeMarkdown } from '../src/storage/markdown.js';
import { confirmTaskContract, confirmTaskInputSchema, validateTask } from '../src/task-validation/task.js';

let originalCwd: string;
let root: string;
let external: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'router-write-safety-'));
  external = mkdtempSync(resolve(tmpdir(), 'router-write-external-'));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

function task(path: string, body: string, createdAt = new Date().toISOString()): string {
  const absolute = resolve(root, path);
  writeMarkdown(absolute, {
    id: basename(path, '.md'), type: 'task', status: 'confirmed', title: 'Storage safety',
    confirmed_by_human: true, created_at: createdAt, updated_at: createdAt,
    modules: [], files: [], tags: [], retention: 'normal',
  }, body);
  return absolute;
}

describe('task confirmation write boundaries', () => {
  it('rejects traversal IDs without overwriting an existing repository file', () => {
    const readme = resolve(root, 'README.md');
    writeFileSync(readme, 'original README');

    expect(() => confirmTaskContract({ taskId: '../../../README', goal: 'Unsafe task' })).toThrow();

    expect(readFileSync(readme, 'utf8')).toBe('original README');
    expect(existsSync(resolve(root, '.project-context'))).toBe(false);
  });

  it.each(['', '../TASK', '..\\TASK', '/absolute', 'C:\\outside', 'TASK.md'])('rejects unsafe task ID %j at the input boundary', (taskId) => {
    expect(confirmTaskInputSchema.safeParse({ taskId, goal: 'Unsafe task' }).success).toBe(false);
  });

  it.each(['active/tasks', 'trash'])('rejects a symlinked %s directory before promoting the draft', (directory) => {
    const draft = validateTask('Update a local note');
    const source = resolve(root, '.project-context/drafts/tasks', `${draft.taskDraftId}.md`);
    const original = readFileSync(source, 'utf8');
    const link = resolve(root, '.project-context', directory);
    mkdirSync(resolve(link, '..'), { recursive: true });
    symlinkSync(external, link, 'dir');

    expect(() => confirmTaskContract({ taskId: draft.taskDraftId, goal: 'Update a local note' })).toThrow(/symlink/i);

    expect(readFileSync(source, 'utf8')).toBe(original);
    expect(readdirSync(external)).toEqual([]);
    expect(existsSync(resolve(root, '.project-context/active/tasks', `${draft.taskDraftId}.md`))).toBe(false);
  });

  it('rejects a dangling target symlink without creating its external destination', () => {
    const target = resolve(root, '.project-context/active/tasks/TASK-DANGLING.md');
    const destination = resolve(external, 'not-created.md');
    mkdirSync(resolve(target, '..'), { recursive: true });
    symlinkSync(destination, target);

    expect(() => confirmTaskContract({ taskId: 'TASK-DANGLING', goal: 'Unsafe task' })).toThrow(/symlink/i);

    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });
});

describe('archive duration validation', () => {
  it.each(['90days', '', '0d', '-1d', '1.5d', 'Infinityd', `${'9'.repeat(400)}d`])('rejects invalid duration %j before moving any record', (duration) => {
    const source = task('.project-context/active/tasks/TASK-RESTORE.md', 'Keep this active', '2000-01-01T00:00:00Z');
    const original = readFileSync(source, 'utf8');

    expect(() => archiveStale(duration)).toThrow(/duration/i);

    expect(readFileSync(source, 'utf8')).toBe(original);
    expect(existsSync(resolve(root, '.project-context/archive'))).toBe(false);
  });

  it('still accepts a positive day duration and only archives old records', () => {
    const old = task('.project-context/active/tasks/TASK-RESTORE.md', 'Old task', '2000-01-01T00:00:00Z');
    const fresh = task('.project-context/active/tasks/TASK-FRESH.md', 'Fresh task');
    const result = archiveStale(' 90D ');

    expect(result.archived).toHaveLength(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
});

describe('archive restoration', () => {
  it('rejects an archived ID that escapes its active record directory', () => {
    const archived = resolve(root, '.project-context/archive/2000/tasks/unsafe-id.md');
    writeMarkdown(archived, {
      id: '../../../created-from-archive', type: 'task', status: 'confirmed', title: 'Unsafe archived ID',
    }, 'Keep the archived content');
    const original = readFileSync(archived, 'utf8');

    expect(() => restore('../../../created-from-archive')).toThrow(/directory|id|path/i);

    expect(readFileSync(archived, 'utf8')).toBe(original);
    expect(existsSync(resolve(root, 'created-from-archive.md'))).toBe(false);
    expect(existsSync(resolve(root, '.project-context/active'))).toBe(false);
  });

  it('preserves both versions when an active target already exists', () => {
    const archived = task('.project-context/archive/2000/tasks/TASK-RESTORE.md', 'Archived task');
    const active = task('.project-context/active/tasks/TASK-RESTORE.md', 'New active task');
    const archivedBefore = readFileSync(archived, 'utf8');
    const activeBefore = readFileSync(active, 'utf8');

    expect(() => restore('TASK-RESTORE')).toThrow(/exists/i);

    expect(readFileSync(archived, 'utf8')).toBe(archivedBefore);
    expect(readFileSync(active, 'utf8')).toBe(activeBefore);
  });

  it('preserves the archive and a dangling target symlink', () => {
    const archived = task('.project-context/archive/2000/tasks/TASK-RESTORE.md', 'Archived task');
    const archivedBefore = readFileSync(archived, 'utf8');
    const active = resolve(root, '.project-context/active/tasks/TASK-RESTORE.md');
    const destination = resolve(external, 'not-created.md');
    mkdirSync(resolve(active, '..'), { recursive: true });
    symlinkSync(destination, active);

    expect(() => restore('TASK-RESTORE')).toThrow(/symlink|exists/i);

    expect(readFileSync(archived, 'utf8')).toBe(archivedBefore);
    expect(lstatSync(active).isSymbolicLink()).toBe(true);
    expect(existsSync(destination)).toBe(false);
  });

  it('rejects a symlinked target directory without moving the archive outside the repository', () => {
    const archived = task('.project-context/archive/2000/tasks/TASK-RESTORE.md', 'Archived task');
    const archivedBefore = readFileSync(archived, 'utf8');
    mkdirSync(resolve(root, '.project-context/active'), { recursive: true });
    symlinkSync(external, resolve(root, '.project-context/active/tasks'), 'dir');

    expect(() => restore('TASK-RESTORE')).toThrow(/symlink/i);

    expect(readFileSync(archived, 'utf8')).toBe(archivedBefore);
    expect(readdirSync(external)).toEqual([]);
  });

  it('restores an absent target without changing the archived content', () => {
    const archived = task('.project-context/archive/2000/tasks/TASK-RESTORE.md', 'Archived task');
    const original = readFileSync(archived, 'utf8');

    const result = restore('TASK-RESTORE');

    expect(result.restoredPath).toBe('.project-context/active/tasks/TASK-RESTORE.md');
    expect(readFileSync(resolve(root, result.restoredPath), 'utf8')).toBe(original);
    expect(existsSync(archived)).toBe(false);
  });

  it('keeps legacy IDs that are safe file names restorable', () => {
    const id = 'LEGACY.task-старый';
    const archived = task(`.project-context/archive/2000/tasks/${id}.md`, 'Legacy task');
    const original = readFileSync(archived, 'utf8');

    const result = restore(id);

    expect(result.restoredPath).toBe(`.project-context/active/tasks/${id}.md`);
    expect(readFileSync(resolve(root, result.restoredPath), 'utf8')).toBe(original);
    expect(existsSync(archived)).toBe(false);
  });
});
