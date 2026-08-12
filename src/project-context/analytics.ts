import { z } from 'zod';
import { proposeBacklogItem } from '../backlog/backlog.js';
import { readRecords } from '../storage/markdown.js';
import type { ContextRecord } from '../storage/types.js';
import type { ProjectContextSource } from './project-context.js';
import { contextCliCommand, loadProjectConfig } from '../storage/config.js';

type AnalystRecordResult = {
  id: string;
  type: string;
  status: string;
  title: string;
  path: string;
  excerpt: string;
  sources: ProjectContextSource[];
};

type AnalystSearchResult = {
  records: AnalystRecordResult[];
  sources: ProjectContextSource[];
};

export const findRequirementsInputSchema = z.object({
  query: z.string().optional(),
  requirementKeys: z.array(z.string()).default([]),
  areas: z.array(z.string()).default([]),
  sourceIds: z.array(z.string()).default([]),
  chunkIds: z.array(z.string()).default([]),
  taskIds: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(true),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(20),
});

export const findSourceChunksInputSchema = z.object({
  query: z.string().optional(),
  sourceIds: z.array(z.string()).default([]),
  chunkIds: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
  systemAreas: z.array(z.string()).default([]),
  informationTypes: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(true),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(20),
});

export const getOpenQuestionsInputSchema = z.object({
  query: z.string().optional(),
  questionKinds: z.array(z.string()).default([]),
  owners: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(true),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(100).default(20),
});

export const traceRequirementInputSchema = z.object({
  requirementKey: z.string().optional(),
  query: z.string().optional(),
  includeDrafts: z.boolean().default(true),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(20).default(5),
});

export const buildAnalystContextPackInputSchema = z.object({
  query: z.string(),
  includeDrafts: z.boolean().default(true),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(10),
});

export const analystDeltaToBacklogInputSchema = z.object({
  query: z.string(),
  apply: z.boolean().default(false),
  force: z.boolean().default(false),
  limit: z.number().int().positive().max(20).default(5),
});

export function findRequirements(input: z.input<typeof findRequirementsInputSchema>, records?: ContextRecord[]): AnalystSearchResult {
  const parsed = findRequirementsInputSchema.parse(input);
  return searchRecords({
    types: ['requirement'],
    query: compactQuery([
      parsed.query,
      ...parsed.requirementKeys,
      ...parsed.areas,
      ...parsed.sourceIds,
      ...parsed.chunkIds,
      ...parsed.taskIds,
    ]),
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
    filters: [
      (record) => matchesFrontmatterAny(record, 'requirement_key', parsed.requirementKeys),
      (record) => matchesFrontmatterAny(record, 'requirement_area', parsed.areas),
      (record) => matchesFrontmatterAny(record, 'source_ids', parsed.sourceIds),
      (record) => matchesFrontmatterAny(record, 'chunk_ids', parsed.chunkIds),
      (record) => matchesFrontmatterAny(record, 'task_keys', parsed.taskIds),
    ],
    reason: 'Matched analyst requirement query and filters.',
    records,
  });
}

export function findSourceChunks(input: z.input<typeof findSourceChunksInputSchema>, records?: ContextRecord[]): AnalystSearchResult {
  const parsed = findSourceChunksInputSchema.parse(input);
  return searchRecords({
    types: ['source_chunk'],
    query: compactQuery([
      parsed.query,
      ...parsed.sourceIds,
      ...parsed.chunkIds,
      ...parsed.topics,
      ...parsed.systemAreas,
      ...parsed.informationTypes,
    ]),
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
    filters: [
      (record) => matchesFrontmatterAny(record, 'source_id', parsed.sourceIds),
      (record) => matchesFrontmatterAny(record, 'chunk_id', parsed.chunkIds),
      (record) => matchesFrontmatterAny(record, 'topic', parsed.topics),
      (record) => matchesFrontmatterAny(record, 'system_area', parsed.systemAreas),
      (record) => matchesFrontmatterAny(record, 'information_type', parsed.informationTypes),
    ],
    reason: 'Matched analyst source chunk query and filters.',
    records,
  });
}

