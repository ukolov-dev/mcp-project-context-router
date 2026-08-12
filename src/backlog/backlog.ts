import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { confirmTaskContract } from '../task-validation/task.js';
import { findRecordPath, inferTags, nextRecordId, parseRecord, readRecords, updateRecord, writeMarkdown } from '../storage/markdown.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { nowIso, todayCompact } from '../storage/time.js';
import { inferModulesFromQuery } from '../storage/inference.js';
import { listVerificationEvidence } from '../verification/verification.js';
import type { ContextRecord } from '../storage/types.js';
import { contextCliCommand, loadProjectConfig } from '../storage/config.js';

export type BacklogItem = {
  id: string;
  title: string;
  status: string;
  priority: string;
  agentSize: string;
  modules: string[];
  tags: string[];
  path: string;
  summary: string;
  sourceRefs: string[];
  dependsOn: string[];
  blockedBy: string[];
  files: string[];
  acceptanceCriteria: string[];
  checks: string[];
};

export type BacklogListInput = {
  status?: string;
  modules?: string[];
  includeDone?: boolean;
  limit?: number;
  records?: ContextRecord[];
};

export type PickBacklogTaskInput = {
  query?: string;
  modules?: string[];
};

export const taskFromBacklogInputSchema = z.object({
  backlogId: z.string(),
  mode: z.enum(['preview', 'draft', 'confirm']).default('preview'),
});

export const proposeBacklogItemInputSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.string().regex(/^P\d$/).default('P2'),
  agentSize: z.enum(['small', 'medium', 'large']).default('medium'),
  status: z.enum(['proposed', 'open', 'ready', 'blocked']).default('proposed'),
  modules: z.array(z.string()).optional(),
  tags: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  force: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export const confirmBacklogItemInputSchema = z.object({
  backlogId: z.string(),
  approvedBy: z.string().min(1),
  status: z.enum(['open', 'ready', 'blocked']).default('open'),
  dryRun: z.boolean().default(false),
});

export const transitionBacklogItemInputSchema = z.object({
  backlogId: z.string(),
  status: z.enum(['open', 'ready', 'blocked', 'in_progress', 'done', 'cancelled']),
  reason: z.string().optional(),
  blockedBy: z.array(z.string()).default([]),
  evidenceId: z.string().optional(),
  dryRun: z.boolean().default(false),
});

export type BacklogDependencyGraph = {
  nodes: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    agentSize: string;
    modules: string[];
    blockedBy: string[];
    path: string;
  }>;
  edges: Array<{ from: string; to: string; status: 'resolved' | 'blocking' | 'missing' }>;
  ready: string[];
  blocked: Array<{ id: string; blockedBy: string[] }>;
  missingDependencies: Array<{ id: string; missing: string }>;
  cycles: string[][];
};

export type TaskFromBacklogResult = {
  status: 'PREVIEW' | 'DRAFT_CREATED' | 'CONFIRMED';
  backlog: BacklogItem;
  taskContract: {
    taskId: string;
    goal: string;
    scope: string[];
    outOfScope: string[];
    acceptanceCriteria: string[];
    risks: string[];
    testExpectations: string[];
    modules: string[];
    files: string[];
    tags: string[];
  };
  path?: string;
  warning?: string;
};

export type BacklogProposalResult = {
  status: 'PROPOSED' | 'DRY_RUN' | 'DUPLICATE_OR_RELATED';
  backlogId: string;
  draftPath?: string;
  item: Omit<BacklogItem, 'blockedBy' | 'path' | 'summary'> & { description: string };
  existingRecords: RelatedRecord[];
  warnings: string[];
};

export type ConfirmBacklogItemResult = {
  status: 'CONFIRMED' | 'DRY_RUN';
  backlogId: string;
  sourcePath: string;
  targetPath: string;
  archivedDraftPath?: string;
  activeStatus: string;
};

export type RelatedRecord = {
  id: string;
  type: string;
  status: string;
  path: string;
  reason: string;
  score: number;
  blocking: boolean;
};

