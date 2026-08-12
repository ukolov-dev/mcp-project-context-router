import { resolve } from 'node:path';
import { z } from 'zod';
import { buildContextPack, type ContextPackInput } from '../context-pack/pack.js';
import { nextRecordId, parseRecord, readRecords, writeMarkdown } from '../storage/markdown.js';
import {
  idPrefixForProjectKnowledgeType,
  isProjectKnowledgeRecordType,
  projectKnowledgeRecordTypes,
  segmentForRecordType,
  type ProjectKnowledgeRecordType,
} from '../storage/record-types.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { classifyFileReference } from '../storage/file-references.js';
import { redactSecrets } from '../storage/secrets.js';
import { nowIso } from '../storage/time.js';
import type { ContextRecord } from '../storage/types.js';

export type ProjectContextSource = {
  id: string;
  type: string;
  status: string;
  title: string;
  path: string;
  reason: string;
};

export type ProjectContextSearchResult = {
  records: Array<{
    id: string;
    type: string;
    status: string;
    title: string;
    path: string;
    excerpt: string;
    sources: ProjectContextSource[];
  }>;
  sources: ProjectContextSource[];
};

export const projectKnowledgeRecordTypeSchema = z.enum(projectKnowledgeRecordTypes);

export const searchProjectContextInputSchema = z.object({
  query: z.string().default(''),
  types: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(10),
});

export const findIntegrationsInputSchema = z.object({
  query: z.string().optional(),
  systems: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(10),
});

export const findDataEntitiesInputSchema = z.object({
  query: z.string().optional(),
  entityNames: z.array(z.string()).default([]),
  fields: z.array(z.string()).default([]),
  statuses: z.array(z.string()).default([]),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(10),
});

export const getDecisionsInputSchema = z.object({
  query: z.string().optional(),
  statuses: z.array(z.string()).default(['active']),
  modules: z.array(z.string()).default([]),
  includeDrafts: z.boolean().default(false),
  includeArchive: z.boolean().default(false),
  includeSuperseded: z.boolean().default(false),
  limit: z.number().int().positive().max(50).default(10),
});

export const buildProjectContextPackInputSchema = z.object({
  query: z.string(),
  taskId: z.string().optional(),
  profile: z.enum(['default', 'local-model']).optional(),
  workflow: z.enum(['fast', 'standard', 'strict']).optional(),
  maxTokens: z.number().int().min(500).optional(),
  includeArchive: z.boolean().default(false),
  explain: z.boolean().default(false),
  modules: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  changedFiles: z.array(z.string()).default([]),
});

export const proposeContextUpdateInputSchema = z.object({
  type: projectKnowledgeRecordTypeSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  modules: z.array(z.string()).default(['doc']),
  tags: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  status: z.string().default('draft'),
  frontmatter: z.record(z.string(), z.unknown()).default({}),
  sections: z.array(z.object({
    heading: z.string().min(1),
    body: z.string().min(1),
  })).default([]),
});

type SearchInput = z.infer<typeof searchProjectContextInputSchema>;

export function searchProjectContext(input: z.input<typeof searchProjectContextInputSchema>): ProjectContextSearchResult {
  const parsed = searchProjectContextInputSchema.parse(input);
  const terms = tokenize(parsed.query);
  const records = readRecords(parsed.includeArchive)
    .filter((record) => parsed.includeDrafts || !record.path.includes('/drafts/'))
    .filter((record) => parsed.types.length === 0 || parsed.types.includes(record.type))
    .filter((record) => parsed.statuses.length === 0 || parsed.statuses.includes(record.status))
    .filter((record) => parsed.modules.length === 0 || record.modules.some((module) => parsed.modules.includes(module)))
    .filter((record) => parsed.tags.length === 0 || record.tags.some((tag) => parsed.tags.includes(tag)));

  const scored = records
    .map((record) => ({ record, score: scoreRecord(record, terms) }))
    .filter((item) => terms.length === 0 || item.score > 0)
    .sort((left, right) => right.score - left.score || left.record.path.localeCompare(right.record.path))
    .slice(0, parsed.limit);

  return recordsToSearchResult(scored.map(({ record }) => record), terms, 'Matched project context query and filters.');
}

export function findIntegrations(input: z.input<typeof findIntegrationsInputSchema>): ProjectContextSearchResult {
  const parsed = findIntegrationsInputSchema.parse(input);
  return searchProjectContext({
    query: compactQuery([parsed.query, ...parsed.systems]),
    types: ['integration'],
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  });
}

export function findDataEntities(input: z.input<typeof findDataEntitiesInputSchema>): ProjectContextSearchResult {
  const parsed = findDataEntitiesInputSchema.parse(input);
  return searchProjectContext({
    query: compactQuery([parsed.query, ...parsed.entityNames, ...parsed.fields]),
    types: ['data_entity'],
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  });
}

export function getDecisions(input: z.input<typeof getDecisionsInputSchema>): ProjectContextSearchResult {
  const parsed = getDecisionsInputSchema.parse(input);
  const result = searchProjectContext({
    query: parsed.query ?? '',
    types: ['decision'],
    statuses: parsed.statuses,
    modules: parsed.modules,
    includeDrafts: parsed.includeDrafts,
    includeArchive: parsed.includeArchive,
    limit: parsed.limit,
  });
  if (parsed.includeSuperseded) {
    return result;
  }
  const filtered = result.records.filter((record) => record.status !== 'superseded');
  return {
    records: filtered,
    sources: uniqueSources(filtered.flatMap((record) => record.sources)),
  };
}

