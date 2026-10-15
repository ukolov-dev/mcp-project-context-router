import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertExecutionPath } from '../execution/store.js';
import { parseRecord } from '../storage/markdown.js';
import { repoPaths } from '../storage/repo.js';
import { getVerificationPlan } from '../verification/verification.js';

/** Validate reported evidence; hooks do not execute checks or grant acceptance. */
export function unfinishedTasks(changedFiles: string[], changedAt: string | undefined, startedAt = changedAt): string[] {
  if (!changedFiles.length) return [];
  const directory = resolve(repoPaths().activeDir, 'tasks');
  assertExecutionPath(directory);
  if (!existsSync(directory)) return [];
  const problems: string[] = [];
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.md'))) {
    const path = resolve(directory, file);
    assertExecutionPath(path);
    const task = parseRecord(path);
    if (task.type !== 'task' || task.frontmatter.confirmed_by_human !== true) continue;
    if (!task.files.some((file) => changedFiles.includes(file))) continue;
    const data = task.frontmatter;
    const cutoff = Date.parse(changedAt ?? '');
    const finalized = Date.parse(String(data.finalized_at ?? ''));
    if (!['confirmed', 'in_progress', 'blocked'].includes(task.status) && !(finalized >= Date.parse(startedAt ?? ''))) continue;
    const result = data.last_result as Record<string, unknown> | undefined;
    if (!(finalized >= cutoff) || typeof result?.summary !== 'string' || !result.summary.trim()) {
      problems.push(`${task.id}: save a fresh result with finalize_work.`);
      continue;
    }
    const plan = getVerificationPlan({ id: task.id });
    const evidence = plan.evidence[0];
    const verified = Date.parse(evidence?.createdAt ?? '');
    if (!(verified >= cutoff && finalized >= verified)) {
      problems.push(`${task.id}: record fresh verification evidence before finalization.`);
      continue;
    }
    const missing = plan.required.filter(({ command }) => !evidence.checks.some((check) => check.command === command && check.status === 'passed'));
    const unresolved = new Set([...missing.map((check) => check.command), ...evidence.checks.filter((check) => check.status === 'failed' || (check.required !== false && check.status !== 'passed')).map((check) => check.command)]);
    const skipped = Array.isArray(result.skipped_checks) ? result.skipped_checks : [];
    const partial = data.completion === 'partial' || data.completion === 'blocked';
    const unexplained = [...unresolved].filter((command) => {
      const reason = evidence.checks.find((check) => check.command === command)?.reason;
      return !partial || !((reason?.trim() && reason !== 'Required by verification plan; no evidence supplied.')
        || skipped.some((entry) => entry && typeof entry === 'object' && entry.command === command && typeof entry.reason === 'string' && entry.reason.trim()));
    });
    if (unexplained.length) problems.push(`${task.id}: checks need passing evidence or explicit partial/blocked reasons: ${unexplained.join('; ')}.`);
  }
  return problems;
}
