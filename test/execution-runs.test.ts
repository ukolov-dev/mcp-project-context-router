import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertRunEvidence, createAgentRun, getAgentRun, getRunSnapshot, listAgentRuns, recordRunVerification, transitionAgentRun } from '../src/execution/runs.js';
import { withRunLock } from '../src/execution/store.js';
import { confirmTaskContract } from '../src/task-validation/task.js';

let originalCwd: string;
let fixtureDir: string;
const taskId = 'TASK-20260915-100000-001';
const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function confirm(checks = ['node --test']) {
  confirmTaskContract({
    taskId, goal: 'Enable the fixture feature', scope: ['src/feature.js'], outOfScope: [],
    acceptanceCriteria: ['The feature is enabled.'], risks: [], testExpectations: checks, modules: ['app'],
  });
}

beforeEach(() => {
  originalCwd = process.cwd();
  fixtureDir = mkdtempSync(resolve(tmpdir(), 'router-execution-'));
  process.chdir(fixtureDir);
  mkdirSync(resolve(fixtureDir, '.project-context'), { recursive: true });
  mkdirSync(resolve(fixtureDir, 'src'));
  writeFileSync(resolve(fixtureDir, '.gitignore'), '.project-context/active/\n.project-context/drafts/\n.project-context/indexes/\n.project-context/trash/\ngenerated/\n');
  writeFileSync(resolve(fixtureDir, '.project-context/project.yaml'), 'project:\n  name: Execution Fixture\nmodules:\n  app:\n    path: src\n    aliases: [app]\n    playbooks: []\n');
  writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = false;\n');
  git('init', '-q');
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial fixture');
  confirm();
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(fixtureDir, { recursive: true, force: true });
});

function verifyingRun() {
  const run = createAgentRun({ taskId, executor: 'implementer-session' });
  transitionAgentRun({ runId: run.id, status: 'implementing' });
  return transitionAgentRun({ runId: run.id, status: 'verifying' });
}

function record(runId: string, status: 'passed' | 'failed' | 'skipped' | 'not_run' = 'passed', command?: string) {
  return recordRunVerification({ runId, expectedCodeDigest: getRunSnapshot(runId).codeDigest, summary: 'Fixture check result', checks: (command ? [command] : getAgentRun(runId).requiredChecks).map((command) => ({ command, status })) });
}

