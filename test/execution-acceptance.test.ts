import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildAcceptanceReviewBundle,
  getAcceptanceReview,
  recordAcceptanceReview,
  type recordAcceptanceReviewInputSchema,
} from '../src/execution/acceptance.js';
import { createAgentRun, getAgentRun, getRunSnapshot, recordRunVerification, transitionAgentRun } from '../src/execution/runs.js';
import { confirmTaskContract } from '../src/task-validation/task.js';
import type { z } from 'zod';

let originalCwd: string;
let fixtureDir: string;
const taskId = 'TASK-ACCEPTANCE-001';

beforeEach(() => {
  originalCwd = process.cwd();
  fixtureDir = mkdtempSync(resolve(tmpdir(), 'router-acceptance-'));
  process.chdir(fixtureDir);
  mkdirSync(resolve(fixtureDir, '.project-context'), { recursive: true });
  mkdirSync(resolve(fixtureDir, 'src'));
  writeFileSync(resolve(fixtureDir, '.gitignore'), '.project-context/active/\n.project-context/drafts/\n.project-context/indexes/\n.project-context/trash/\n');
  writeFileSync(resolve(fixtureDir, '.project-context/project.yaml'), `project:
  name: Acceptance Fixture
routing:
  default_modules: [app]
modules:
  app:
    path: src
    aliases: [app, code]
    playbooks: []
commands:
  app_tests:
    run: node --test
    context_pack: true
    required_for: [app]
    writes_to: []
`);
  writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = false;\n');
  execFileSync('git', ['init', '-q']);
  execFileSync('git', ['add', '.']);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Initial fixture']);
  confirmTaskContract({
    taskId,
    goal: 'Enable the fixture feature with verification',
    scope: ['src/feature.js'],
    outOfScope: [],
    acceptanceCriteria: ['The feature is enabled.', 'The feature remains an exported boolean.'],
    risks: [],
    testExpectations: ['node --test'],
    modules: ['app'],
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(fixtureDir, { recursive: true, force: true });
});

function reviewingRun(executor = 'implementer-session') {
  const run = createAgentRun({ taskId, executor });
  transitionAgentRun({ runId: run.id, status: 'implementing' });
  writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = true;\n');
  transitionAgentRun({ runId: run.id, status: 'verifying' });
  const snapshot = getRunSnapshot(run.id);
  const evidence = recordRunVerification({
    runId: run.id,
    expectedCodeDigest: snapshot.codeDigest,
    summary: 'Feature assertions passed in the fixture.',
    checks: run.requiredChecks.map((command) => ({ command, status: 'passed' })),
  });
  transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] });
  return { run: getAgentRun(run.id), evidence, bundle: buildAcceptanceReviewBundle({ runId: run.id }) };
}

function passingReview(fixture: ReturnType<typeof reviewingRun>): z.input<typeof recordAcceptanceReviewInputSchema> {
  return {
    runId: fixture.run.id,
    reviewer: 'reviewer-session',
    taskDigest: fixture.bundle.provenance.taskDigest,
    codeDigest: fixture.bundle.provenance.codeDigest,
    verdict: 'passed',
    criteria: fixture.run.acceptanceCriteria.map((criterion) => ({
      criterionId: criterion.id,
      status: 'passed',
      implementationEvidence: 'src/feature.js exports enabled = true; reviewed against the task contract.',
      verificationEvidence: `${fixture.evidence.id}: node --test verifies the exported value.`,
    })),
    findings: [],
    evidenceIds: [fixture.evidence.id],
  };
}