export type TransitionBacklogItemResult = {
  status: 'DRY_RUN' | 'UPDATED';
  backlogId: string;
  from: string;
  to: string;
  path: string;
  warnings: string[];
};

export function getBacklog(input: BacklogListInput = {}): { items: BacklogItem[]; count: number } {
  const includeDone = input.includeDone ?? false;
  const statuses = new Set((input.status ?? '').split(',').map((item) => item.trim()).filter(Boolean));
  const modules = input.modules ?? [];
  const limit = input.limit ?? 50;
  const items = readBacklogItems(input.records)
    .filter((item) => statuses.size === 0 || statuses.has(item.status))
    .filter((item) => includeDone || !isDone(item.status))
    .filter((item) => modules.length === 0 || item.modules.some((module) => modules.includes(module)))
    .sort(compareBacklogItems)
    .slice(0, limit);

  return { items, count: items.length };
}

export function pickNextBacklogTask(input: PickBacklogTaskInput = {}): {
  selected: BacklogItem | null;
  alternatives: BacklogItem[];
  why: string[];
  suggestedPrompt: string | null;
  checks: string[];
} {
  const modules = input.modules ?? [];
  const query = (input.query ?? '').toLowerCase();
  const candidates = readBacklogItems()
    .filter((item) => isPickable(item.status))
    .filter((item) => item.blockedBy.length === 0)
    .filter((item) => modules.length === 0 || item.modules.some((module) => modules.includes(module)))
    .sort((left, right) => compareByQuery(left, right, query) || compareBacklogItems(left, right));

  const selected = candidates[0] ?? null;
  return {
    selected,
    alternatives: candidates.slice(1, 4),
    why: selected ? explainPick(selected, query) : ['No ready/open backlog item matched the requested filters.'],
    suggestedPrompt: selected ? `Возьми задачу ${selected.id}: ${selected.title}. Сначала собери context pack, проверь reuse, реализуй только scope этой backlog-записи и прогони проверки: ${selected.checks.join('; ')}.` : null,
    checks: selected?.checks ?? [],
  };
}

export function getBacklogDependencyGraph(input: { modules?: string[]; includeDone?: boolean } = {}): BacklogDependencyGraph {
  const modules = input.modules ?? [];
  const includeDone = input.includeDone ?? true;
  const items = readBacklogItems()
    .filter((item) => includeDone || !isDone(item.status))
    .filter((item) => modules.length === 0 || item.modules.some((module) => modules.includes(module)))
    .sort(compareBacklogItems);
  const byId = new Map(items.map((item) => [item.id, item]));
  const edges = items.flatMap((item) => item.dependsOn.map((dependencyId) => {
    const dependency = byId.get(dependencyId);
    return {
      from: item.id,
      to: dependencyId,
      status: !dependency ? 'missing' as const : isDone(dependency.status) ? 'resolved' as const : 'blocking' as const,
    };
  }));

  return {
    nodes: items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      priority: item.priority,
      agentSize: item.agentSize,
      modules: item.modules,
      blockedBy: item.blockedBy,
      path: item.path,
    })),
    edges,
    ready: items.filter((item) => isPickable(item.status) && item.blockedBy.length === 0).map((item) => item.id),
    blocked: items.filter((item) => item.blockedBy.length > 0).map((item) => ({ id: item.id, blockedBy: item.blockedBy })),
    missingDependencies: edges.filter((edge) => edge.status === 'missing').map((edge) => ({ id: edge.from, missing: edge.to })),
    cycles: findDependencyCycles(items),
  };
}

