import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTaskRun, planTaskRun, runAdapterSchema } from '../src/execution/runner.js';
import { confirmTaskContract } from '../src/task-validation/task.js';

const taskId = 'TASK-20260915-000001-001';
const passingReviewer = `
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const bundle = JSON.parse(input);
  const evidenceId = bundle.evidence[0].id;
  process.stdout.write(JSON.stringify({
    verdict: 'passed',
    criteria: bundle.run.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'passed',
      implementationEvidence: 'The diff introduces the expected answer export in answer.js.',
      verificationEvidence: evidenceId + ': required local checks passed.',
    })),
    findings: [],
  }));
});
`;
const implementation = `
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', async () => {
  const payload = JSON.parse(input);
  if (payload.stage !== 'implementation' || !payload.contextPack || !payload.task) process.exit(2);
  const fs = await import('node:fs');
  fs.writeFileSync('answer.js', 'export const answer = 42;\\n');
});
`;

let fixture: string;
let previousCwd: string;

beforeEach(() => {
  previousCwd = process.cwd();
  fixture = mkdtempSync(resolve(tmpdir(), 'context-execution-runner-'));
  process.chdir(fixture);
  execFileSync('git', ['init', '-q'], { cwd: fixture });
  mkdirSync(resolve(fixture, '.project-context'), { recursive: true });
  writeFileSync(resolve(fixture, '.gitignore'), '.project-context/\n');
  writeFileSync(resolve(fixture, 'answer.js'), 'export const answer = 0;\n');
  writeFileSync(resolve(fixture, 'verify.cjs'), `const fs = require('node:fs'); if (!fs.readFileSync('answer.js', 'utf8').includes('answer = 42')) process.exit(1);\n`);
  writeFileSync(resolve(fixture, '.project-context/project.yaml'), `project:
  name: Generic execution fixture
routing:
  default_modules: [source]
modules:
  source:
    path: .
    source_globs: ["*.js", "*.cjs"]
    playbooks: []
commands:
  context_lint: node -e "process.exit(0)"
  context_index: node -e "process.exit(0)" --
`);
  execFileSync('git', ['add', '.gitignore', 'answer.js', 'verify.cjs'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=Test Runner', '-c', 'user.email=runner@example.invalid', 'commit', '-qm', 'fixture'], { cwd: fixture });
  confirmTaskContract({
    taskId,
    goal: 'Return the requested answer',
    scope: ['Update the exported answer'],
    outOfScope: [],
    acceptanceCriteria: ['The answer export is 42'],
    risks: [],
    testExpectations: ['node verify.cjs'],
    modules: ['source'],
    files: ['answer.js'],
    tags: [],
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.chdir(previousCwd);
  rmSync(fixture, { recursive: true, force: true });
});

function adapter(overrides: Partial<ReturnType<typeof runAdapterSchema.parse>> = {}) {
  return {
    executor: 'fixture-implementer',
    reviewer: 'fixture-reviewer',
    implementation: { command: process.execPath, args: ['-e', implementation] },
    review: { command: process.execPath, args: ['-e', passingReviewer] },
    timeoutMs: 5_000,
    ...overrides,
  };
}

function filesUnder(relative: string): string[] {
  const full = resolve(fixture, relative);
  if (!existsSync(full)) return [];
  return readdirSync(full, { recursive: true }).map(String).sort();
}

describe('optional task execution CLI adapter', () => {
  it('plans the exact argv and required checks without launching commands or changing context state', () => {
    const before = filesUnder('.project-context');
    const plan = planTaskRun({ taskId, adapter: adapter() });

    expect(plan.dryRun).toBe(true);
    expect(plan.requiredChecks).toContain('node verify.cjs');
    expect(plan.adapter.implementation.args).toEqual(['-e', implementation]);
    expect(readFileSync(resolve(fixture, 'answer.js'), 'utf8')).toContain('answer = 0');
    expect(filesUnder('.project-context')).toEqual(before);
  });

  it('runs an implementation, real required checks and independent acceptance review for the same snapshot', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter() });

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'READY_TO_MERGE', run: { status: 'ready_to_merge' } });
    expect(result.steps.map((step) => step.stage)).toEqual(['implementation', 'verification', 'verification', 'verification', 'review']);
    expect(result.steps.every((step) => step.status === 'passed' && step.exitCode === 0)).toBe(true);
    expect(result.run.evidenceIds).toHaveLength(1);
    expect(readFileSync(resolve(fixture, 'answer.js'), 'utf8')).toContain('answer = 42');
  });

  it('refreshes the router index after run transitions before real default lint and index checks', async () => {
    vi.stubEnv('CONTEXT_EXECUTION_FIXTURE_SOURCE', previousCwd);
    writeFileSync(resolve(fixture, 'router.cjs'), `
const path = require('node:path');
const root = process.env.CONTEXT_EXECUTION_FIXTURE_SOURCE;
const result = require('node:child_process').spawnSync(process.execPath, [
  '--import', path.join(root, 'node_modules/tsx/dist/loader.mjs'),
  path.join(root, 'src/cli.ts'), ...process.argv.slice(2),
], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    const config = resolve(fixture, '.project-context/project.yaml');
    writeFileSync(config, readFileSync(config, 'utf8')
      .replace('context_lint: node -e "process.exit(0)"', 'context_lint: node router.cjs lint')
      .replace('context_index: node -e "process.exit(0)" --', 'context_index: node router.cjs index'));

    const result = await executeTaskRun({ taskId, adapter: adapter() });

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'READY_TO_MERGE', run: { status: 'ready_to_merge' } });
    expect(result.run.requiredChecks).toContain('node router.cjs index --check');
    expect(result.run.requiredChecks).toContain('node router.cjs lint');
    expect(result.steps.filter((step) => step.stage === 'verification').every((step) => step.status === 'passed')).toBe(true);
  });

  it('records a launch failure without proceeding to checks or review', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: { command: 'no-such-context-worker-fixture', args: [] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps).toMatchObject([{ stage: 'implementation', status: 'launch_error', exitCode: null }]);
  });

  it('does not review when implementation exits nonzero', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: { command: process.execPath, args: ['-e', 'process.exit(9)'] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps).toMatchObject([{ stage: 'implementation', status: 'failed', exitCode: 9 }]);
  });

  it('preserves the original failure when a worker corrupts its manifest', async () => {
    const worker = `let input = ''; process.stdin.on('data', (chunk) => input += chunk); process.stdin.on('end', () => {
      const payload = JSON.parse(input);
      require('node:fs').writeFileSync('.project-context/active/agent-runs/' + payload.runId + '.md', 'broken metadata');
      process.exit(9);
    });`;
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: { command: process.execPath, args: ['-e', worker] } }) });

    expect(result.status).toBe('FAILED');
    expect(result.error).toContain('exit=9');
    expect(result).toHaveProperty('persistenceError', expect.stringContaining('Unable to persist failed run status'));
    expect(result.run.status).toBe('implementing');
  });

  it('stops verification on interruption before launching the remaining checks', async () => {
    writeFileSync(resolve(fixture, 'a-interrupt.cjs'), `require('node:fs').writeFileSync('.project-context/check-started', 'ready'); setInterval(() => {}, 1000);`);
    const taskPath = resolve(fixture, `.project-context/active/tasks/${taskId}.md`);
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('- node verify.cjs', '- node a-interrupt.cjs\n- node verify.cjs'));
    const pending = executeTaskRun({ taskId, adapter: adapter() });
    await vi.waitFor(() => expect(existsSync(resolve(fixture, '.project-context/check-started'))).toBe(true), { timeout: 3_000 });
    process.emit('SIGINT');
    const result = await pending;

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps.at(-1)).toMatchObject({ stage: 'verification', status: 'interrupted' });
    expect(result.steps).toHaveLength(2);
    expect(result.steps.some((step) => step.stage === 'review')).toBe(false);
  });

  it('records failed required checks and never invokes review', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: { command: process.execPath, args: ['-e', 'process.stdin.resume()'] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps.some((step) => step.stage === 'verification' && step.exitCode === 1)).toBe(true);
    expect(result.steps.some((step) => step.stage === 'review')).toBe(false);
  });

  it('runs prerequisite checks in the order declared by the Task Contract', async () => {
    writeFileSync(resolve(fixture, 'z-prepare.cjs'), `require('node:fs').writeFileSync('.project-context/check-order', 'ready');`);
    writeFileSync(resolve(fixture, 'a-consume.cjs'), `if (require('node:fs').readFileSync('.project-context/check-order', 'utf8') !== 'ready') process.exit(1);`);
    const taskPath = resolve(fixture, `.project-context/active/tasks/${taskId}.md`);
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('- node verify.cjs', '- node z-prepare.cjs\n- node a-consume.cjs\n- node verify.cjs'));

    const result = await executeTaskRun({ taskId, adapter: adapter() });

    expect(result, JSON.stringify(result)).toMatchObject({ status: 'READY_TO_MERGE', run: { status: 'ready_to_merge' } });
    expect(result.run.requiredChecks.slice(0, 2)).toEqual(['node z-prepare.cjs', 'node a-consume.cjs']);
  });

  it('refuses automatic acceptance when the complete diff cannot fit the review bundle', async () => {
    writeFileSync(resolve(fixture, 'large-change.txt'), 'unreviewed source change\n'.repeat(10_000));
    const reviewer = `require('node:fs').writeFileSync('.project-context/reviewer-invoked', 'yes');\n${passingReviewer}`;

    const result = await executeTaskRun({ taskId, adapter: adapter({ review: { command: process.execPath, args: ['-e', reviewer] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.error).toContain('complete diff exceeds the automatic review limit');
    expect(result.error).toContain('manual acceptance reviewer');
    expect(result.steps.some((step) => step.stage === 'review')).toBe(false);
    expect(existsSync(resolve(fixture, '.project-context/reviewer-invoked'))).toBe(false);
  });

  it('rejects reviewer prose and forged provenance instead of accepting a passing claim', async () => {
    for (const output of ['The task passed.', JSON.stringify({ verdict: 'passed', criteria: [], findings: [], codeDigest: 'forged' })]) {
      const result = await executeTaskRun({ taskId, adapter: adapter({ review: { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(output)})`] } }) });
      expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
      expect(result.steps.at(-1)?.stage).toBe('review');
    }
  });

  it('does not accept otherwise-valid review JSON from a process that exits nonzero', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ review: { command: process.execPath, args: ['-e', `${passingReviewer}\nprocess.exitCode = 4;`] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps.at(-1)).toMatchObject({ stage: 'review', status: 'failed', exitCode: 4 });
  });

  it('rejects a passing reviewer that changed the code instead of reviewing the frozen snapshot', async () => {
    const mutatingReviewer = `${passingReviewer}\nrequire('node:fs').writeFileSync('answer.js', 'export const answer = 99;\\n');`;
    const result = await executeTaskRun({ taskId, adapter: adapter({ review: { command: process.execPath, args: ['-e', mutatingReviewer] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.error).toMatch(/digest|snapshot|stale/);
  });

  it('passes implementation arguments literally without interpreting shell syntax', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: {
      command: process.execPath,
      args: ['-e', implementation, '$(touch should-not-exist)'],
    } }) });

    expect(result.status).toBe('READY_TO_MERGE');
    expect(existsSync(resolve(fixture, 'should-not-exist'))).toBe(false);
  });

  it('kills a stalled external worker at the configured timeout', async () => {
    const started = Date.now();
    const result = await executeTaskRun({ taskId, adapter: adapter({ timeoutMs: 100, implementation: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps[0].status).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('bounds external output and rejects an oversized worker response', async () => {
    const result = await executeTaskRun({ taskId, adapter: adapter({ implementation: { command: process.execPath, args: ['-e', `process.stdout.write('x'.repeat(300000))`] } }) });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.steps[0].status).toBe('output_limit');
    expect(JSON.stringify(result).length).toBeLessThan(40_000);
  });

  it('rejects a check that changes the code after evaluating it', async () => {
    writeFileSync(resolve(fixture, 'verify.cjs'), `require('node:fs').writeFileSync('answer.js', 'export const answer = 999;\\n');`);
    const result = await executeTaskRun({ taskId, adapter: adapter() });

    expect(result).toMatchObject({ status: 'FAILED', run: { status: 'failed' } });
    expect(result.error).toContain('Code changed during verification');
    expect(result.steps.some((step) => step.stage === 'review')).toBe(false);
  });

  it('requires a distinct reviewer before creating run state', () => {
    const before = filesUnder('.project-context');
    expect(() => planTaskRun({ taskId, adapter: adapter({ reviewer: 'fixture-implementer' }) })).toThrow(/different/);
    expect(filesUnder('.project-context')).toEqual(before);
  });
});
