import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';
import { buildContextPack } from '../context-pack/pack.js';
import { ensureFreshIndex } from '../indexer/sqlite.js';
import { repoPaths } from '../storage/repo.js';
import { buildAcceptanceReviewBundle, recordAcceptanceReview } from './acceptance.js';
import { createAgentRun, getAgentRun, getRunSnapshot, recordRunVerification, transitionAgentRun } from './runs.js';
import { readTaskContract, redactExecutionText } from './store.js';

const commandSchema = z.object({
  command: z.string().trim().min(1).max(8_192),
  args: z.array(z.string().max(32_768)).max(100).default([]),
}).strict();

export const runAdapterSchema = z.object({
  executor: z.string().trim().min(1).max(200),
  reviewer: z.string().trim().min(1).max(200),
  implementation: commandSchema,
  review: commandSchema,
  timeoutMs: z.number().int().min(50).max(1_800_000).default(600_000),
}).strict().refine((value) => value.executor.toLocaleLowerCase() !== value.reviewer.toLocaleLowerCase(), {
  message: 'The reviewer must be different from the executor.',
});

type RunAdapter = z.input<typeof runAdapterSchema>;
type Command = z.output<typeof commandSchema>;
type ProcessStatus = 'passed' | 'failed' | 'launch_error' | 'timeout' | 'output_limit' | 'input_limit' | 'interrupted';

export type RunStep = {
  stage: 'implementation' | 'verification' | 'review';
  status: ProcessStatus;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
};

type ProcessResult = Omit<RunStep, 'stage'> & { stdout: string };

const maximumInputBytes = 1_048_576;
const maximumOutputBytes = 262_144;

/** Inspect exactly which local commands would run, without creating records or launching an adapter. */
export function planTaskRun(input: { taskId: string; adapter: RunAdapter }) {
  const adapter = runAdapterSchema.parse(input.adapter);
  const task = readTaskContract(input.taskId);
  if (task.requiredChecks.length === 0) {
    throw new Error('The confirmed task needs at least one concrete required verification command.');
  }
  return {
    dryRun: true as const,
    task,
    adapter,
    requiredChecks: task.requiredChecks,
    stages: ['implementing', 'verifying', 'reviewing', 'ready_to_merge'] as const,
    limits: { maximumInputBytes, maximumOutputBytes, timeoutMs: adapter.timeoutMs },
    instructions: [
      'Execution uses the current checkout. Review the adapter argv and every required shell command before --execute.',
      'Implementation receives the task contract and local context pack as JSON on stdin.',
      'Review receives a frozen acceptance bundle on stdin and must emit only verdict, criteria and findings JSON.',
      'Use your adapter platform to enforce reviewer read-only permissions; this runner does not provide a sandbox.',
    ],
  };
}

/** Optional CLI orchestration only: never import this module into the MCP server. */
export async function executeTaskRun(input: { taskId: string; adapter: RunAdapter }) {
  const plan = planTaskRun(input);
  const adapter = plan.adapter;
  const created = createAgentRun({ taskId: input.taskId, executor: adapter.executor });
  let lastKnownRun = created;
  const steps: RunStep[] = [];
  const execute = async (stage: RunStep['stage'], command: Command, stdin = '', shell = false) => {
    const result = await runProcess(command, stdin, adapter.timeoutMs, shell);
    const { stdout: _stdout, ...metadata } = result;
    steps.push({ stage, ...metadata });
    return result;
  };

  try {
    const contextPack = buildContextPack({ query: plan.task.body, taskId: input.taskId, workflow: 'standard', maxTokens: 4_000 });
    lastKnownRun = transitionAgentRun({ runId: created.id, status: 'implementing' });
    const implementation = await execute('implementation', adapter.implementation, JSON.stringify({
      protocolVersion: 1,
      stage: 'implementation',
      runId: created.id,
      task: { ...plan.task, body: redactExecutionText(plan.task.body) },
      contextPack,
      instructions: 'Implement the confirmed task in the current checkout. The runner will execute the frozen verification commands and request an independent acceptance review.',
    }));
    requirePassed(implementation, 'Implementation');

    lastKnownRun = transitionAgentRun({ runId: created.id, status: 'verifying' });
    // Manifest changes invalidate the derived router index; default index --check must inspect fresh metadata.
    ensureFreshIndex();
    const checkedSnapshot = getRunSnapshot(created.id);
    const checks = [];
    for (const command of created.requiredChecks) {
      const result = await execute('verification', { command, args: [] }, '', true);
      if (result.status === 'interrupted') throw new Error('Execution interrupted during verification.');
      checks.push({
        command,
        status: result.status === 'passed' ? 'passed' as const : 'failed' as const,
        reason: processSummary(result),
        durationMs: result.durationMs,
      });
      if (getRunSnapshot(created.id).codeDigest !== checkedSnapshot.codeDigest) {
        throw new Error('Code changed during verification; the checks do not attest to the current snapshot.');
      }
    }
    const evidence = recordRunVerification({
      runId: created.id,
      expectedCodeDigest: checkedSnapshot.codeDigest,
      checks,
      summary: 'Frozen task verification commands executed by the optional CLI runner.',
    });
    if (checks.some((check) => check.status !== 'passed')) throw new Error('Required verification checks failed.');
    lastKnownRun = transitionAgentRun({ runId: created.id, status: 'reviewing', evidenceIds: [evidence.id] });

    const bundle = buildAcceptanceReviewBundle({ runId: created.id, maxDiffChars: 200_000 });
    if (bundle.snapshot.diffTruncated) {
      throw new Error('The complete diff exceeds the automatic review limit. Split the change into smaller tasks or use a manual acceptance reviewer who inspects the complete repository diff.');
    }
    const reviewProcess = await execute('review', adapter.review, JSON.stringify({
      protocolVersion: 1,
      stage: 'acceptance-review',
      ...bundle,
      instructions: [
        ...bundle.instructions,
        'Review without changing repository files or execution records.',
        'Emit only one JSON object: {"verdict":"passed"|"failed","criteria":[{"criterionId":"AC-1","status":"passed"|"failed","implementationEvidence":"...","verificationEvidence":"...","risk":"optional"}],"findings":["..."]}. Do not emit provenance fields; the runner binds the decision to this frozen bundle.',
      ],
    }));
    requirePassed(reviewProcess, 'Acceptance reviewer');
    let review: unknown;
    try {
      review = JSON.parse(reviewProcess.stdout);
    } catch {
      throw new Error('Acceptance reviewer must emit one valid JSON object without surrounding text.');
    }
    const parsedDecision = externalReviewSchema.safeParse(review);
    if (!parsedDecision.success) throw new Error('Acceptance reviewer returned an invalid decision schema.');
    const decision = parsedDecision.data;
    const accepted = recordAcceptanceReview({
      ...decision,
      runId: created.id,
      reviewer: adapter.reviewer,
      taskDigest: bundle.provenance.taskDigest,
      codeDigest: bundle.provenance.codeDigest,
      evidenceIds: [evidence.id],
    });
    if (decision.verdict !== 'passed') throw new Error('Independent acceptance review failed.');
    const run = transitionAgentRun({ runId: created.id, status: 'ready_to_merge', reviewId: accepted.id });
    return { status: 'READY_TO_MERGE' as const, run, steps };
  } catch (error) {
    // Keep external process output and executable paths out of portable run records.
    const message = redactExecutionText(error instanceof z.ZodError
      ? 'Execution record validation failed.'
      : error instanceof Error ? error.message : 'Execution failed.');
    try {
      lastKnownRun = getAgentRun(created.id);
      if (lastKnownRun.status !== 'failed' && lastKnownRun.status !== 'ready_to_merge') {
        lastKnownRun = transitionAgentRun({ runId: created.id, status: 'failed', reason: message });
      }
      return { status: 'FAILED' as const, run: lastKnownRun, steps, error: message };
    } catch (persistenceError) {
      // A worker can damage local metadata. Preserve the original failure and report that status could not be saved.
      return {
        status: 'FAILED' as const,
        run: lastKnownRun,
        steps,
        error: message,
        persistenceError: redactExecutionText(`Unable to persist failed run status; the manifest may retain its last state. ${persistenceError instanceof Error ? persistenceError.message : 'Execution storage is unavailable.'}`),
      };
    }
  }
}