export function taskFromBacklog(input: z.infer<typeof taskFromBacklogInputSchema>): TaskFromBacklogResult {
  const parsed = taskFromBacklogInputSchema.parse(input);
  const backlog = readBacklogItems().find((item) => item.id === parsed.backlogId);
  if (!backlog) {
    throw new Error(`Backlog item not found: ${parsed.backlogId}`);
  }
  if (parsed.mode !== 'preview' && backlog.blockedBy.length > 0) {
    throw new Error(`Backlog item ${backlog.id} is blocked by: ${backlog.blockedBy.join(', ')}`);
  }

  const contract = buildTaskContract(backlog);
  if (parsed.mode === 'preview') {
    return { status: 'PREVIEW', backlog, taskContract: contract };
  }

  const draftPath = createBacklogTaskDraft(backlog, contract);
  if (parsed.mode === 'draft') {
    return { status: 'DRAFT_CREATED', backlog, taskContract: contract, path: draftPath };
  }

  const confirmed = confirmTaskContract(contract);
  const absolute = resolve(repoPaths().root, confirmed.path);
  updateRecord(absolute, (frontmatter) => {
    frontmatter.source = { kind: 'backlog', backlog_id: backlog.id, path: backlog.path };
    frontmatter.tags = contract.tags;
    frontmatter.updated_at = nowIso();
  });
  return { status: 'CONFIRMED', backlog, taskContract: contract, path: confirmed.path };
}

export function proposeBacklogItem(input: z.infer<typeof proposeBacklogItemInputSchema>): BacklogProposalResult {
  const parsed = proposeBacklogItemInputSchema.parse(input);
  const description = parsed.description?.trim() || parsed.title.trim();
  const modules = parsed.modules ?? inferModulesFromQuery(`${parsed.title}\n${description}`);
  const tags = [...new Set([...parsed.tags, ...inferTags(`${parsed.title}\n${description}`), 'backlog'])];
  const baseId = `BACKLOG-${slugify(parsed.title)}`;
  const backlogId = parsed.force ? nextAvailableBacklogId(baseId) : baseId;
  const existingRecords = relatedBacklogRecords(backlogId, parsed.title, description, modules, tags, parsed.files);
  const warnings = proposalWarnings(parsed.acceptanceCriteria, parsed.checks, parsed.dependsOn);
  const item = {
    id: backlogId,
    title: parsed.title.trim(),
    status: parsed.status,
    priority: parsed.priority,
    agentSize: parsed.agentSize,
    modules,
    tags,
    sourceRefs: parsed.sourceRefs,
    dependsOn: parsed.dependsOn,
    files: parsed.files,
    acceptanceCriteria: parsed.acceptanceCriteria,
    checks: parsed.checks,
    description,
  };

  if (existingRecords.some((record) => record.blocking) && !parsed.force) {
    return {
      status: 'DUPLICATE_OR_RELATED',
      backlogId,
      item,
      existingRecords,
      warnings: ['Related backlog record already exists. Pass force=true only when the new item is intentionally separate.', ...warnings],
    };
  }

  if (parsed.dryRun) {
    return { status: 'DRY_RUN', backlogId, item, existingRecords, warnings };
  }

  const paths = repoPaths();
  const timestamp = nowIso();
  const target = resolve(paths.draftsDir, 'backlog', `${backlogId}.md`);
  const frontmatter = {
    id: backlogId,
    type: 'backlog',
    status: parsed.status,
    priority: parsed.priority,
    agent_size: parsed.agentSize,
    title: parsed.title.trim(),
    created_at: timestamp,
    updated_at: timestamp,
    proposed_at: timestamp,
    source: { kind: 'chat_prompt' },
    source_refs: parsed.sourceRefs,
    modules,
    tags,
    depends_on: parsed.dependsOn,
    files: parsed.files,
    acceptance_criteria: parsed.acceptanceCriteria,
    checks: parsed.checks,
    retention: 'keep',
  };
  writeMarkdown(target, frontmatter, renderBacklogBody(parsed.title, description, parsed.acceptanceCriteria, parsed.checks));
  return {
    status: 'PROPOSED',
    backlogId,
    draftPath: relPath(paths.root, target),
    item,
    existingRecords,
    warnings,
  };
}