export function getOpenQuestions(input: z.input<typeof getOpenQuestionsInputSchema>, records?: ContextRecord[]): AnalystSearchResult {
  const parsed = getOpenQuestionsInputSchema.parse(input);
  return searchRecords({
    types: ['open_question'],
    query: compactQuery([parsed.query, ...parsed.questionKinds, ...parsed.owners]),
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
    filters: [
      (record) => matchesFrontmatterAny(record, 'question_kind', parsed.questionKinds),
      (record) => matchesFrontmatterAny(record, 'owner', parsed.owners),
    ],
    reason: 'Matched analyst open question query and filters.',
    records,
  });
}

export function getConflicts(input: z.input<typeof getOpenQuestionsInputSchema>): AnalystSearchResult {
  const parsed = getOpenQuestionsInputSchema.parse(input);
  return getOpenQuestions({
    ...parsed,
    questionKinds: parsed.questionKinds.length > 0 ? parsed.questionKinds : ['conflict'],
  });
}

export function traceRequirement(input: z.input<typeof traceRequirementInputSchema>) {
  const parsed = traceRequirementInputSchema.parse(input);
  const records = readRecords(parsed.includeArchive).filter((record) => parsed.includeDrafts || !isDraft(record));
  const requirements = findRequirements({
    query: parsed.query,
    requirementKeys: parsed.requirementKey ? [parsed.requirementKey] : [],
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  }, records).records;
  const traces = requirements.map((requirement) => {
    const record = records.find((candidate) => candidate.id === requirement.id);
    const sourceIds = stringValues(record?.frontmatter.source_ids);
    const chunkIds = stringValues(record?.frontmatter.chunk_ids);
    const taskKeys = stringValues(record?.frontmatter.task_keys);
    const acceptanceIds = stringValues(record?.frontmatter.acceptance_ids);
    return {
      requirement,
      sources: toResults(records.filter((candidate) => candidate.type === 'source' && sourceIds.includes(String(candidate.frontmatter.source_id))), 'Source linked from requirement traceability.'),
      chunks: toResults(records.filter((candidate) => candidate.type === 'source_chunk' && chunkIds.includes(String(candidate.frontmatter.chunk_id))), 'Chunk linked from requirement traceability.'),
      tasks: toResults(records.filter((candidate) => (candidate.type === 'task' || candidate.type === 'backlog') && taskKeys.some((task) => recordContains(candidate, task))), 'Task or backlog item linked from requirement traceability.'),
      acceptanceChecks: toResults(records.filter((candidate) => candidate.type === 'acceptance_check' && acceptanceIds.includes(String(candidate.frontmatter.acceptance_id))), 'Acceptance check linked from requirement traceability.'),
    };
  });
  return {
    traces,
    sources: uniqueSources(traces.flatMap((trace) => [
      ...trace.requirement.sources,
      ...trace.sources.flatMap((record) => record.sources),
      ...trace.chunks.flatMap((record) => record.sources),
      ...trace.tasks.flatMap((record) => record.sources),
      ...trace.acceptanceChecks.flatMap((record) => record.sources),
    ])),
  };
}

export function buildAnalystContextPack(input: z.input<typeof buildAnalystContextPackInputSchema>) {
  const parsed = buildAnalystContextPackInputSchema.parse(input);
  const records = readRecords(parsed.includeArchive);
  const requirements = findRequirements({
    query: parsed.query,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  }, records);
  const chunks = findSourceChunks({
    query: parsed.query,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  }, records);
  const questions = getOpenQuestions({
    query: parsed.query,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  }, records);
  const decisions = searchRecords({
    types: ['decision'],
    query: parsed.query,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: Math.min(parsed.limit, 10),
    filters: [],
    reason: 'Matched analyst decision context.',
    records,
  });
  return {
    summary: `Analyst context pack for "${parsed.query}".`,
    requirements: requirements.records,
    sourceChunks: chunks.records,
    openQuestions: questions.records,
    decisions: decisions.records,
    sources: uniqueSources([
      ...requirements.sources,
      ...chunks.sources,
      ...questions.sources,
      ...decisions.sources,
    ]),
  };
}