export function buildProjectContextPack(input: z.input<typeof buildProjectContextPackInputSchema>) {
  const parsed = buildProjectContextPackInputSchema.parse(input);
  const pack = buildContextPack(parsed as ContextPackInput);
  const sources = uniqueSources(pack.records.map((record) => {
    try {
      const reference = classifyFileReference(record.path);
      if (reference.kind !== 'file') throw new Error('Unsafe or missing record path.');
      return sourceForRecord(parseRecord(reference.absolutePath), record.reason);
    } catch {
      return {
        id: record.id,
        type: 'unknown',
        status: 'unknown',
        title: record.id,
        path: record.path,
        reason: record.reason,
      };
    }
  }));
  return { ...pack, sources };
}

export function proposeContextUpdate(input: z.input<typeof proposeContextUpdateInputSchema>): {
  status: 'DRAFT_CREATED';
  draftPath: string;
  record: {
    id: string;
    type: ProjectKnowledgeRecordType;
    status: string;
    title: string;
    path: string;
  };
  sources: ProjectContextSource[];
  requiresHumanReview: true;
} {
  const parsed = proposeContextUpdateInputSchema.parse(input);
  const paths = repoPaths();
  const id = nextRecordId(idPrefixForProjectKnowledgeType(parsed.type));
  const timestamp = nowIso();
  const segment = segmentForRecordType(parsed.type);
  const frontmatter = withKnowledgeDefaults(parsed.type, {
    ...stripReservedFrontmatter(parsed.frontmatter),
    id,
    type: parsed.type,
    status: parsed.status,
    title: parsed.title,
    created_at: timestamp,
    updated_at: timestamp,
    modules: parsed.modules,
    files: parsed.files,
    tags: parsed.tags,
    source_refs: parsed.sourceRefs,
    retention: parsed.type === 'decision' || parsed.type === 'project' ? 'keep' : 'normal',
  });
  const body = renderKnowledgeBody(id, parsed.title, parsed.summary, parsed.sourceRefs, parsed.sections);
  const target = resolve(paths.draftsDir, segment, `${id}.md`);
  writeMarkdown(target, frontmatter, body);
  const record = parseRecord(target);
  const source = sourceForRecord(record, 'Created reviewable Markdown draft with YAML frontmatter.');
  return {
    status: 'DRAFT_CREATED',
    draftPath: relPath(paths.root, target),
    record: {
      id: record.id,
      type: parsed.type,
      status: record.status,
      title: record.title,
      path: record.path,
    },
    sources: [source],
    requiresHumanReview: true,
  };
}

function recordsToSearchResult(records: ContextRecord[], terms: string[], reason: string): ProjectContextSearchResult {
  const resultRecords = records.map((record) => {
    const source = sourceForRecord(record, reason);
    return {
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
      excerpt: excerptForRecord(record, terms),
      sources: [source],
    };
  });
  return {
    records: resultRecords,
    sources: uniqueSources(resultRecords.flatMap((record) => record.sources)),
  };
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
  const title = record.title.toLowerCase();
  const tags = record.tags.join(' ').toLowerCase();
  const frontmatter = JSON.stringify(record.frontmatter).toLowerCase();
  const body = record.body.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 8;
    if (tags.includes(term)) score += 5;
    if (frontmatter.includes(term)) score += 4;
    if (body.includes(term)) score += 2;
  }
  if (isProjectKnowledgeRecordType(record.type)) score += 1;
  return score;
}

function excerptForRecord(record: ContextRecord, terms: string[]): string {
  const text = redactSecrets(`${record.title}\n${record.body}`).replace(/\s+/g, ' ').trim();
  if (text.length <= 280 || terms.length === 0) return text.slice(0, 280);
  const lower = text.toLowerCase();
  const firstHit = terms
    .map((term) => lower.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, firstHit - 90);
  const end = Math.min(text.length, start + 280);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
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

function stripReservedFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set(['id', 'type', 'status', 'title', 'created_at', 'updated_at', 'modules', 'files', 'tags', 'source_refs', 'retention']);
  return Object.fromEntries(Object.entries(frontmatter).filter(([key]) => !reserved.has(key)));
}

function withKnowledgeDefaults(type: ProjectKnowledgeRecordType, frontmatter: Record<string, unknown>): Record<string, unknown> {
  const output = { ...frontmatter };
  if (type === 'source') {
    output.source_id ??= frontmatter.id;
    output.source_kind ??= 'source';
  }
  if (type === 'source_chunk') {
    output.chunk_id ??= frontmatter.id;
    output.source_id ??= 'unassigned';
  }
  if (type === 'acceptance_check') {
    output.acceptance_id ??= frontmatter.id;
    output.requirement_keys ??= [];
    output.task_keys ??= [];
  }
  return output;
}

function renderKnowledgeBody(
  id: string,
  title: string,
  summary: string,
  sourceRefs: string[],
  sections: Array<{ heading: string; body: string }>,
): string {
  const sourceSection = sourceRefs.length > 0 ? sourceRefs.map((source) => `- ${source}`).join('\n') : 'Нет.';
  const customSections = sections.map((section) => `## ${section.heading}\n\n${section.body.trim()}`).join('\n\n');
  return `# ${id}: ${title}

## Summary

${summary.trim()}

## Source References

${sourceSection}

${customSections ? `${customSections}\n\n` : ''}## Review

Draft only. Promote after human review.
`;
}
