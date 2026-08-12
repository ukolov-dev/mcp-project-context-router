import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { findRecordPath, parseRecord, readRecords, writeMarkdown } from '../storage/markdown.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { nowIso } from '../storage/time.js';
import { segmentForRecordType } from '../storage/record-types.js';

export const promoteDraftInputSchema = z.object({
  recordId: z.string(),
  apply: z.boolean().default(false),
  approvedBy: z.string().optional(),
});

export const promoteDraftsBatchInputSchema = z.object({
  recordIds: z.array(z.string()).default([]),
  types: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default(['draft']),
  query: z.string().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  apply: z.boolean().default(false),
  approvedBy: z.string().optional(),
  all: z.boolean().default(false),
});

export type PromoteDraftResult = {
  status: 'DRY_RUN' | 'PROMOTED';
  recordId: string;
  sourcePath: string;
  targetPath: string;
  archivedDraftPath?: string;
  changes: Record<string, unknown>;
  warnings: string[];
};

export type PromoteDraftsBatchResult = {
  status: 'DRY_RUN' | 'PROMOTED';
  apply: boolean;
  totalMatched: number;
  count: number;
  truncated: boolean;
  filters: {
    recordIds: string[];
    types: string[];
    tags: string[];
    statuses: string[];
    query?: string;
    all: boolean;
  };
  records: PromoteDraftResult[];
  warnings: string[];
};

export function promoteDraft(input: z.infer<typeof promoteDraftInputSchema>): PromoteDraftResult {
  const parsed = promoteDraftInputSchema.parse(input);
  const paths = repoPaths();
  const sourcePath = findRecordPath(parsed.recordId);
  if (!sourcePath) {
    throw new Error(`Context record not found: ${parsed.recordId}`);
  }
  const record = parseRecord(sourcePath);
  if (!record.path.includes('/drafts/')) {
    throw new Error(`Record is not a draft: ${record.id} (${record.path})`);
  }
  if (record.type === 'task' && record.frontmatter.confirmed_by_human !== true) {
    throw new Error(`Draft task ${record.id} must be promoted with confirm-task, not promote-draft.`);
  }
  const segment = segmentForRecordType(record.type);
  if (parsed.apply && !parsed.approvedBy?.trim()) {
    throw new Error('--approved-by is required when --apply is used.');
  }

  const target = resolve(paths.activeDir, segment, `${record.id}.md`);
  const newStatus = promotedStatus(record.type, record.status);
  const changes = {
    status: record.status === newStatus ? record.status : `${record.status} -> ${newStatus}`,
    approved_by: parsed.approvedBy ?? null,
    promoted_at: parsed.apply ? nowIso() : '<promotion timestamp>',
    updated_at: parsed.apply ? nowIso() : '<promotion timestamp>',
  };
  const warnings = record.type === 'run-summary'
    ? ['Run summaries are review artifacts; promote only summaries that should become durable project memory.']
    : [];

  if (!parsed.apply) {
    return {
      status: 'DRY_RUN',
      recordId: record.id,
      sourcePath: record.path,
      targetPath: relPath(paths.root, target),
      changes,
      warnings,
    };
  }

  const timestamp = nowIso();
  const frontmatter = {
    ...record.frontmatter,
    status: newStatus,
    approved_by: parsed.approvedBy,
    promoted_at: timestamp,
    updated_at: timestamp,
  };
  mkdirSync(dirname(target), { recursive: true });
  writeMarkdown(target, frontmatter, record.body);

  const archivedDraft = uniqueTrashPath(resolve(paths.trashDir, `${record.id}.promoted-draft.md`));
  mkdirSync(dirname(archivedDraft), { recursive: true });
  renameSync(sourcePath, archivedDraft);

  return {
    status: 'PROMOTED',
    recordId: record.id,
    sourcePath: record.path,
    targetPath: relPath(paths.root, target),
    archivedDraftPath: relPath(paths.root, archivedDraft),
    changes: {
      status: newStatus,
      approved_by: parsed.approvedBy,
      promoted_at: timestamp,
      updated_at: timestamp,
    },
    warnings,
  };
}

