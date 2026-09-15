import { createHash } from 'node:crypto';
import type { z } from 'zod';
import {
  acceptanceReviewSchema, agentRunSchema, createAgentRunInputSchema, listAgentRunsInputSchema,
  recordRunVerificationInputSchema, runVerificationEvidenceSchema, transitionAgentRunInputSchema,
  type AgentRun, type CodeSnapshot, type ExecutionStatus, type RunVerificationEvidence,
} from './types.js';
import {
  captureCodeSnapshot, executionGit, executionRecordIds, newExecutionId, readExecutionRecord,
  readTaskContract, redactExecutionText, resolveExecutionCommit, withRunLock, writeExecutionRecord,
} from './store.js';

export function createAgentRun(input: z.input<typeof createAgentRunInputSchema>): AgentRun {
  const parsed = createAgentRunInputSchema.parse(input);
  return withRunLock(parsed.taskId, () => {
    const task = readTaskContract(parsed.taskId);
    if (task.acceptanceCriteria.length === 0) throw new Error('Task Contract requires concrete acceptance criteria before execution.');
    if (redactExecutionText(parsed.executor) !== parsed.executor) throw new Error('Executor identity must not contain secrets or workstation paths.');
    const baseCommit = resolveExecutionCommit(parsed.baseCommit ?? 'HEAD');
    // Preflight source boundaries at creation, before an adapter starts work.
    captureCodeSnapshot(baseCommit);
    const runs = listAgentRuns({ taskId: parsed.taskId });
    const timestamp = new Date().toISOString();
    const branch = executionGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const run = agentRunSchema.parse({
      id: newExecutionId('AGENT-RUN'), taskId: parsed.taskId, taskDigest: task.taskDigest,
      baseCommit, branch: branch === 'HEAD' ? null : branch, worktree: '.', executor: parsed.executor,
      attempt: Math.max(0, ...runs.map((item) => item.attempt)) + 1, status: 'confirmed',
      createdAt: timestamp, updatedAt: timestamp, finishedAt: null, result: null, revision: 0,
      requiredChecks: task.requiredChecks, acceptanceCriteria: task.acceptanceCriteria, evidenceIds: [],
      evidenceDigests: {}, history: [{ from: null, status: 'confirmed', at: timestamp }],
    });
    writeExecutionRecord('agent-runs', run.id, run);
    return run;
  });
}

export function getAgentRun(runId: string): AgentRun {
  // Historical manifests remain readable if their task has since changed or been archived.
  return agentRunSchema.parse(readExecutionRecord('agent-runs', runId));
}

export function listAgentRuns(input: z.input<typeof listAgentRunsInputSchema> = {}): AgentRun[] {
  const parsed = listAgentRunsInputSchema.parse(input);
  return executionRecordIds('agent-runs').map(getAgentRun)
    .filter((run) => !parsed.taskId || run.taskId === parsed.taskId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.attempt - left.attempt);
}

function assertFreshTask(run: AgentRun): void {
  const task = readTaskContract(run.taskId);
  if (task.taskDigest !== run.taskDigest || JSON.stringify(task.requiredChecks) !== JSON.stringify(run.requiredChecks)
    || JSON.stringify(task.acceptanceCriteria) !== JSON.stringify(run.acceptanceCriteria)) {
    throw new Error('Task Contract or verification plan changed; this execution is stale. Create a new run.');
  }
}

export function getRunSnapshot(runId: string): CodeSnapshot & { taskDigest: string } {
  const run = getAgentRun(runId);
  assertFreshTask(run);
  return { ...captureCodeSnapshot(run.baseCommit), taskDigest: run.taskDigest };
}