export function confirmBacklogItem(input: z.infer<typeof confirmBacklogItemInputSchema>): ConfirmBacklogItemResult {
  const parsed = confirmBacklogItemInputSchema.parse(input);
  const paths = repoPaths();
  const sourcePath = findRecordPath(parsed.backlogId);
  if (!sourcePath) {
    throw new Error(`Backlog draft not found: ${parsed.backlogId}`);
  }
  const record = parseRecord(sourcePath);
  if (record.type !== 'backlog') {
    throw new Error(`Record is not a backlog item: ${record.id}`);
  }
  if (!record.path.includes('/drafts/backlog/')) {
    throw new Error(`Backlog item is not a draft proposal: ${record.path}`);
  }
  const activeDuplicate = readRecords(false).find((candidate) => (
    candidate.type === 'backlog'
    && candidate.id === record.id
    && candidate.path.includes('/active/backlog/')
  ));
  if (activeDuplicate) {
    throw new Error(`Active backlog item already exists: ${activeDuplicate.path}`);
  }

  const target = resolve(paths.activeDir, 'backlog', `${record.id}.md`);
  const archivedDraft = uniqueTrashPath(resolve(paths.trashDir, `${record.id}.confirmed-draft.md`));
  if (parsed.dryRun) {
    return {
      status: 'DRY_RUN',
      backlogId: record.id,
      sourcePath: record.path,
      targetPath: relPath(paths.root, target),
      activeStatus: parsed.status,
    };
  }

  const timestamp = nowIso();
  const frontmatter = {
    ...record.frontmatter,
    status: parsed.status,
    approved_by: parsed.approvedBy,
    confirmed_at: timestamp,
    updated_at: timestamp,
    retention: 'keep',
  };
  writeMarkdown(target, frontmatter, record.body);
  mkdirSync(dirname(archivedDraft), { recursive: true });
  renameSync(sourcePath, archivedDraft);
  return {
    status: 'CONFIRMED',
    backlogId: record.id,
    sourcePath: record.path,
    targetPath: relPath(paths.root, target),
    archivedDraftPath: relPath(paths.root, archivedDraft),
    activeStatus: parsed.status,
  };
}

export function transitionBacklogItem(input: z.infer<typeof transitionBacklogItemInputSchema>): TransitionBacklogItemResult {
  const parsed = transitionBacklogItemInputSchema.parse(input);
  const sourcePath = findRecordPath(parsed.backlogId);
  if (!sourcePath) throw new Error(`Backlog item not found: ${parsed.backlogId}`);
  const record = parseRecord(sourcePath);
  if (record.type !== 'backlog' || !record.path.includes('/active/backlog/')) {
    throw new Error(`Backlog lifecycle transitions require an active backlog item: ${record.path}`);
  }
  const item = toBacklogItem(record);
  const warnings = validateBacklogTransition(item, parsed.status, parsed.reason, parsed.blockedBy, parsed.evidenceId);
  const failures = warnings.filter((warning) => warning.startsWith('BLOCKING:'));
  if (failures.length > 0) {
    throw new Error(failures.join(' '));
  }

  if (parsed.dryRun) {
    return { status: 'DRY_RUN', backlogId: item.id, from: item.status, to: parsed.status, path: record.path, warnings };
  }

  updateRecord(sourcePath, (frontmatter) => {
    const timestamp = nowIso();
    frontmatter.status = parsed.status;
    frontmatter.updated_at = timestamp;
    if (parsed.blockedBy.length > 0) {
      frontmatter.depends_on = [...new Set([...stringArray(frontmatter.depends_on), ...parsed.blockedBy])];
    }
    const lifecycle = Array.isArray(frontmatter.lifecycle) ? frontmatter.lifecycle : [];
    lifecycle.push({
      at: timestamp,
      from: item.status,
      to: parsed.status,
      reason: parsed.reason ?? null,
      evidence_id: parsed.evidenceId ?? null,
    });
    frontmatter.lifecycle = lifecycle;
  });
  return { status: 'UPDATED', backlogId: item.id, from: item.status, to: parsed.status, path: record.path, warnings };
}