export function promoteDraftsBatch(input: z.infer<typeof promoteDraftsBatchInputSchema>): PromoteDraftsBatchResult {
  const parsed = promoteDraftsBatchInputSchema.parse(input);
  if (!parsed.all && parsed.recordIds.length === 0 && parsed.types.length === 0 && parsed.tags.length === 0 && !parsed.query?.trim()) {
    throw new Error('Refusing broad batch promotion without selectors. Provide --record-ids, --types, --tags, --query, or --all.');
  }
  if (parsed.apply && !parsed.approvedBy?.trim()) {
    throw new Error('--approved-by is required when --apply is used.');
  }

  const candidates = readRecords(false)
    .filter((record) => record.path.includes('/drafts/'))
    .filter((record) => parsed.recordIds.length === 0 || parsed.recordIds.includes(record.id))
    .filter((record) => parsed.types.length === 0 || parsed.types.includes(record.type))
    .filter((record) => parsed.statuses.length === 0 || parsed.statuses.includes(record.status))
    .filter((record) => parsed.tags.every((tag) => record.tags.includes(tag)))
    .filter((record) => matchesQuery(record, parsed.query))
    .sort((left, right) => left.path.localeCompare(right.path));

  const limited = parsed.limit ? candidates.slice(0, parsed.limit) : candidates;
  const warnings = batchWarnings(parsed, candidates.length, limited.length);

  const previews = limited.map((record) => promoteDraft({
    recordId: record.id,
    apply: false,
    approvedBy: parsed.approvedBy,
  }));

  if (!parsed.apply) {
    return {
      status: 'DRY_RUN',
      apply: false,
      totalMatched: candidates.length,
      count: previews.length,
      truncated: limited.length < candidates.length,
      filters: batchFilters(parsed),
      records: previews,
      warnings,
    };
  }

  const promoted = limited.map((record) => promoteDraft({
    recordId: record.id,
    apply: true,
    approvedBy: parsed.approvedBy,
  }));
  return {
    status: 'PROMOTED',
    apply: true,
    totalMatched: candidates.length,
    count: promoted.length,
    truncated: limited.length < candidates.length,
    filters: batchFilters(parsed),
    records: promoted,
    warnings,
  };
}

function promotedStatus(type: string, current: string): string {
  if (type === 'backlog') return current;
  if (type === 'task') return current;
  if (type === 'decision') return 'active';
  if (type === 'runbook') return 'active';
  if (type === 'pattern') return 'active';
  if (type === 'run-summary') return 'reviewed';
  if (type === 'refactor') return current === 'draft' ? 'proposed' : current;
  if (type === 'bug') return current === 'draft' ? 'confirmed' : current;
  if (type === 'project') return 'active';
  if (type === 'integration') return 'active';
  if (type === 'data_entity') return 'active';
  if (type === 'api') return 'active';
  if (type === 'requirement') return current === 'draft' ? 'proposed' : current;
  if (type === 'open_question') return current === 'draft' ? 'open' : current;
  if (type === 'meeting_draft') return 'reviewed';
  if (type === 'source') return 'active';
  if (type === 'source_chunk') return 'active';
  if (type === 'acceptance_check') return current === 'draft' ? 'proposed' : current;
  return current;
}

function matchesQuery(record: ReturnType<typeof readRecords>[number], query: string | undefined): boolean {
  const terms = tokenize(query);
  if (terms.length === 0) return true;
  const haystack = `${record.id}\n${record.title}\n${JSON.stringify(record.frontmatter)}\n${record.body}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function tokenize(query: string | undefined): string[] {
  return [...new Set((query ?? '').toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1))];
}

function batchFilters(parsed: z.infer<typeof promoteDraftsBatchInputSchema>) {
  return {
    recordIds: parsed.recordIds,
    types: parsed.types,
    tags: parsed.tags,
    statuses: parsed.statuses,
    query: parsed.query,
    all: parsed.all,
  };
}

function batchWarnings(parsed: z.infer<typeof promoteDraftsBatchInputSchema>, totalMatched: number, selected: number): string[] {
  const warnings: string[] = [];
  if (totalMatched === 0) {
    warnings.push('No matching draft records found.');
  }
  if (selected < totalMatched) {
    warnings.push(`Matched ${totalMatched} draft records but selected ${selected} because --limit was used.`);
  }
  if (parsed.types.length === 0 && parsed.recordIds.length === 0) {
    warnings.push('No type or record-id filter was provided; review the manifest carefully before applying.');
  }
  return warnings;
}

function uniqueTrashPath(path: string): string {
  if (!existsSync(path)) return path;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = path.replace(/\.md$/, `-${index}.md`);
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not allocate trash path for ${path}`);
}