describe('independent acceptance reviews', () => {
  it('bundles exact task criteria, diff, check evidence and provenance before a separately supplied decision', () => {
    const fixture = reviewingRun();
    expect(fixture.bundle.task.body).toContain('## Acceptance Criteria');
    expect(fixture.bundle.task.acceptanceCriteria).toEqual(fixture.run.acceptanceCriteria);
    expect(fixture.bundle.snapshot.diff).toContain('+export const enabled = true;');
    expect(fixture.bundle.snapshot.diffTruncated).toBe(false);
    expect(fixture.bundle.evidence.map((entry) => entry.id)).toEqual([fixture.evidence.id]);
    expect(fixture.bundle.provenance).toMatchObject({ executor: 'implementer-session', runId: fixture.run.id });
    expect(fixture.run.status).toBe('reviewing');

    const accepted = recordAcceptanceReview(passingReview(fixture));
    expect(accepted.path).toBe(`.project-context/active/acceptance-reviews/${accepted.id}.md`);
    expect(getAcceptanceReview(accepted.id)).toMatchObject({
      verdict: 'passed', runId: fixture.run.id, taskId, reviewer: 'reviewer-session',
      runRevision: fixture.run.revision, codeDigest: fixture.bundle.provenance.codeDigest,
    });
    expect(getAgentRun(fixture.run.id).status).toBe('reviewing');
    expect(transitionAgentRun({ runId: fixture.run.id, status: 'ready_to_merge', reviewId: accepted.id }).status).toBe('ready_to_merge');
  });

  it.each(['missing', 'duplicate', 'unknown'] as const)('rejects %s criterion coverage', (variant) => {
    const input = passingReview(reviewingRun());
    if (variant === 'missing') input.criteria.pop();
    if (variant === 'duplicate') input.criteria[1] = { ...input.criteria[0] };
    if (variant === 'unknown') input.criteria[1].criterionId = 'AC-NOT-IN-TASK';
    expect(() => recordAcceptanceReview(input)).toThrow(/every task criterion exactly once/);
  });

  it.each(['implementationEvidence', 'verificationEvidence'] as const)('rejects blank %s', (field) => {
    const input = passingReview(reviewingRun());
    input.criteria[0][field] = '   ';
    expect(() => recordAcceptanceReview(input)).toThrow();
  });

  it('rejects self review including differently cased and padded identities', () => {
    const input = passingReview(reviewingRun());
    input.reviewer = ' Implementer-Session ';
    expect(() => recordAcceptanceReview(input)).toThrow(/independent/);
  });

  it('rejects a code change after the reviewer received the bundle', () => {
    const input = passingReview(reviewingRun());
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), 'export const enabled = "incorrect";\n');
    expect(() => recordAcceptanceReview(input)).toThrow(/digest|snapshot|changed|stale/i);
  });

  it('rejects an updated task contract even when the caller supplies the old digest', () => {
    const input = passingReview(reviewingRun());
    const taskPath = resolve(fixtureDir, `.project-context/active/tasks/${taskId}.md`);
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('The feature is enabled.', 'The feature is enabled only for administrators.'));
    expect(() => recordAcceptanceReview(input)).toThrow(/task.*(changed|digest|stale)|contract/i);
  });

  it('rejects absent, fabricated and unrelated verification references', () => {
    const fixture = reviewingRun();
    const input = passingReview(fixture);
    expect(() => recordAcceptanceReview({ ...input, evidenceIds: [] })).toThrow();
    expect(() => recordAcceptanceReview({ ...input, evidenceIds: ['VERIFY-MISSING-001'] })).toThrow();
    input.criteria[0].verificationEvidence = 'Tests passed somewhere else without a run evidence reference.';
    expect(() => recordAcceptanceReview(input)).toThrow(/cite a supplied verification evidence ID/);
    input.criteria[0].verificationEvidence = `PREFIX-${fixture.evidence.id}-SUFFIX is not this evidence ID.`;
    expect(() => recordAcceptanceReview(input)).toThrow(/cite a supplied verification evidence ID/);
  });

  it('rejects evidence attached to a different run of the same task', () => {
    const first = reviewingRun();
    const second = reviewingRun('another-implementer-session');
    const input = passingReview(first);
    input.evidenceIds = [second.evidence.id];
    input.criteria.forEach((criterion) => { criterion.verificationEvidence = `${second.evidence.id}: node --test`; });
    expect(() => recordAcceptanceReview(input)).toThrow(/evidence|run|bound/i);
  });

  it('rejects an altered verification record', () => {
    const fixture = reviewingRun();
    const evidencePath = resolve(fixtureDir, fixture.evidence.path);
    writeFileSync(evidencePath, readFileSync(evidencePath, 'utf8').replace('Feature assertions passed in the fixture.', 'Changed after verification.'));
    expect(() => recordAcceptanceReview(passingReview(fixture))).toThrow(/integrity|digest|altered|changed/i);
  });

  it('preserves failed criteria, findings and risk without marking the run accepted', () => {
    const fixture = reviewingRun();
    const input = passingReview(fixture);
    input.verdict = 'failed';
    input.criteria[0].status = 'failed';
    input.criteria[0].risk = 'The implementation may break consumers expecting a boolean.';
    input.findings = ['The task criterion needs an additional negative-case assertion.'];
    const result = recordAcceptanceReview(input);
    expect(getAcceptanceReview(result.id)).toMatchObject({ verdict: 'failed', findings: input.findings });
    expect(result.review.criteria[0].risk).toBe(input.criteria[0].risk);
    expect(getAgentRun(fixture.run.id).status).toBe('reviewing');
    expect(() => transitionAgentRun({ runId: fixture.run.id, status: 'ready_to_merge', reviewId: result.id })).toThrow();
  });

  it('rejects passing verdicts that include a failed criterion or unresolved findings', () => {
    const fixture = reviewingRun();
    const input = passingReview(fixture);
    expect(() => recordAcceptanceReview({ ...input, findings: ['Unresolved regression'] })).toThrow(/every criterion passed and no findings/);
    input.criteria[0].status = 'failed';
    expect(() => recordAcceptanceReview(input)).toThrow(/every criterion passed and no findings/);
  });

  it('does not allow an older passed review to override a later failed review', () => {
    const fixture = reviewingRun();
    const input = passingReview(fixture);
    const accepted = recordAcceptanceReview(input);
    recordAcceptanceReview({
      ...input,
      reviewer: 'second-reviewer-session',
      verdict: 'failed',
      findings: ['A subsequent review found a missing negative case.'],
    });
    expect(() => transitionAgentRun({ runId: fixture.run.id, status: 'ready_to_merge', reviewId: accepted.id })).toThrow(/latest|review|newer/i);
  });

  it('rejects review calls before reviewing and nonexistent run or review records', () => {
    const run = createAgentRun({ taskId, executor: 'implementer-session' });
    expect(() => buildAcceptanceReviewBundle({ runId: run.id })).toThrow(/reviewing status/);
    expect(() => buildAcceptanceReviewBundle({ runId: 'AGENTRUN-MISSING-001' })).toThrow();
    expect(() => getAcceptanceReview('ACCEPT-MISSING-001')).toThrow();
    expect(() => getAcceptanceReview('../../outside')).toThrow();
  });

  it('flags diff truncation without changing the digest used for acceptance', () => {
    const run = createAgentRun({ taskId, executor: 'implementer-session' });
    transitionAgentRun({ runId: run.id, status: 'implementing' });
    writeFileSync(resolve(fixtureDir, 'src/feature.js'), `export const enabled = true;\n${'// review context\n'.repeat(300)}`);
    transitionAgentRun({ runId: run.id, status: 'verifying' });
    const snapshot = getRunSnapshot(run.id);
    const evidence = recordRunVerification({
      runId: run.id,
      expectedCodeDigest: snapshot.codeDigest,
      summary: 'Feature checks passed.',
      checks: run.requiredChecks.map((command) => ({ command, status: 'passed' })),
    });
    transitionAgentRun({ runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] });
    const bundle = buildAcceptanceReviewBundle({ runId: run.id, maxDiffChars: 1_000 });
    expect(bundle.snapshot.diff).toHaveLength(1_000);
    expect(bundle.snapshot.diffTruncated).toBe(true);
    expect(bundle.snapshot.diffOriginalCharacters).toBeGreaterThan(1_000);
    expect(bundle.provenance.codeDigest).toBe(snapshot.codeDigest);
  });
});
