import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { buildContextPack } from '../context-pack/pack.js';
import { inferModule } from '../indexer/capabilities.js';
import { findRecordPath, nextRecordId, parseRecord, readRecords, updateRecord, writeMarkdown, createTaskDraft, inferTags } from '../storage/markdown.js';
import { repoPaths, relPath } from '../storage/repo.js';
import { nowIso } from '../storage/time.js';
import { inferModulesFromSignals } from '../storage/inference.js';
import { contextCliCommand, contextPackCommandsForModules, loadProjectConfig } from '../storage/config.js';

export const confirmTaskInputSchema = z.object({
  taskId: z.string(),
  goal: z.string(),
  scope: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  testExpectations: z.array(z.string()).default([]),
  modules: z.array(z.string()).optional(),
  files: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

export type WorkflowLevel = 'fast' | 'standard' | 'strict';

export type SuggestedTaskContract = {
  goal: string;
  scope: string[];
  outOfScope: string[];
  acceptanceCriteria: string[];
  risks: string[];
  testExpectations: string[];
  modules: string[];
  tags: string[];
};

export type WorkflowGuidance = {
  confirmation: string;
  contextPack: string;
  reuseScan: string;
  verification: string;
  notes: string[];
};

export type ValidateTaskResult = {
  status: 'READY' | 'NEEDS_CLARIFICATION' | 'BLOCKED' | 'TOO_BROAD' | 'DUPLICATE_OR_RELATED';
  taskDraftId: string;
  workflow: WorkflowLevel;
  suggestedContract: SuggestedTaskContract;
  guidance: WorkflowGuidance;
  blockingQuestions: string[];
  inferred: string[];
  relatedRecords: Array<{ id: string; path: string; reason: string }>;
};

export function validateTask(query: string, mode = 'feature'): ValidateTaskResult {
  const modules = inferModulesFromSignals({ query, fallback: ['doc'] });
  const workflow = classifyWorkflow(query, mode, modules);
  const questions = blockingQuestions(query, mode);
  const inferred = [...inferStatements(query, modules), `Рекомендуемый workflow: ${workflow}.`];
  const relatedRecords = readRecords(false)
    .filter((record) => record.type === 'task' || record.type === 'bug' || record.type === 'decision')
    .filter((record) => scoreText(query, `${record.title} ${record.body} ${record.tags.join(' ')}`) > 0)
    .slice(0, 5)
    .map((record) => ({
      id: record.id,
      path: record.path,
      reason: 'Text and tag overlap with the incoming request.',
    }));
  const draft = createTaskDraft(cleanTitle(query), query, modules, questions, inferred);
  let status: ValidateTaskResult['status'] = questions.length > 0 ? 'NEEDS_CLARIFICATION' : 'READY';
  if (isTooBroad(query)) status = 'TOO_BROAD';
  if (relatedRecords.length > 0 && /same|duplicate|уже|повтор/i.test(query)) status = 'DUPLICATE_OR_RELATED';
  return {
    status,
    taskDraftId: draft.id,
    workflow,
    suggestedContract: buildSuggestedContract(query, modules, workflow),
    guidance: buildWorkflowGuidance(workflow),
    blockingQuestions: questions,
    inferred,
    relatedRecords,
  };
}

export function confirmTaskContract(input: z.infer<typeof confirmTaskInputSchema>): { status: 'CONFIRMED'; path: string } {
  const paths = repoPaths();
  const parsed = confirmTaskInputSchema.parse(input);
  const sourcePath = findRecordPath(parsed.taskId) ?? resolve(paths.draftsDir, 'tasks', `${parsed.taskId}.md`);
  const id = parsed.taskId;
  const modules = parsed.modules ?? inferModulesFromSignals({
    query: `${parsed.goal} ${parsed.scope.join(' ')}`,
    files: parsed.files,
    fallback: ['doc'],
  });
  const files = parsed.files ?? [];
  const tags = parsed.tags ?? inferTags(`${parsed.goal} ${parsed.scope.join(' ')}`);
  const timestamp = nowIso();
  const frontmatter = {
    id,
    type: 'task',
    status: 'confirmed',
    title: cleanTitle(parsed.goal),
    created_at: timestamp,
    updated_at: timestamp,
    confirmed_at: timestamp,
    confirmed_by_human: true,
    source: { kind: 'user_prompt' },
    related: { bugs: [], decisions: [], refactors: [] },
    modules,
    files,
    tags,
    retention: 'normal',
  };
  const body = `# ${id}: ${cleanTitle(parsed.goal)}

## Goal

${parsed.goal}

## Scope

${listOrNone(parsed.scope)}

## Out Of Scope

${listOrNone(parsed.outOfScope)}

## Acceptance Criteria

${listOrNone(parsed.acceptanceCriteria)}

## Open Questions

Нет.

## Risks

${listOrNone(parsed.risks)}

## Verification Plan

${listOrNone(parsed.testExpectations)}
`;
  const target = resolve(paths.activeDir, 'tasks', `${id}.md`);
  if (existsSync(target) && sourcePath !== target) {
    throw new Error(`Active task already exists for ${id}; refusing to overwrite it.`);
  }
  writeMarkdown(target, frontmatter, body);
  if (existsSync(sourcePath) && sourcePath !== target) {
    const archivedDraft = resolve(paths.trashDir, `${id}.draft.md`);
    mkdirSync(paths.trashDir, { recursive: true });
    renameSync(sourcePath, archivedDraft);
  }
  return { status: 'CONFIRMED', path: relPath(paths.root, target) };
}

export function startWork(taskId: string): { status: 'IN_PROGRESS'; path: string } {
  const path = findRecordPath(taskId);
  if (!path) throw new Error(`Task not found: ${taskId}`);
  updateRecord(path, (frontmatter) => {
    frontmatter.status = 'in_progress';
    frontmatter.updated_at = nowIso();
  });
  return { status: 'IN_PROGRESS', path: relPath(repoPaths().root, path) };
}

export const finalizeWorkInputSchema = z.object({
  taskId: z.string().optional(),
  summary: z.string(),
  changedFiles: z.array(z.string()).default([]),
  tests: z
    .array(
      z.object({
        command: z.string(),
        status: z.string(),
      }),
    )
    .default([]),
  skippedChecks: z
    .array(
      z.object({
        command: z.string(),
        reason: z.string(),
      }),
    )
    .default([]),
  decisions: z.array(z.string()).default([]),
  result: z.string().default('implemented'),
  autoFill: z.boolean().default(false),
});

export type FinalizeWorkResult =
  | { status: 'CREATED' | 'UPDATED'; draftPath: string; requiresHumanReview: true }
  | { status: 'SKIPPED'; reason: string; requiresHumanReview: false };

export function finalizeWork(input: z.infer<typeof finalizeWorkInputSchema>): FinalizeWorkResult {
  const paths = repoPaths();
  const parsed = finalizeWorkInputSchema.parse(input);
  const changedFiles = parsed.autoFill ? mergeChangedFiles(parsed.changedFiles, gitChangedFiles(paths.root)) : parsed.changedFiles;
  const sourceTask = parsed.taskId ?? inferTaskIdFromChangedFiles(changedFiles);
  if (!sourceTask) {
    return {
      status: 'SKIPPED',
      reason: 'No confirmed task owns the changed files; taskless or git-only work does not create a run-summary draft.',
      requiresHumanReview: false,
    };
  }
  const sourceCommit = gitValue(paths.root, ['rev-parse', 'HEAD']);
  const existing = sourceCommit ? findFinalizeDraft(sourceTask, sourceCommit) : undefined;
  const id = existing?.id ?? nextRecordId('RUN');
  const timestamp = nowIso();
  const fileName = `${id.replace('RUN-', '')}.md`;
  const frontmatter = {
    id,
    type: 'run-summary',
    status: 'draft',
    title: `Run summary for ${sourceTask}`,
    created_at: existing?.createdAt ?? timestamp,
    updated_at: timestamp,
    source_task: sourceTask,
    source_commit: sourceCommit ?? null,
    modules: [...new Set(changedFiles.map(inferModule))].filter((module) => module !== 'unknown'),
    files: changedFiles,
    tags: ['run-summary'],
    retention: 'normal',
  };
  const body = `# ${frontmatter.title}

## Summary

${parsed.summary}

## Result

${parsed.result}

## Changed Files

${listOrNone(changedFiles)}

## Tests

${parsed.tests.length > 0 ? parsed.tests.map((test) => `- ${test.status}: \`${test.command}\``).join('\n') : 'Нет.'}

## Skipped Checks

${parsed.skippedChecks.length > 0 ? parsed.skippedChecks.map((check) => `- \`${check.command}\` - ${check.reason}`).join('\n') : 'Нет.'}

## Decisions

${listOrNone(parsed.decisions)}

## Review

Requires human review before promotion to active context.
`;
  const target = existing ? resolve(paths.root, existing.path) : resolve(paths.draftsDir, 'run-summaries', fileName);
  writeMarkdown(target, frontmatter, body);
  return { status: existing ? 'UPDATED' : 'CREATED', draftPath: relPath(paths.root, target), requiresHumanReview: true };
}

function inferTaskIdFromChangedFiles(changedFiles: string[]): string | undefined {
  if (changedFiles.length === 0) return undefined;
  const changed = new Set(changedFiles);
  return readRecords(false)
    .filter((record) => record.type === 'task' && (record.status === 'confirmed' || record.status === 'in_progress'))
    .find((record) => record.files.some((file) => changed.has(file)))
    ?.id;
}

function findFinalizeDraft(taskId: string, commitSha: string) {
  return readRecords(false)
    .find((record) => record.type === 'run-summary'
      && record.status === 'draft'
      && record.frontmatter.source_task === taskId
      && record.frontmatter.source_commit === commitSha);
}

function mergeChangedFiles(explicit: string[], inferred: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const file of [...explicit, ...inferred]) {
    if (seen.has(file)) continue;
    seen.add(file);
    output.push(file);
  }
  return output;
}

function gitChangedFiles(root: string): string[] {
  const tracked = gitLines(root, ['diff', '--name-only', 'HEAD']);
  const untracked = gitLines(root, ['ls-files', '--others', '--exclude-standard']);
  return [...tracked, ...untracked]
    .filter((path) => !path.startsWith('.project-context/drafts/'))
    .filter((path) => !path.startsWith('.project-context/indexes/'));
}

function gitLines(root: string, args: string[]): string[] {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitValue(root: string, args: string[]): string | undefined {
  return gitLines(root, args)[0];
}

export const decisionInputSchema = z.object({
  title: z.string(),
  context: z.string(),
  decision: z.string(),
  consequences: z.array(z.string()).default([]),
  sourceTask: z.string().optional(),
  modules: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

export function recordDecision(input: z.infer<typeof decisionInputSchema>): { draftPath: string; requiresHumanReview: true } {
  const paths = repoPaths();
  const parsed = decisionInputSchema.parse(input);
  const id = nextRecordId('DECISION');
  const timestamp = nowIso();
  const frontmatter = {
    id,
    type: 'decision',
    status: 'draft',
    title: parsed.title,
    created_at: timestamp,
    source_task: parsed.sourceTask ?? null,
    supersedes: [],
    superseded_by: null,
    modules: parsed.modules,
    tags: parsed.tags,
    retention: 'keep',
  };
  const body = `# ${id}: ${parsed.title}

## Context

${parsed.context}

## Decision

${parsed.decision}

## Consequences

${listOrNone(parsed.consequences)}
`;
  const target = resolve(paths.draftsDir, 'decisions', `${id}.md`);
  writeMarkdown(target, frontmatter, body);
  return { draftPath: relPath(paths.root, target), requiresHumanReview: true };
}

function cleanTitle(query: string): string {
  const firstLine = query.trim().split(/\r?\n/)[0] ?? query.trim();
  return firstLine.length > 100 ? `${firstLine.slice(0, 97)}...` : firstLine;
}

function blockingQuestions(query: string, mode: string): string[] {
  const lower = query.toLowerCase();
  const questions: string[] = [];
  if (/filter|фильтр/i.test(lower)) {
    questions.push('Какие поля фильтрации являются обязательными для приемки?');
    questions.push('Фильтрация должна быть backend API contract или frontend-only behavior?');
    questions.push('Должны ли фильтры сохраняться в URL query params?');
  }
  if (/role|permission|access|auth|роль|доступ|keycloak/i.test(lower)) {
    questions.push('Какие роли должны получить или потерять доступ?');
  }
  if (/migration|database|schema|liquibase|миграц|модель/i.test(lower)) {
    questions.push('Нужна ли миграция данных или только изменение схемы?');
  }
  if (mode === 'bug' || /500|bug|ошиб|падает|не работает/i.test(lower)) {
    questions.push('Какие точные шаги воспроизведения и ожидаемый результат?');
  }
  return [...new Set(questions)].slice(0, 5);
}

function inferStatements(query: string, modules: string[]): string[] {
  const inferred = [`Задача затрагивает модули: ${modules.join(', ')}.`];
  if (/api|backend|500/i.test(query)) inferred.push('Вероятно требуется backend verification.');
  if (/ui|frontend|react|фильтр/i.test(query)) inferred.push('Вероятно требуется frontend build/test verification.');
  return inferred;
}

function classifyWorkflow(query: string, mode: string, modules: string[]): WorkflowLevel {
  const lower = query.toLowerCase();
  if (isStrictWorkflow(lower, mode, modules)) return 'strict';
  if (isFastWorkflow(lower, modules)) return 'fast';
  return 'standard';
}

function isStrictWorkflow(lower: string, mode: string, modules: string[]): boolean {
  if (mode === 'bug' && /500|data loss|security|auth|access|доступ|безопасност/i.test(lower)) return true;
  if (modules.length > 1 && !modules.every((module) => module === 'doc' || module === 'tools')) return true;
  return /api|endpoint|contract|контракт|database|db|schema|liquibase|migration|persistent|persistence|repository|auth|keycloak|role|permission|access|security|secret|token|password|audit|персональн|доступ|роль|прав[ао]|безопасност|миграц|схем|баз[аы]\s+данн|репозитор/i.test(lower);
}

function isFastWorkflow(lower: string, modules: string[]): boolean {
  const onlyDocOrFrontend = modules.every((module) => module === 'doc' || module === 'frontend' || module === 'tools');
  if (!onlyDocOrFrontend) return false;
  return /readme|docs?|documentation|markdown|playbook|comment|copy|label|text|typo|lint|format|config|codex|документ|документац|описан|опечат|текст|лейбл|подпись|коммент|формат/i.test(lower);
}

function buildSuggestedContract(query: string, modules: string[], workflow: WorkflowLevel): SuggestedTaskContract {
  return {
    goal: cleanTitle(query),
    scope: suggestedScope(workflow),
    outOfScope: [
      'Unrelated refactors outside the touched module.',
      'Permanent context records for temporary investigation details.',
    ],
    acceptanceCriteria: suggestedAcceptanceCriteria(workflow),
    risks: suggestedRisks(workflow),
    testExpectations: suggestedTestExpectations(modules, workflow),
    modules,
    tags: inferTags(query),
  };
}

function suggestedScope(workflow: WorkflowLevel): string[] {
  if (workflow === 'fast') {
    return [
      'Keep the change local to the requested docs, config, tests, or small UI copy.',
      'Use a compact context pack and the smallest check that proves the change.',
    ];
  }
  if (workflow === 'strict') {
    return [
      'Confirm the API, data, persistence, authorization, or security contract before implementation.',
      'Use a full context pack with the focused playbooks for every affected module.',
      'Add or update tests around the changed contract or risk boundary.',
    ];
  }
  return [
    'Inspect the existing implementation pattern before editing.',
    'Keep changes scoped to the requested behavior and affected module.',
    'Add or update focused tests for changed behavior.',
  ];
}

function suggestedAcceptanceCriteria(workflow: WorkflowLevel): string[] {
  const base = [
    'Requested behavior is implemented without unrelated changes.',
    'Applicable verification checks pass or skipped checks have explicit reasons.',
  ];
  if (workflow === 'fast') return base;
  if (workflow === 'strict') {
    return [
      ...base,
      'Affected contracts, authorization, persistence, or data-flow behavior are covered by tests.',
      'Context finalization records verification evidence and residual risks.',
    ];
  }
  return [...base, 'Existing user-facing workflow or module contract remains consistent.'];
}

function suggestedRisks(workflow: WorkflowLevel): string[] {
  if (workflow === 'fast') return ['Fast-path classification must not hide required safety checks for risky changes.'];
  if (workflow === 'strict') return ['Contract, data, or access-control regressions may have cross-module impact.'];
  return ['Existing module behavior may have implicit coupling not visible from the initial task text.'];
}

function suggestedTestExpectations(modules: string[], workflow: WorkflowLevel): string[] {
  const config = loadProjectConfig();
  const checks = contextPackCommandsForModules(config, modules);
  if (checks.length === 0 && modules.some((module) => config.routing.documentationModules.includes(module))) {
    checks.push(contextCliCommand(config, 'lint'));
  }
  if (workflow !== 'fast' && config.commands.full_verify) {
    checks.push(`${config.commands.full_verify} when the change spans multiple modules or contracts.`);
  }
  return checks;
}

function buildWorkflowGuidance(workflow: WorkflowLevel): WorkflowGuidance {
  if (workflow === 'fast') {
    return {
      confirmation: 'Still confirm a short Task Contract before implementation.',
      contextPack: 'Use build_context_pack with workflow=fast for a compact pack.',
      reuseScan: 'Run reuse scan only before creating a new reusable capability.',
      verification: 'Run the smallest targeted check that proves the local change.',
      notes: ['Do not use fast for API, DB, auth, security, persistence, or cross-module work.'],
    };
  }
  if (workflow === 'strict') {
    return {
      confirmation: 'Confirm acceptance criteria and contract boundaries explicitly before implementation.',
      contextPack: 'Use the full context pack and all focused playbooks for affected modules.',
      reuseScan: 'Run reuse scan before adding any new reusable code or policy.',
      verification: 'Run contract-level tests and record skipped checks with reasons.',
      notes: ['Strict keeps the existing safety gates; it is not optimized for speed.'],
    };
  }
  return {
    confirmation: 'Confirm the Task Contract before implementation.',
    contextPack: 'Use the standard context pack for the affected module.',
    reuseScan: 'Run reuse scan before adding new reusable code.',
    verification: 'Run focused module checks for changed behavior.',
    notes: ['Escalate to strict if the task reveals API, DB, auth, security, or persistence impact.'],
  };
}

function isTooBroad(query: string): boolean {
  return /everything|all project|весь проект|полностью перепис/i.test(query);
}

function scoreText(query: string, text: string): number {
  const words = new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 3));
  const target = text.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (target.includes(word)) score += 1;
  }
  return score;
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : 'Нет.';
}

export function buildPackForTask(taskId: string) {
  const recordPath = findRecordPath(taskId);
  const query = recordPath ? parseRecord(recordPath).title : taskId;
  return buildContextPack({ query, taskId });
}
