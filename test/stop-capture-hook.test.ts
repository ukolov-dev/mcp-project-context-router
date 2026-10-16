import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/storage/markdown.js';

const hooks = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks');
let root: string;
const session = 'test-session';
const stateFile = () => resolve(root, '.project-context/indexes/hook-state', `${createHash('sha256').update(session).digest('hex')}.json`);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
const write = (file: string, text: string) => { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), text); };
function hook(script = 'stop-capture.js', input: Record<string, unknown> = {}) {
  const result = spawnSync(process.execPath, [resolve(hooks, script)], {
    cwd: resolve(root, 'src'), encoding: 'utf8', input: JSON.stringify({ cwd: resolve(root, 'src'), session_id: session, ...input }),
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  return result.stdout ? JSON.parse(result.stdout) : undefined;
}
function task(id = 'TASK-ONE', extra: Record<string, unknown> = {}, files = ['src/a.ts']) {
  write(`.project-context/active/tasks/${id}.md`, renderMarkdown({ id, type: 'task', title: id, status: 'confirmed', confirmed_by_human: true, modules: ['app'], files, ...extra }, '## Verification Plan\n\n- `npm test`'));
}
function finish(checks: unknown[] = [{ command: 'npm test', status: 'passed' }], extra: Record<string, unknown> = {}) {
  const timestamp = new Date().toISOString();
  write('.project-context/active/verification/VERIFY-ONE.md', renderMarkdown({
    id: 'VERIFY-ONE', type: 'verification-evidence', title: 'Checks', status: 'passed', created_at: timestamp, target_id: 'TASK-ONE', checks: [...checks, { command: 'project-context lint', status: 'passed' }, { command: 'project-context index --check', status: 'passed' }],
  }, 'Verification'));
  task('TASK-ONE', { finalized_at: timestamp, completion: 'partial', last_result: { summary: 'Implemented', skipped_checks: [] }, ...extra });
}
beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'router-hook-test-'));
  git('init', '-q');
  write('.gitignore', '.project-context/indexes/\nnode_modules/\n');
  write('src/a.ts', 'export const a = 1;\n');
  write('.project-context/project.yaml', 'project:\n  name: Test\nmodules:\n  app:\n    path: src\ncommands: {}\n');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'Initial');
  write('src/a.ts', 'export const a = 2;\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('lifecycle verification boundary', () => {
  it('uses exact declared files and explicit human confirmation', () => {
    task('TASK-PROSE', {}, ['src/another.ts']);
    task('TASK-DRAFT', { confirmed_by_human: false });
    expect(hook()).toBeUndefined();
    task();
    expect(hook().reason).toContain('TASK-ONE');
  });
  it('keeps blocking repeated Stops, including continuation turns', () => {
    task();
    expect(hook().decision).toBe('block');
    expect(hook('stop-capture.js', { stop_hook_active: true }).decision).toBe('block');
  });
  it('requires real evidence as well as a finalization timestamp', () => {
    task('TASK-ONE', { finalized_at: new Date().toISOString(), last_result: { summary: 'Done' } });
    expect(hook().decision).toBe('block');
    finish();
    expect(hook()).toBeUndefined();
  });
  it('does not invalidate checks on reads, task records or finalization calls', () => {
    task(); hook('post-tool-use.js'); finish();
    const before = readFileSync(stateFile(), 'utf8');
    hook('post-tool-use.js', { tool_name: 'mcp__project_context__finalize_work' });
    expect(readFileSync(stateFile(), 'utf8')).toBe(before);
    expect(hook()).toBeUndefined();
    expect(hook()).toBeUndefined();
    expect(existsSync(stateFile())).toBe(true);
  });
  it('invalidates evidence when file contents change after finalization', () => {
    task(); hook('post-tool-use.js'); finish();
    expect(hook()).toBeUndefined();
    write('src/a.ts', 'export const a = 3;\n');
    expect(hook().decision).toBe('block');
  });
  it('invalidates a task completed during the session without reopening historical tasks', () => {
    task('TASK-HISTORICAL', { status: 'done', finalized_at: '2000-01-01T00:00:00Z' });
    task(); hook('post-tool-use.js'); finish();
    const taskFile = resolve(root, '.project-context/active/tasks/TASK-ONE.md');
    writeFileSync(taskFile, readFileSync(taskFile, 'utf8').replace('status: confirmed', 'status: done'));
    expect(hook()).toBeUndefined();
    write('src/a.ts', 'export const a = 4;\n');
    const result = hook();
    expect(result.reason).toContain('TASK-ONE');
    expect(result.reason).not.toContain('TASK-HISTORICAL');
  });
  it('adapts Stop feedback for ZCode CLI and desktop without changing successful stops', () => {
    task();
    const result = hook('zcode-stop.js');
    expect(result.decision).toBe('block');
    expect(result.continue).toBe(true);
    expect(result.hookSpecificOutput).toEqual({ hookEventName: 'Stop', additionalContext: result.reason });
    finish();
    expect(hook('zcode-stop.js')).toBeUndefined();
  });
  it('does not let one finalized task hide another matching task', () => {
    task(); task('TASK-TWO'); hook('post-tool-use.js'); finish();
    expect(hook().reason).toContain('TASK-TWO');
  });
  it('requires a reason for unresolved required checks even with default partial', () => {
    task(); hook('post-tool-use.js');
    finish([{ command: 'npm test', status: 'not_run', reason: 'Required by verification plan; no evidence supplied.' }]);
    expect(hook().decision).toBe('block');
    finish([{ command: 'npm test', status: 'failed', reason: 'Test database is unavailable.' }], { completion: 'blocked' });
    expect(hook()).toBeUndefined();
  });
  it('accepts explicit skippedChecks from the finalize_work schema', () => {
    task(); hook('post-tool-use.js');
    finish([], { last_result: { summary: 'Partial implementation', skipped_checks: [{ command: 'npm test', reason: 'Database offline' }] } });
    expect(hook()).toBeUndefined();
    task('TASK-ONE', { finalized_at: new Date().toISOString(), completion: 'partial', last_result: { summary: 'Partial', skipped_checks: [{ command: 'other check', reason: 'offline' }] } });
    expect(hook().decision).toBe('block');
  });
  it('captures staged files, untracked files, deletion and patch paths together', () => {
    git('add', 'src/a.ts'); write('src/new.py', 'def example(): pass\n');
    write('src/deleted.ts', 'gone'); git('add', 'src/deleted.ts'); unlinkSync(resolve(root, 'src/deleted.ts'));
    hook('post-tool-use.js', { tool_input: { patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** End Patch' } });
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(state.changedFiles).toEqual(['src/a.ts', 'src/deleted.ts', 'src/new.py']);
    expect(state.fingerprints['src/deleted.ts']).toBe('deleted');
  });
  it('rejects stale or wrong-target evidence and results saved before verification', () => {
    task(); hook('post-tool-use.js'); finish();
    const evidence = resolve(root, '.project-context/active/verification/VERIFY-ONE.md');
    writeFileSync(evidence, readFileSync(evidence, 'utf8').replace('target_id: TASK-ONE', 'target_id: TASK-TWO'));
    expect(hook().decision).toBe('block');
    finish(); task('TASK-ONE', { finalized_at: '2000-01-01T00:00:00Z', last_result: { summary: 'Old' } });
    expect(hook().decision).toBe('block');
  });
  it('hashes untrusted session IDs and rejects symlinked hook storage', () => {
    hook('post-tool-use.js', { session_id: '../../escape' });
    expect(existsSync(resolve(root, '.project-context/escape.json'))).toBe(false);
    rmSync(resolve(root, '.project-context/indexes/hook-state'), { recursive: true });
    const external = mkdtempSync(resolve(tmpdir(), 'router-hook-outside-'));
    try {
      symlinkSync(external, resolve(root, '.project-context/indexes/hook-state'), 'junction');
      expect(hook().decision).toBe('block');
      expect(existsSync(resolve(external, `${session}.json`))).toBe(false);
    } finally { rmSync(external, { recursive: true, force: true }); }
  });
  it('recovers corrupt state conservatively and uses configured tool names', () => {
    task(); hook('post-tool-use.js');
    writeFileSync(stateFile(), '{broken');
    write('.project-context/project.yaml', 'context_router:\n  mcp_server_name: custom_context\n  brand:\n    logo_text: "[Custom]"\n');
    const result = hook();
    expect(result.decision).toBe('block');
    expect(result.reason).toContain('custom_context.finalize_work');
    expect(result.reason).toContain('[Custom]');
  });
});