export function analystDeltaToBacklog(input: z.input<typeof analystDeltaToBacklogInputSchema>) {
  const parsed = analystDeltaToBacklogInputSchema.parse(input);
  const candidates = searchRecords({
    types: ['requirement', 'open_question'],
    query: parsed.query,
    includeDrafts: true,
    includeArchive: false,
    limit: parsed.limit,
    filters: [],
    reason: 'Matched analyst delta backlog candidate.',
  }).records;
  const proposals = candidates.map((candidate) => proposeBacklogItem({
    title: candidate.title,
    description: candidate.excerpt,
    priority: candidate.type === 'open_question' ? 'P2' : 'P1',
    agentSize: 'medium',
    status: 'proposed',
    modules: ['doc'],
    tags: ['analyst-delta', 'from-project-context'],
    sourceRefs: [candidate.path],
    dependsOn: [],
    files: [],
    acceptanceCriteria: [
      'Analyst-confirmed delta is reflected in the relevant specification, task contract, or backlog decision.',
    ],
    checks: [contextCliCommand(loadProjectConfig(), 'lint')],
    force: parsed.force,
    dryRun: !parsed.apply,
  }));
  return {
    status: parsed.apply ? 'DRAFTS_CREATED' : 'DRY_RUN',
    count: proposals.length,
    proposals,
    sources: uniqueSources(candidates.flatMap((candidate) => candidate.sources)),
  };
}

function searchRecords(input: {
  types: string[];
  query?: string;
  statuses?: string[];
  modules?: string[];
  includeDrafts: boolean;
  includeArchive: boolean;
  limit: number;
  filters: Array<(record: ContextRecord) => boolean>;
  reason: string;
  records?: ContextRecord[];
}): AnalystSearchResult {
  const terms = tokenize(input.query ?? '');
  const statuses = input.statuses ?? [];
  const modules = input.modules ?? [];
  const scored = (input.records ?? readRecords(input.includeArchive))
    .filter((record) => input.includeDrafts || !isDraft(record))
    .filter((record) => input.types.includes(record.type))
    .filter((record) => statuses.length === 0 || statuses.includes(record.status))
    .filter((record) => modules.length === 0 || record.modules.some((module) => modules.includes(module)))
    .filter((record) => input.filters.every((filter) => filter(record)))
    .map((record) => ({ record, score: scoreRecord(record, terms) }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.record.path.localeCompare(right.record.path))
    .slice(0, input.limit)
    .map((item) => item.record);
  const records = toResults(scored, input.reason, terms);
  return {
    records,
    sources: uniqueSources(records.flatMap((record) => record.sources)),
  };
}

function toResults(records: ContextRecord[], reason: string, terms: string[] = []): AnalystRecordResult[] {
  return records.map((record) => ({
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    path: record.path,
    excerpt: excerptForRecord(record, terms),
    sources: [sourceForRecord(record, reason)],
  }));
}

function sourceForRecord(record: ContextRecord, reason: string): ProjectContextSource {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    path: record.path,
    reason,
  };
}

function scoreRecord(record: ContextRecord, terms: string[]): number {
  if (terms.length === 0) return 1;
  const haystack = `${record.title}\n${record.tags.join(' ')}\n${JSON.stringify(record.frontmatter)}\n${record.body}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (record.title.toLowerCase().includes(term)) score += 8;
    if (record.tags.join(' ').toLowerCase().includes(term)) score += 5;
    if (JSON.stringify(record.frontmatter).toLowerCase().includes(term)) score += 4;
    if (haystack.includes(term)) score += 2;
  }
  return score;
}

function excerptForRecord(record: ContextRecord, terms: string[]): string {
  const text = `${record.title}\n${record.body}`.replace(/\s+/g, ' ').trim();
  if (text.length <= 320 || terms.length === 0) return text.slice(0, 320);
  const lower = text.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstHit - 100);
  const end = Math.min(text.length, start + 320);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function matchesFrontmatterAny(record: ContextRecord, field: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const values = stringValues(record.frontmatter[field]);
  return filters.some((filter) => values.includes(filter));
}

function stringValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (value === undefined || value === null) return [];
  return [String(value)];
}

function recordContains(record: ContextRecord, value: string): boolean {
  return `${record.id}\n${record.title}\n${JSON.stringify(record.frontmatter)}\n${record.body}`.includes(value);
}

function uniqueSources(sources: ProjectContextSource[]): ProjectContextSource[] {
  const byKey = new Map<string, ProjectContextSource>();
  for (const source of sources) {
    byKey.set(`${source.id}:${source.path}`, source);
  }
  return [...byKey.values()];
}

function tokenize(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1))];
}

function compactQuery(parts: Array<string | undefined>): string {
  return parts.map((part) => part?.trim()).filter(Boolean).join(' ');
}

function isDraft(record: ContextRecord): boolean {
  return record.path.includes('/drafts/');
}