export function readBacklogItems(records = readRecords(false)): BacklogItem[] {
  const items = records
    .filter((record) => record.path.includes('/active/backlog/') && record.type === 'backlog')
    .map(toBacklogItem);
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => ({
    ...item,
    blockedBy: item.dependsOn.filter((dependencyId) => {
      const dependency = byId.get(dependencyId);
      return !dependency || !isDone(dependency.status);
    }),
  }));
}

function relatedBacklogRecords(backlogId: string, title: string, description = '', modules: string[] = [], tags: string[] = [], files: string[] = []): RelatedRecord[] {
  const normalizedTitle = normalizeTitle(title);
  const candidateText = `${title} ${description}`;
  const candidateTokens = tokenize(`${candidateText} ${tags.join(' ')} ${modules.join(' ')} ${files.join(' ')}`);
  return readRecords(false)
    .filter((record) => ['backlog', 'task', 'decision'].includes(record.type) || record.path.includes('/backlog/'))
    .map((record) => {
      const exactId = record.id === backlogId;
      const exactTitle = normalizeTitle(record.title) === normalizedTitle;
      const score = exactId || exactTitle ? 1 : semanticScore(candidateTokens, record, modules, tags, files);
      const reasons = [
        exactId ? 'same generated backlog id' : null,
        exactTitle ? 'same normalized title' : null,
        !exactId && !exactTitle && score >= 0.3 ? 'semantic overlap in title/body/tags/modules/files' : null,
      ].filter(Boolean);
      return {
        id: record.id,
        type: record.type,
        status: record.status,
        path: record.path,
        reason: reasons.join('; '),
        score,
        blocking: exactId || exactTitle || score >= 0.62,
      };
    })
    .filter((record) => record.reason)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 8);
}

function proposalWarnings(acceptanceCriteria: string[], checks: string[], dependsOn: string[]): string[] {
  const warnings: string[] = [];
  if (acceptanceCriteria.length === 0) warnings.push('No acceptance criteria were provided; confirm before marking ready.');
  if (checks.length === 0) warnings.push('No verification checks were provided; get_verification_plan can fill this later.');
  const knownIds = new Set(readBacklogItems().map((item) => item.id));
  for (const dependencyId of dependsOn) {
    if (!knownIds.has(dependencyId)) warnings.push(`Declared dependency does not exist yet: ${dependencyId}`);
  }
  return warnings;
}

function renderBacklogBody(title: string, description: string, acceptanceCriteria: string[], checks: string[]): string {
  return `# ${title}

${description}

## Acceptance Criteria

${listOrNone(acceptanceCriteria)}

## Checks

${listOrNone(checks)}

## Review

Confirm with \`confirm-backlog-item\` after human review before treating this as active backlog.
`;
}

function validateBacklogTransition(item: BacklogItem, status: string, reason?: string, blockedBy: string[] = [], evidenceId?: string): string[] {
  const warnings: string[] = [];
  if (status === 'ready') {
    if (item.acceptanceCriteria.length === 0) warnings.push('BLOCKING: ready backlog items require acceptance_criteria.');
    if (item.checks.length === 0) warnings.push('BLOCKING: ready backlog items require checks.');
    if (item.blockedBy.length > 0) warnings.push(`BLOCKING: ready backlog item still has unresolved dependencies: ${item.blockedBy.join(', ')}.`);
  }
  if (status === 'blocked' && blockedBy.length === 0 && item.dependsOn.length === 0 && !reason) {
    warnings.push('BLOCKING: blocked transition requires blockedBy dependencies or a reason.');
  }
  if (status === 'done') {
    const evidence = evidenceId ? { count: 1 } : listVerificationEvidence({ targetId: item.id, limit: 1 });
    if (evidence.count === 0) warnings.push('BLOCKING: done transition requires verification evidence for this backlog item or an explicit evidenceId.');
  }
  if (status === 'cancelled' && !reason) {
    warnings.push('BLOCKING: cancelled transition requires a reason.');
  }
  if (status === 'open' && item.status === 'done') {
    warnings.push('Reopening a done item; keep verification evidence linked for auditability.');
  }
  return warnings;
}