export function recordRunVerification(input: z.input<typeof recordRunVerificationInputSchema>): { status: 'RECORDED'; id: string; path: string } {
  const parsed = recordRunVerificationInputSchema.parse(input);
  return withRunLock(parsed.runId, () => {
    const run = getAgentRun(parsed.runId);
    if (run.status !== 'verifying') throw new Error('Run verification can only be recorded while verifying.');
    const snapshot = getRunSnapshot(run.id);
    if (parsed.expectedCodeDigest !== snapshot.codeDigest) throw new Error('Code changed since verification began; evidence would be stale.');
    if (new Set(parsed.checks.map((check) => check.command)).size !== parsed.checks.length) throw new Error('Duplicate verification commands are not allowed.');
    const evidence = runVerificationEvidenceSchema.parse({
      id: newExecutionId('VERIFY'), runId: run.id, taskId: run.taskId,
      taskDigest: snapshot.taskDigest, codeDigest: snapshot.codeDigest,
      baseCommit: snapshot.baseCommit, headCommit: snapshot.headCommit,
      summary: redactExecutionText(parsed.summary),
      checks: parsed.checks.map((check) => ({ ...check, ...(check.reason ? { reason: redactExecutionText(check.reason) } : {}) })),
      createdAt: new Date().toISOString(),
    });
    const status = evidence.checks.some((check) => check.status === 'failed') ? 'failed'
      : evidence.checks.every((check) => check.status === 'passed') ? 'passed' : 'incomplete';
    const path = writeExecutionRecord('verification', evidence.id, {
      ...evidence, status, target_id: run.taskId, target_type: 'task', recorded_by: run.executor,
      files: snapshot.changedFiles,
    }, `# Verification for ${run.id}\n\n${evidence.summary}`);
    return { status: 'RECORDED', id: evidence.id, path };
  });
}

export function assertRunEvidence(
  run: AgentRun, snapshot: CodeSnapshot & { taskDigest?: string }, evidenceIds: string[],
  options: { requirePassed?: boolean } = {},
): RunVerificationEvidence[] {
  const requirePassed = options.requirePassed !== false;
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new Error('Duplicate verification evidence IDs are not allowed.');
  if (requirePassed && evidenceIds.length === 0) throw new Error('Run requires verification evidence before review.');
  const records = evidenceIds.map((id) => {
    const evidence = runVerificationEvidenceSchema.parse(readExecutionRecord('verification', id));
    if (evidence.runId !== run.id || evidence.taskId !== run.taskId || evidence.taskDigest !== run.taskDigest
      || evidence.codeDigest !== snapshot.codeDigest || evidence.baseCommit !== snapshot.baseCommit || evidence.headCommit !== snapshot.headCommit) {
      throw new Error(`Verification evidence ${id} is stale or belongs to another run/task/code snapshot.`);
    }
    if (new Set(evidence.checks.map((check) => check.command)).size !== evidence.checks.length) throw new Error(`Duplicate verification commands in ${id}.`);
    if (['reviewing', 'ready_to_merge'].includes(run.status) && run.evidenceIds.includes(id)
      && run.evidenceDigests[id] !== evidenceDigest(evidence)) throw new Error(`Verification evidence ${id} changed after entering review.`);
    return evidence;
  });
  if (requirePassed) {
    if (run.requiredChecks.length === 0) throw new Error('No required verification checks are defined; update the Task Contract before proceeding.');
    const checks = records.flatMap((record) => record.checks);
    if (checks.some((check) => check.status === 'failed')) throw new Error('Failed verification evidence cannot pass the review gate.');
    for (const command of run.requiredChecks) {
      const matching = checks.filter((check) => check.command === command);
      if (matching.length === 0 || matching.some((check) => check.status !== 'passed')) throw new Error(`Required verification check has not passed: ${command}`);
    }
  }
  return records;
}

const transitions: Record<ExecutionStatus, ExecutionStatus[]> = {
  confirmed: ['implementing', 'failed'],
  implementing: ['verifying', 'failed'],
  verifying: ['reviewing', 'failed'],
  reviewing: ['ready_to_merge', 'failed'],
  ready_to_merge: [],
  failed: [],
};