describe('execution manifests and evidence gates', () => {
  it('requires a confirmed task and concrete acceptance criteria, stores portable manifest provenance', () => {
    expect(() => createAgentRun({ taskId: 'TASK-MISSING', executor: 'worker' })).toThrow();
    const run = createAgentRun({ taskId, executor: 'worker' });
    expect(run).toMatchObject({ taskId, worktree: '.', executor: 'worker', attempt: 1, revision: 0, status: 'confirmed', finishedAt: null, result: null, acceptanceCriteria: [{ id: 'AC-1', text: 'The feature is enabled.' }] });
    expect(run.requiredChecks).toContain('node --test');
    expect(run.baseCommit).toBe(git('rev-parse', 'HEAD'));
    expect(run.history).toEqual([{ from: null, status: 'confirmed', at: run.createdAt }]);
    expect(readFileSync(resolve(fixtureDir, `.project-context/active/agent-runs/${run.id}.md`), 'utf8')).not.toContain(fixtureDir);
    expect(listAgentRuns({ taskId }).map((item) => item.id)).toEqual([run.id]);
    expect(listAgentRuns({ taskId: 'TASK-OTHER' })).toEqual([]);
    const taskPath = resolve(fixtureDir, `.project-context/active/tasks/${taskId}.md`);
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('- The feature is enabled.', 'Нет.'));
    expect(() => createAgentRun({ taskId, executor: 'worker' })).toThrow(/acceptance criteria/);
  });

  it('records failure reasons, protects terminal history and increments retry attempts', () => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    expect(() => transitionAgentRun({ runId: run.id, status: 'verifying' })).toThrow(/Invalid execution transition/);
    expect(() => transitionAgentRun({ runId: run.id, status: 'failed' })).toThrow(/reason/);
    const failed = transitionAgentRun({ runId: run.id, status: 'failed', reason: 'Worker exited with code 1', expectedRevision: 0 });
    expect(failed).toMatchObject({ status: 'failed', revision: 1, result: 'Worker exited with code 1' });
    expect(failed.finishedAt).toBeTruthy();
    expect(failed.history.at(-1)).toMatchObject({ from: 'confirmed', status: 'failed', reason: 'Worker exited with code 1' });
    expect(() => transitionAgentRun({ runId: run.id, status: 'implementing' })).toThrow(/Terminal runs are immutable/);
    expect(createAgentRun({ taskId, executor: 'worker-retry' }).attempt).toBe(2);
  });

  it('rejects stale revisions and overlapping writers', () => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    transitionAgentRun({ runId: run.id, status: 'implementing', expectedRevision: 0 });
    expect(() => transitionAgentRun({ runId: run.id, status: 'verifying', expectedRevision: 0 })).toThrow(/revision changed/);
    withRunLock(run.id, () => expect(() => transitionAgentRun({ runId: run.id, status: 'verifying' })).toThrow(/storage is busy/));
    expect(getAgentRun(run.id).status).toBe('implementing');
  });

  it('preserves the declared verification order for checks with setup dependencies', () => {
    confirm(['node z-prepare.cjs', 'node a-verify.cjs']);
    const run = createAgentRun({ taskId, executor: 'worker' });
    expect(run.requiredChecks.slice(0, 2)).toEqual(['node z-prepare.cjs', 'node a-verify.cjs']);
  });

  it.each(['failed', 'skipped', 'not_run'] as const)('does not enter reviewing with %s required checks', (status) => {
    const run = verifyingRun();
    const evidence = record(run.id, status);
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] })).toThrow(/verification|Verification/);
    expect(getAgentRun(run.id).status).toBe('verifying');
  });

  it('requires run-bound evidence and all required commands', () => {
    const run = verifyingRun();
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing' })).toThrow(/evidence/);
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: ['VERIFY-MISSING'] })).toThrow();
    const unrelatedCheck = record(run.id, 'passed', 'node --version');
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [unrelatedCheck.id] })).toThrow(/has not passed/);
    const otherRun = verifyingRun();
    const unrelatedRun = record(otherRun.id);
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [unrelatedRun.id] })).toThrow(/another run/);
    const evidence = record(run.id);
    const reviewing = transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] });
    expect(reviewing.evidenceIds).toEqual([evidence.id]);
    expect(reviewing.evidenceDigests[evidence.id]).toMatch(/^[a-f0-9]{64}$/);
    expect(() => transitionAgentRun({ runId: run.id, status: 'ready_to_merge' })).toThrow(/independent acceptance review/);
  });

  it('does not treat an empty verification plan as a passing gate', () => {
    const run = verifyingRun();
    const evidence = record(run.id);
    expect(() => assertRunEvidence({ ...run, requiredChecks: [] }, getRunSnapshot(run.id), [evidence.id])).toThrow(/No required verification checks/);
  });

  it('rejects stale evidence at record time and transition time', () => {
    const run = verifyingRun();
    const before = getRunSnapshot(run.id);
    const evidence = record(run.id);
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = true;\n');
    expect(() => recordRunVerification({ runId: run.id, expectedCodeDigest: before.codeDigest, summary: 'Stale result', checks: [{ command: 'node --test', status: 'passed' }] })).toThrow(/stale/);
    expect(() => transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] })).toThrow(/stale/);
  });

  it('invalidates execution on task or configured plan changes but permits recording failure', () => {
    const run = verifyingRun();
    confirm(['node --test', 'node --check src/feature.js']);
    expect(() => getRunSnapshot(run.id)).toThrow(/Task Contract or verification plan changed/);
    expect(getAgentRun(run.id).id).toBe(run.id);
    expect(transitionAgentRun({ runId: run.id, status: 'failed', reason: 'Worker changed the task contract.' }).status).toBe('failed');
    expect(createAgentRun({ taskId, executor: 'worker-retry' }).requiredChecks).toContain('node --check src/feature.js');
  });

  it('binds project configuration changes while excluding generated metadata', () => {
    const run = verifyingRun();
    const snapshot = getRunSnapshot(run.id);
    record(run.id);
    mkdirSync(resolve(fixtureDir, 'generated'));
    writeFileSync(resolve(fixtureDir, 'generated/build.log'), 'build output\n');
    expect(getRunSnapshot(run.id).codeDigest).toBe(snapshot.codeDigest);
    writeFileSync(resolve(fixtureDir, '.project-context/project.yaml'), 'project:\n  name: Renamed Fixture\nmodules:\n  app:\n    path: src\n    aliases: [app]\n    playbooks: []\n');
    expect(getRunSnapshot(run.id).codeDigest).not.toBe(snapshot.codeDigest);
  });

  it('captures committed, staged, unstaged and untracked changes and executable mode', () => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    const initial = getRunSnapshot(run.id);
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = true;\n');
    git('add', 'src/feature.js');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Enable feature');
    writeFileSync(resolve(fixtureDir, 'src/staged.js'), 'export const staged = true;\n');
    git('add', 'src/staged.js');
    writeFileSync(resolve(fixtureDir, 'src/staged.js'), 'export const staged = false;\n');
    writeFileSync(resolve(fixtureDir, 'src/untracked.js'), 'export const extra = true;\n');
    const snapshot = getRunSnapshot(run.id);
    expect(snapshot.codeDigest).not.toBe(initial.codeDigest);
    expect(snapshot.changedFiles).toEqual(['src/feature.js', 'src/staged.js', 'src/untracked.js']);
    expect(snapshot.diff).toContain('+export const enabled = true;');
    expect(snapshot.diff).toContain('+export const staged = false;');
    expect(snapshot.diff).toContain('+export const extra = true;');
    chmodSync(resolve(fixtureDir, 'src/untracked.js'), 0o755);
    expect(getRunSnapshot(run.id).codeDigest).not.toBe(snapshot.codeDigest);
  });

  it('redacts sensitive diff lines without dropping them from the snapshot digest', () => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    writeFileSync(resolve(fixtureDir, 'src/secret.txt'), 'password=super-sensitive-value\n');
    const snapshot = getRunSnapshot(run.id);
    expect(snapshot.diff).not.toContain('super-sensitive-value');
    expect(snapshot.diff).toContain('REDACTED');
    writeFileSync(resolve(fixtureDir, 'src/secret.txt'), 'password=another-sensitive-value\n');
    expect(getRunSnapshot(run.id).codeDigest).not.toBe(snapshot.codeDigest);
  });

  it('rejects unsafe IDs and symlink storage and external source reads', () => {
    expect(() => getAgentRun('../outside')).toThrow();
    const run = createAgentRun({ taskId, executor: 'worker' });
    symlinkSync(resolve(fixtureDir, '..'), resolve(fixtureDir, 'src/external'));
    expect(() => getRunSnapshot(run.id)).toThrow(/symlink escapes repository/);
    rmSync(resolve(fixtureDir, 'src/external'));
    const recordPath = resolve(fixtureDir, `.project-context/active/agent-runs/${run.id}.md`);
    rmSync(recordPath);
    symlinkSync(resolve(fixtureDir, 'src/feature.js'), recordPath);
    expect(() => getAgentRun(run.id)).toThrow(/symlink/);
  });

  it('rejects submodule snapshots instead of silently accepting incomplete verification', () => {
    const head = git('rev-parse', 'HEAD');
    git('update-index', '--add', '--cacheinfo', `160000,${head},vendor/submodule`);
    expect(() => createAgentRun({ taskId, executor: 'worker' })).toThrow(/submodules/);
  });

  it('does not execute configured clean filters or external diff commands during snapshots', () => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    writeFileSync(resolve(fixtureDir, '.gitattributes'), 'src/feature.js filter=fixture\n');
    git('config', 'filter.fixture.clean', 'touch clean-filter-ran; cat');
    git('config', 'filter.fixture.required', 'true');
    git('config', 'diff.external', 'touch external-diff-ran');
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = true;\n');
    const snapshot = getRunSnapshot(run.id);
    expect(snapshot.diff).toContain('+export const enabled = true;');
    expect(snapshot.changedFiles).not.toContain('clean-filter-ran');
    expect(() => readFileSync(resolve(fixtureDir, 'clean-filter-ran'))).toThrow();
    expect(() => readFileSync(resolve(fixtureDir, 'external-diff-ran'))).toThrow();
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('rejects snapshots hidden by the %s index flag', (flag) => {
    const run = createAgentRun({ taskId, executor: 'worker' });
    git('update-index', flag, 'src/feature.js');
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = true;\n');
    expect(() => getRunSnapshot(run.id)).toThrow(/assume-unchanged or skip-worktree/);
  });
});