function nextAvailableBacklogId(baseId: string): string {
  const existing = new Set(readRecords(false).map((record) => record.id));
  if (!existing.has(baseId)) return baseId;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseId}-${index}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`Could not allocate backlog id for ${baseId}`);
}

function slugify(title: string): string {
  const transliterated = title
    .toLowerCase()
    .replace(/[а-яё]/g, (char) => cyrillicToLatin[char] ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 72)
    .replace(/-+$/g, '');
  return (transliterated || `ITEM-${todayCompact()}`).toUpperCase();
}

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase();
}

function tokenize(text: string): Set<string> {
  return new Set(text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length > 3 && !stopWords.has(word)));
}

function semanticScore(candidateTokens: Set<string>, record: ContextRecord, modules: string[], tags: string[], files: string[]): number {
  const recordTokens = tokenize(`${record.id} ${record.title} ${record.body} ${record.tags.join(' ')} ${record.modules.join(' ')} ${record.files.join(' ')}`);
  const tokenScore = jaccard(candidateTokens, recordTokens);
  const moduleScore = overlapRatio(new Set(modules), new Set(record.modules));
  const tagScore = overlapRatio(new Set(tags), new Set(record.tags));
  const fileScore = overlapRatio(new Set(files), new Set(record.files));
  return roundScore((tokenScore * 0.6) + (moduleScore * 0.18) + (tagScore * 0.14) + (fileScore * 0.08));
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function overlapRatio(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return intersection / Math.min(left.size, right.size);
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

const stopWords = new Set([
  'with',
  'from',
  'that',
  'this',
  'для',
  'как',
  'или',
  'что',
  'это',
  'надо',
  'нужно',
  'задач',
]);

function uniqueTrashPath(path: string): string {
  if (!existsSync(path)) return path;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.replace(/\.md$/, `-${index}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate trash path for ${path}`);
}

const cyrillicToLatin: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'ts',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ы: 'y',
  э: 'e',
  ю: 'yu',
  я: 'ya',
  ь: '',
  ъ: '',
};

function buildTaskContract(backlog: BacklogItem): TaskFromBacklogResult['taskContract'] {
  const taskId = nextRecordId('TASK');
  const scope = [
    `Backlog source: ${backlog.id}.`,
    ...backlog.sourceRefs.map((ref) => `Source reference: ${ref}.`),
    ...(backlog.summary ? [`Summary: ${backlog.summary}`] : []),
  ];
  return {
    taskId,
    goal: `${backlog.title} (${backlog.id})`,
    scope,
    outOfScope: ['Unrelated backend/frontend worktree changes outside this backlog item.'],
    acceptanceCriteria: backlog.acceptanceCriteria.length > 0 ? backlog.acceptanceCriteria : ['Backlog behavior is implemented as described in the record.'],
    risks: backlog.dependsOn.length > 0 ? [`Depends on resolved backlog items: ${backlog.dependsOn.join(', ')}.`] : [],
    testExpectations: backlog.checks.length > 0
      ? backlog.checks
      : [`${contextCliCommand(loadProjectConfig(), 'verify-task')} --query "${backlog.title}"`],
    modules: backlog.modules,
    files: backlog.files,
    tags: [...new Set([...backlog.tags, 'from-backlog'])],
  };
}

function createBacklogTaskDraft(backlog: BacklogItem, contract: TaskFromBacklogResult['taskContract']): string {
  const paths = repoPaths();
  const timestamp = nowIso();
  const frontmatter = {
    id: contract.taskId,
    type: 'task',
    status: 'validating',
    title: contract.goal,
    created_at: timestamp,
    updated_at: timestamp,
    confirmed_by_human: false,
    source: { kind: 'backlog', backlog_id: backlog.id, path: backlog.path },
    related: { bugs: [], decisions: [], refactors: [] },
    modules: contract.modules,
    files: contract.files,
    tags: contract.tags,
    retention: 'normal',
  };
  const body = `# ${contract.taskId}: ${contract.goal}

## Goal

${contract.goal}

## Scope

${listOrNone(contract.scope)}

## Out Of Scope

${listOrNone(contract.outOfScope)}

## Acceptance Criteria

${listOrNone(contract.acceptanceCriteria)}

## Open Questions

Нет.

## Risks

${listOrNone(contract.risks)}

## Verification Plan

${listOrNone(contract.testExpectations)}
`;
  const target = resolve(paths.draftsDir, 'tasks', `${contract.taskId}.md`);
  mkdirSync(resolve(paths.draftsDir, 'tasks'), { recursive: true });
  writeMarkdown(target, frontmatter, body);
  return relPath(paths.root, target);
}

function findDependencyCycles(items: BacklogItem[]): string[][] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  function visit(id: string): void {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      if (index >= 0) cycles.push([...stack.slice(index), id]);
      return;
    }
    if (visited.has(id)) return;
    const item = byId.get(id);
    if (!item) return;
    visiting.add(id);
    stack.push(id);
    for (const dependencyId of item.dependsOn) visit(dependencyId);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }

  for (const item of items) visit(item.id);
  return cycles;
}