const externalReviewSchema = z.object({
  verdict: z.enum(['passed', 'failed']),
  criteria: z.array(z.object({
    criterionId: z.string().min(1),
    status: z.enum(['passed', 'failed']),
    implementationEvidence: z.string().min(1),
    verificationEvidence: z.string().min(1),
    risk: z.string().optional(),
  }).strict()),
  findings: z.array(z.string()),
}).strict();

function processSummary(result: ProcessResult): string {
  return `${result.status}; exit=${result.exitCode ?? 'none'}; signal=${result.signal ?? 'none'}`;
}

function requirePassed(result: ProcessResult, label: string): void {
  if (result.status !== 'passed') throw new Error(`${label}: ${processSummary(result)}.`);
}

function runProcess(command: Command, input: string, timeoutMs: number, shell: boolean): Promise<ProcessResult> {
  const started = Date.now();
  if (Buffer.byteLength(input) > maximumInputBytes) {
    return Promise.resolve({ status: 'input_limit', stdout: '', exitCode: null, signal: null, durationMs: 0 });
  }
  return new Promise((resolveResult) => {
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let stopped: ProcessStatus | undefined;
    let settled = false;
    let forcedKill: NodeJS.Timeout | undefined;
    let finishAfterKill: NodeJS.Timeout | undefined;
    const child = spawn(command.command, command.args, {
      cwd: repoPaths().root,
      shell,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else {
          if (child.pid) spawnSync('taskkill', ['/pid', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], {
            timeout: 500, stdio: 'ignore', windowsHide: true,
          });
          child.kill(signal);
        }
      } catch {
        // The owned process group may have exited before its pipes closed.
      }
    };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedKill) clearTimeout(forcedKill);
      if (finishAfterKill) clearTimeout(finishAfterKill);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      // Descendants are scoped to this detached group, including when a worker exits early.
      kill('SIGKILL');
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      resolveResult({
        status: stopped ?? (exitCode === 0 ? 'passed' : 'failed'),
        stdout: Buffer.concat(stdout).toString('utf8'),
        exitCode,
        signal,
        durationMs: Date.now() - started,
      });
    };
    const stop = (status: ProcessStatus) => {
      if (stopped || settled) return;
      stopped = status;
      kill('SIGTERM');
      forcedKill = setTimeout(() => {
        kill('SIGKILL');
        finishAfterKill = setTimeout(() => finish(null, 'SIGKILL'), 200);
      }, 200);
    };
    const interrupt = () => stop('interrupted');
    const timeout = setTimeout(() => stop('timeout'), timeoutMs);
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    child.once('error', () => {
      stopped = 'launch_error';
      finish(null, null);
    });
    child.once('close', finish);
    child.stdin.on('error', () => { /* Early process exit can close stdin before the payload is consumed. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) stop('output_limit');
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes) stop('output_limit');
    });
    child.stdin.end(input);
  });
}