export function transitionAgentRun(input: z.input<typeof transitionAgentRunInputSchema>): AgentRun {
  const parsed = transitionAgentRunInputSchema.parse(input);
  return withRunLock(parsed.runId, () => {
    const run = getAgentRun(parsed.runId);
    if (parsed.expectedRevision !== undefined && parsed.expectedRevision !== run.revision) throw new Error('Run revision changed; reload before transitioning.');
    if (!transitions[run.status].includes(parsed.status)) throw new Error(`Invalid execution transition: ${run.status} -> ${parsed.status}. Terminal runs are immutable; retry with a new run.`);
    if (parsed.status !== 'failed') assertFreshTask(run);
    if (parsed.status === 'failed' && !parsed.reason) throw new Error('A failure reason is required.');
    let evidenceIds = run.evidenceIds;
    let evidenceDigests = run.evidenceDigests;
    if (parsed.status === 'reviewing') {
      evidenceIds = parsed.evidenceIds ?? run.evidenceIds;
      const evidence = assertRunEvidence(run, getRunSnapshot(run.id), evidenceIds);
      evidenceDigests = Object.fromEntries(evidence.map((record) => [record.id, evidenceDigest(record)]));
    } else if (parsed.evidenceIds !== undefined) {
      if (parsed.status !== 'ready_to_merge' || !sameIds(parsed.evidenceIds, run.evidenceIds)) throw new Error('Evidence IDs may only be attached when entering review.');
    }
    if (parsed.status === 'ready_to_merge') {
      if (!parsed.reviewId) throw new Error('An independent acceptance review is required before ready_to_merge.');
      const snapshot = getRunSnapshot(run.id);
      assertRunEvidence(run, snapshot, run.evidenceIds);
      const review = acceptanceReviewSchema.parse(readExecutionRecord('acceptance-reviews', parsed.reviewId));
      const latest = executionRecordIds('acceptance-reviews')
        .map((id) => acceptanceReviewSchema.parse(readExecutionRecord('acceptance-reviews', id)))
        .filter((item) => item.runId === run.id && item.runRevision === run.revision
          && item.taskDigest === snapshot.taskDigest && item.codeDigest === snapshot.codeDigest)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
      if (latest?.id !== review.id) throw new Error('Acceptance review is superseded by a newer review of this execution snapshot.');
      if (review.runId !== run.id || review.taskId !== run.taskId || review.taskDigest !== run.taskDigest
        || review.codeDigest !== snapshot.codeDigest || review.baseCommit !== snapshot.baseCommit
        || review.headCommit !== snapshot.headCommit || review.runRevision !== run.revision || review.executor !== run.executor) {
        throw new Error('Acceptance review is stale or belongs to another execution snapshot.');
      }
      if (review.reviewer.trim().toLowerCase() === run.executor.trim().toLowerCase()) throw new Error('Acceptance reviewer must be independent from the executor.');
      if (review.verdict !== 'passed' || review.findings.length > 0) throw new Error('Acceptance review has failed or unresolved findings.');
      if (!sameIds(review.evidenceIds, run.evidenceIds)) throw new Error('Acceptance review must cite the exact reviewed verification evidence.');
      const criteriaIds = review.criteria.map((criterion) => criterion.criterionId);
      if (run.acceptanceCriteria.length === 0 || !sameIds(criteriaIds, run.acceptanceCriteria.map((criterion) => criterion.id))) throw new Error('Acceptance review must cover every Task Contract criterion exactly once.');
      if (review.criteria.some((criterion) => criterion.status !== 'passed'
        || !review.evidenceIds.some((id) => citesEvidenceId(criterion.verificationEvidence, id)))) throw new Error('Every acceptance criterion must pass with linked verification evidence.');
    } else if (parsed.reviewId !== undefined) {
      throw new Error('An acceptance review can only be attached when entering ready_to_merge.');
    }
    const timestamp = new Date().toISOString();
    const terminal = parsed.status === 'failed' || parsed.status === 'ready_to_merge';
    const updated = agentRunSchema.parse({
      ...run, status: parsed.status, revision: run.revision + 1, updatedAt: timestamp,
      evidenceIds, evidenceDigests, ...(parsed.reviewId ? { reviewId: parsed.reviewId } : {}),
      history: [...run.history, {
        from: run.status, status: parsed.status, at: timestamp,
        ...(parsed.reason ? { reason: redactExecutionText(parsed.reason) } : {}),
        ...(parsed.status === 'reviewing' ? { evidenceIds } : {}),
        ...(parsed.reviewId ? { reviewId: parsed.reviewId } : {}),
      }],
      finishedAt: terminal ? timestamp : null,
      result: terminal ? redactExecutionText(parsed.reason ?? 'Ready for merge after passing independent acceptance review.') : null,
    });
    writeExecutionRecord('agent-runs', run.id, updated, '', true);
    return updated;
  });
}

function sameIds(left: string[], right: string[]): boolean {
  return new Set(left).size === left.length && new Set(right).size === right.length
    && left.length === right.length && left.every((id) => right.includes(id));
}

function evidenceDigest(evidence: RunVerificationEvidence): string {
  return createHash('sha256').update(JSON.stringify(evidence)).digest('hex');
}

function citesEvidenceId(text: string, id: string): boolean {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`).test(text);
}