function toBacklogItem(record: ContextRecord): BacklogItem {
  const frontmatter = record.frontmatter;
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    priority: stringValue(frontmatter.priority, 'P2'),
    agentSize: stringValue(frontmatter.agent_size, 'medium'),
    modules: record.modules,
    tags: record.tags,
    path: record.path,
    summary: summarize(record.body),
    sourceRefs: stringArray(frontmatter.source_refs),
    dependsOn: stringArray(frontmatter.depends_on),
    blockedBy: [],
    files: record.files,
    acceptanceCriteria: stringArray(frontmatter.acceptance_criteria),
    checks: stringArray(frontmatter.checks),
  };
}

function compareBacklogItems(left: BacklogItem, right: BacklogItem): number {
  return statusScore(left.status) - statusScore(right.status)
    || priorityScore(left.priority) - priorityScore(right.priority)
    || sizeScore(left.agentSize) - sizeScore(right.agentSize)
    || left.id.localeCompare(right.id);
}

function compareByQuery(left: BacklogItem, right: BacklogItem, query: string): number {
  if (!query) return 0;
  return scoreItem(right, query) - scoreItem(left, query);
}

function scoreItem(item: BacklogItem, query: string): number {
  const haystack = `${item.id} ${item.title} ${item.summary} ${item.tags.join(' ')} ${item.modules.join(' ')}`.toLowerCase();
  return query.split(/\s+/).filter((term) => term && haystack.includes(term)).length;
}

function explainPick(item: BacklogItem, query: string): string[] {
  const reasons = [
    `status=${item.status}`,
    `priority=${item.priority}`,
    `agent_size=${item.agentSize}`,
  ];
  if (query && scoreItem(item, query) > 0) {
    reasons.push('matched requested query terms');
  }
  if (item.dependsOn.length === 0) {
    reasons.push('no declared backlog dependencies');
  } else {
    reasons.push('declared dependencies are resolved');
  }
  return reasons;
}

function isPickable(status: string): boolean {
  return status === 'ready' || status === 'open';
}

function isDone(status: string): boolean {
  return status === 'done' || status === 'cancelled';
}

function statusScore(status: string): number {
  const order: Record<string, number> = {
    ready: 0,
    open: 1,
    in_progress: 2,
    blocked: 3,
    done: 4,
    cancelled: 5,
  };
  return order[status] ?? 9;
}

function priorityScore(priority: string): number {
  const match = /^P(\d)$/i.exec(priority);
  return match ? Number(match[1]) : 9;
}

function sizeScore(size: string): number {
  const order: Record<string, number> = {
    small: 0,
    medium: 1,
    large: 2,
  };
  return order[size] ?? 9;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function summarize(body: string): string {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .slice(0, 3)
    .join(' ')
    .slice(0, 600);
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : 'Нет.';
}
