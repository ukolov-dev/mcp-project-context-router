import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { proposeBacklogItem } from '../backlog/backlog.js';
import { classifyFileReference } from '../storage/file-references.js';
import { writeMarkdown } from '../storage/markdown.js';
import { segmentForRecordType } from '../storage/record-types.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { nowIso } from '../storage/time.js';
import { contextCliCommand, loadProjectConfig } from '../storage/config.js';

export const defaultRpArchivePath = '.project-context/source-archives/rp';

export const importRpDatabaseInputSchema = z.object({
  path: z.string().default(defaultRpArchivePath),
  apply: z.boolean().default(false),
  limit: z.number().int().positive().max(2000).optional(),
  includeSources: z.boolean().default(true),
  includeChunks: z.boolean().default(true),
  includeTraceability: z.boolean().default(true),
  includeDecisions: z.boolean().default(true),
});

export const proposeAnalystSourceInputSchema = z.object({
  sourceId: z.string().optional(),
  title: z.string().min(1),
  summary: z.string().min(1),
  sourcePath: z.string().optional(),
  sourceKind: z.string().default('document'),
  tags: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  apply: z.boolean().default(false),
});

type ImportRecord = {
  id: string;
  type: string;
  status: string;
  title: string;
  path: string;
  frontmatter: Record<string, unknown>;
  body: string;
};

type MarkdownTable = {
  heading: string;
  headers: string[];
  rows: string[][];
};

const importDate = '20260630';

export function importRpDatabase(input: z.input<typeof importRpDatabaseInputSchema> = {}) {
  const parsed = importRpDatabaseInputSchema.parse(input);
  const paths = repoPaths();
  const rpReference = classifyFileReference(parsed.path);
  if (rpReference.kind !== 'directory') {
    throw new Error(`RP archive path must be a repository directory: ${parsed.path}`);
  }
  const rpRoot = rpReference.absolutePath;
  const timestamp = nowIso();
  const records: ImportRecord[] = [];

  if (parsed.includeSources) {
    records.push(...buildSourceRecords(rpRoot, parsed.path, timestamp));
  }
  if (parsed.includeChunks) {
    records.push(...buildChunkRecords(rpRoot, parsed.path, timestamp));
  }
  if (parsed.includeTraceability) {
    records.push(...buildTraceabilityRecords(rpRoot, parsed.path, timestamp));
  }
  if (parsed.includeDecisions) {
    records.push(...buildDecisionRecords(rpRoot, parsed.path, timestamp));
  }

  const limited = parsed.limit ? records.slice(0, parsed.limit) : records;
  if (parsed.apply) {
    for (const record of limited) {
      writeMarkdown(resolve(paths.root, record.path), record.frontmatter, record.body);
    }
  }

  return {
    status: parsed.apply ? 'DRAFTS_CREATED' : 'DRY_RUN',
    root: parsed.path,
    count: limited.length,
    truncated: limited.length < records.length,
    records: limited.map((record) => ({
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
    })),
    sources: limited.map((record) => ({
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
      reason: parsed.apply ? 'Created RP import draft record.' : 'Previewed RP import draft record.',
    })),
  };
}

export function proposeAnalystSource(input: z.input<typeof proposeAnalystSourceInputSchema>) {
  const parsed = proposeAnalystSourceInputSchema.parse(input);
  const paths = repoPaths();
  const timestamp = nowIso();
  const index = nextStableIndex('source', parsed.sourceId ?? parsed.title);
  const id = stableId('SOURCE', index);
  const sourcePath = repositoryFile(parsed.sourcePath);
  const files = sourcePath ? [sourcePath] : [];
  const record = makeRecord({
    id,
    type: 'source',
    title: parsed.title,
    status: 'draft',
    timestamp,
    modules: ['doc', 'analysis'],
    files,
    tags: ['analyst-source', ...parsed.tags],
    sourceRefs: parsed.sourceRefs,
    frontmatter: {
      source_id: parsed.sourceId ?? id,
      source_path: sourcePath,
      source_kind: parsed.sourceKind,
      processed_status: 'proposed',
    },
    body: `# ${parsed.title}

## Summary

${parsed.summary.trim()}

## Review

Draft only. Register chunks, derived requirements, decisions and open questions before promotion.
`,
  });
  if (parsed.apply) {
    writeMarkdown(resolve(paths.root, record.path), record.frontmatter, record.body);
  }
  return {
    status: parsed.apply ? 'DRAFT_CREATED' : 'DRY_RUN',
    record: {
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
    },
    sources: [{
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
      reason: parsed.apply ? 'Created analyst source draft.' : 'Previewed analyst source draft.',
    }],
    requiresHumanReview: true,
  };
}

function buildSourceRecords(rpRoot: string, rpPath: string, timestamp: string): ImportRecord[] {
  const sourceRegister = resolve(rpRoot, 'database/00_source_register.md');
  const tables = readTables(sourceRegister);
  const table = tables.find((candidate) => candidate.headers.includes('ID') && candidate.headers.some((header) => header.includes('Файл RAW')));
  if (!table) return [];
  return table.rows.map((row, index) => {
    const sourceId = clean(row[0]);
    const rawPath = clean(row[1]);
    const summary = clean(row[2]);
    const processedStatus = clean(row[3]);
    const filePath = repositoryFile(rawPath ? `${rpPath}/${rawPath}` : undefined);
    const files = filePath ? [filePath] : [];
    return makeRecord({
      id: stableId('SOURCE', index + 1),
      type: 'source',
      title: `${sourceId}: ${truncate(summary, 90)}`,
      status: 'draft',
      timestamp,
      modules: ['doc', 'analysis'],
      files,
      tags: ['rp', 'source', sourceKindFromPath(rawPath)],
      sourceRefs: [`${rpPath}/database/00_source_register.md`],
      frontmatter: {
        source_id: sourceId,
        source_path: filePath,
        source_kind: sourceKindFromPath(rawPath),
        processed_status: processedStatus,
      },
      body: `# ${sourceId}: ${truncate(summary, 120)}

## Summary

${summary || 'Нет описания.'}

## Source Path

${filePath ? `- ${filePath}` : 'Нет.'}

## Processing Status

${processedStatus || 'Не указан.'}

## Review

Imported from the curated RP source register as a draft. Do not promote without human review.
`,
    });
  });
}

function buildChunkRecords(rpRoot: string, rpPath: string, timestamp: string): ImportRecord[] {
  const chunkIndex = resolve(rpRoot, 'database/chunks/chunk_index.md');
  const tables = readTables(chunkIndex);
  const table = tables.find((candidate) => candidate.headers.includes('Chunk ID') && candidate.headers.includes('Source ID'));
  if (!table) return [];
  return table.rows.map((row, index) => {
    const chunkId = clean(row[0]);
    const sourceId = clean(row[1]);
    const sourcePath = clean(row[2]);
    const date = clean(row[3]);
    const topic = clean(row[4]);
    const systemArea = clean(row[5]);
    const informationType = clean(row[6]);
    const summary = clean(row[7]);
    const knowledgeStatus = clean(row[8]);
    const domainFiles = splitRefs(clean(row[9]));
    const chunkFile = `${rpPath}/database/chunks/${sourceId}_chunks.md`;
    const files = [chunkFile, `${rpPath}/database/chunks/chunk_index.md`]
      .map((file) => repositoryFile(file))
      .filter((file): file is string => Boolean(file));
    return makeRecord({
      id: stableId('SOURCE-CHUNK', index + 1),
      type: 'source_chunk',
      title: `${chunkId}: ${truncate(topic || summary, 100)}`,
      status: 'draft',
      timestamp,
      modules: ['doc', 'analysis'],
      files,
      tags: ['rp', 'source-chunk', informationType.toLowerCase().replace(/\s+/g, '-')].filter(Boolean),
      sourceRefs: [`${rpPath}/database/chunks/chunk_index.md`, chunkFile],
      frontmatter: {
        chunk_id: chunkId,
        source_id: sourceId,
        source_path: sourcePath,
        source_date: date,
        topic,
        system_area: systemArea,
        information_type: informationType,
        knowledge_status: knowledgeStatus,
        domain_files: domainFiles,
      },
      body: `# ${chunkId}: ${topic || sourceId}

## Summary

${summary || 'Нет описания.'}

## Classification

- Source: ${sourceId}
- Topic: ${topic || 'Не указана.'}
- System area: ${systemArea || 'Не указана.'}
- Information type: ${informationType || 'Не указан.'}
- Status: ${knowledgeStatus || 'Не указан.'}

## Domain Files

${listOrNone(domainFiles)}

## Review

Imported from the curated RP chunk index as a draft. Use the linked chunk/source files for review.
`,
    });
  });
}

function buildTraceabilityRecords(rpRoot: string, rpPath: string, timestamp: string): ImportRecord[] {
  const traceability = resolve(rpRoot, 'database/13_requirement_traceability.md');
  const tables = readTables(traceability);
  const requirementTable = tables.find((candidate) => candidate.headers.includes('Requirement ID'));
  if (!requirementTable) return [];
  const requirementRecords = requirementTable.rows.map((row, index) => {
    const requirementKey = clean(row[0]);
    const summary = clean(row[1]);
    const refs = clean(row[2]);
    const where = clean(row[3]);
    const tasks = extractRefs(clean(row[4]), /TASK-[A-Z0-9-]+/g);
    const acceptanceIds = extractRefs(clean(row[5]), /AC-TASK-[A-Z0-9-]+/g);
    const sourceIds = extractRefs(refs, /SRC-\d+/g);
    const chunkIds = extractRefs(refs, /CH-SRC-\d+-\d+/g);
    const requirementArea = requirementKey.match(/^REQ-([A-Z0-9]+)-/)?.[1] ?? 'GEN';
    return makeRecord({
      id: stableId('REQUIREMENT', index + 1),
      type: 'requirement',
      title: `${requirementKey}: ${truncate(summary, 100)}`,
      status: 'draft',
      timestamp,
      modules: ['doc', 'analysis'],
      files: [`${rpPath}/database/13_requirement_traceability.md`],
      tags: ['rp', 'requirement', requirementArea.toLowerCase()],
      sourceRefs: [`${rpPath}/database/13_requirement_traceability.md`],
      frontmatter: {
        requirement_key: requirementKey,
        requirement_area: requirementArea,
        source_ids: sourceIds,
        chunk_ids: chunkIds,
        task_keys: tasks,
        acceptance_ids: acceptanceIds,
      },
      body: `# ${requirementKey}: ${truncate(summary, 120)}

## Requirement

${summary}

## Source And Chunk References

${refs || 'Нет.'}

## Where Expanded

${where || 'Нет.'}

## Related Tasks

${listOrNone(tasks)}

## Acceptance Criteria

${listOrNone(acceptanceIds)}

## Review

Imported from RP traceability as a draft. Confirm current scope before promotion.
`,
    });
  });
  const acceptanceRecords = buildAcceptanceRecords(requirementTable.rows, rpPath, timestamp, requirementRecords.length + 1);
  return [...requirementRecords, ...acceptanceRecords];
}

function buildAcceptanceRecords(rows: string[][], rpPath: string, timestamp: string, offset: number): ImportRecord[] {
  const byAcceptanceId = new Map<string, { requirements: Set<string>; tasks: Set<string> }>();
  for (const row of rows) {
    const requirementKey = clean(row[0]);
    const taskKeys = extractRefs(clean(row[4]), /TASK-[A-Z0-9-]+/g);
    const acceptanceIds = extractRefs(clean(row[5]), /AC-TASK-[A-Z0-9-]+/g);
    for (const acceptanceId of acceptanceIds) {
      const item = byAcceptanceId.get(acceptanceId) ?? { requirements: new Set<string>(), tasks: new Set<string>() };
      item.requirements.add(requirementKey);
      for (const taskKey of taskKeys) item.tasks.add(taskKey);
      byAcceptanceId.set(acceptanceId, item);
    }
  }
  return [...byAcceptanceId.entries()].map(([acceptanceId, links], index) => {
    const requirementKeys = [...links.requirements].sort();
    const taskKeys = [...links.tasks].sort();
    return makeRecord({
      id: stableId('ACCEPTANCE-CHECK', offset + index),
      type: 'acceptance_check',
      title: `${acceptanceId}: RP acceptance trace`,
      status: 'draft',
      timestamp,
      modules: ['doc', 'analysis'],
      files: [`${rpPath}/database/13_requirement_traceability.md`],
      tags: ['rp', 'acceptance', 'traceability'],
      sourceRefs: [`${rpPath}/database/13_requirement_traceability.md`],
      frontmatter: {
        acceptance_id: acceptanceId,
        requirement_keys: requirementKeys,
        task_keys: taskKeys,
      },
      body: `# ${acceptanceId}: RP acceptance trace

## Linked Requirements

${listOrNone(requirementKeys)}

## Linked Tasks

${listOrNone(taskKeys)}

## Review

Imported as an acceptance trace placeholder. Fill detailed check steps from the linked task/checklist before promotion.
`,
    });
  });
}

function buildDecisionRecords(rpRoot: string, rpPath: string, timestamp: string): ImportRecord[] {
  const decisionsPath = resolve(rpRoot, 'database/11_decisions_open_items_and_conflicts.md');
  const raw = existsSync(decisionsPath) ? readFileSync(decisionsPath, 'utf8') : '';
  if (!raw) return [];
  const tables = readTables(decisionsPath);
  const records: ImportRecord[] = [];
  let decisionIndex = 1;
  let questionIndex = 1;

  for (const table of tables) {
    if (table.headers.includes('Тема') && table.headers.includes('Решение')) {
      for (const row of table.rows) {
        const title = clean(row[0]);
        const decision = clean(row[1]);
        const sourceRefs = extractSourceRefs(clean(row[2]));
        records.push(makeRecord({
          id: stableId('DECISION', decisionIndex++),
          type: 'decision',
          title: truncate(title, 120),
          status: 'draft',
          timestamp,
          modules: ['doc', 'analysis'],
          files: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`],
          tags: ['rp', 'decision'],
          sourceRefs: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`, ...sourceRefs],
          frontmatter: {
            source_task: `${rpPath}/database/11_decisions_open_items_and_conflicts.md`,
          },
          body: `# ${title}

## Decision

${decision}

## Source References

${listOrNone(sourceRefs)}

## Review

Imported from RP decisions as a draft. Promote only after confirming it is still current.
`,
        }));
      }
      continue;
    }

    if (table.headers.includes('Вопрос')) {
      for (const row of table.rows) {
        const title = clean(row[0]);
        const resolution = clean(row[1]);
        const sourceRefs = extractSourceRefs(clean(row[2]));
        const kind = /конфликт/i.test(table.heading) ? 'conflict' : 'open_question';
        records.push(makeRecord({
          id: stableId('OPEN-QUESTION', questionIndex++),
          type: 'open_question',
          title: truncate(title, 120),
          status: 'draft',
          timestamp,
          modules: ['doc', 'analysis'],
          files: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`],
          tags: ['rp', kind === 'conflict' ? 'conflict' : 'open-question'],
          sourceRefs: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`, ...sourceRefs],
          frontmatter: {
            question_kind: kind,
            owner: 'analysis',
          },
          body: `# ${title}

## What Needs Resolution

${resolution || 'Требует решения.'}

## Source References

${listOrNone(sourceRefs)}

## Review

Imported from RP open questions/conflicts as a draft. Close or promote after human decision.
`,
        }));
      }
    }
  }

  const conflictSections = conflictParagraphs(raw);
  for (const conflict of conflictSections) {
    const sourceRefs = extractSourceRefs(conflict.body);
    records.push(makeRecord({
      id: stableId('OPEN-QUESTION', questionIndex++),
      type: 'open_question',
      title: truncate(conflict.title, 120),
      status: 'draft',
      timestamp,
      modules: ['doc', 'analysis'],
      files: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`],
      tags: ['rp', 'conflict'],
      sourceRefs: [`${rpPath}/database/11_decisions_open_items_and_conflicts.md`, ...sourceRefs],
      frontmatter: {
        question_kind: 'conflict',
        owner: 'analysis',
      },
      body: `# ${conflict.title}

## Conflict

${conflict.body}

## Source References

${listOrNone(sourceRefs)}

## Review

Imported from RP conflict notes as a draft. Resolve before using as implementation scope.
`,
    }));
  }

  return records;
}

export function analystSourceToBacklogDraft(title: string, summary: string, sourceRef: string, apply: boolean) {
  return proposeBacklogItem({
    title,
    description: summary,
    priority: 'P2',
    agentSize: 'medium',
    status: 'proposed',
    modules: ['doc'],
    tags: ['analyst-source', 'from-rp-context'],
    sourceRefs: [sourceRef],
    dependsOn: [],
    files: [],
    acceptanceCriteria: ['Analyst source is reviewed and converted into requirements, questions, or backlog items.'],
    checks: [contextCliCommand(loadProjectConfig(), 'lint')],
    force: false,
    dryRun: !apply,
  });
}

function makeRecord(input: {
  id: string;
  type: string;
  title: string;
  status: string;
  timestamp: string;
  modules: string[];
  files: string[];
  tags: string[];
  sourceRefs: string[];
  frontmatter: Record<string, unknown>;
  body: string;
}): ImportRecord {
  const paths = repoPaths();
  const segment = segmentForRecordType(input.type);
  const path = relPath(paths.root, resolve(paths.draftsDir, segment, `${input.id}.md`));
  const frontmatter = {
    ...input.frontmatter,
    id: input.id,
    type: input.type,
    status: input.status,
    title: input.title,
    created_at: input.timestamp,
    updated_at: input.timestamp,
    modules: input.modules,
    files: input.files,
    tags: [...new Set(input.tags.filter(Boolean))],
    source_refs: [...new Set(input.sourceRefs.filter(Boolean))],
    retention: input.type === 'decision' || input.type === 'source' ? 'keep' : 'normal',
  };
  return {
    id: input.id,
    type: input.type,
    status: input.status,
    title: input.title,
    path,
    frontmatter,
    body: input.body,
  };
}

function readTables(path: string): MarkdownTable[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const tables: MarkdownTable[] = [];
  let heading = '';
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      heading = headingMatch[2].trim();
      continue;
    }
    if (!isTableRow(line) || !isSeparatorRow(lines[index + 1] ?? '')) {
      continue;
    }
    const headers = splitMarkdownRow(line);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && isTableRow(lines[index] ?? '')) {
      rows.push(splitMarkdownRow(lines[index] ?? ''));
      index += 1;
    }
    index -= 1;
    tables.push({ heading, headers, rows });
  }
  return tables;
}

function conflictParagraphs(raw: string): Array<{ title: string; body: string }> {
  const conflictStart = raw.indexOf('## Конфликты');
  if (conflictStart < 0) return [];
  const section = raw.slice(conflictStart);
  const parts = section.split(/\n###\s+/).slice(1);
  return parts
    .map((part) => {
      const [titleLine, ...bodyLines] = part.split(/\r?\n/);
      const body = bodyLines.join('\n').trim();
      return { title: titleLine.trim(), body };
    })
    .filter((item) => item.title && item.body && !item.body.includes('|---|'));
}

function isTableRow(line: string): boolean {
  return line.trim().startsWith('|') && line.trim().endsWith('|');
}

function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(line);
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(clean);
}

function clean(value: string | undefined): string {
  return (value ?? '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(value: string, length: number): string {
  if (value.length <= length) return value;
  return `${value.slice(0, Math.max(0, length - 3)).trim()}...`;
}

function sourceKindFromPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.includes('/transcripts/')) return 'transcript';
  if (lower.includes('/spreadsheets/') || lower.endsWith('.xlsx')) return 'spreadsheet';
  if (lower.endsWith('.pptx')) return 'presentation';
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'document';
  if (lower.endsWith('.md')) return 'markdown';
  return 'source';
}

function extractSourceRefs(value: string): string[] {
  return [...new Set([
    ...extractRefs(value, /SRC-\d+/g),
    ...extractRefs(value, /CH-SRC-\d+-\d+/g),
  ])];
}

function extractRefs(value: string, pattern: RegExp): string[] {
  return [...new Set((value.match(pattern) ?? []).map((item) => item.trim()))];
}

function splitRefs(value: string): string[] {
  return [...new Set((value.match(/`([^`]+)`/g) ?? []).map((item) => item.replaceAll('`', '').trim()))];
}

function listOrNone(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : 'Нет.';
}

function repositoryFile(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const reference = classifyFileReference(filePath);
  if (reference.kind === 'outside_repository') {
    throw new Error(`RP source path escapes the repository: ${filePath}`);
  }
  return reference.kind === 'file' ? filePath : undefined;
}

function stableId(prefix: string, index: number): string {
  return `${prefix}-${importDate}-${String(index).padStart(3, '0')}`;
}

function nextStableIndex(type: string, key: string): number {
  let hash = 0;
  for (const char of `${type}:${key}`) {
    hash = (hash * 31 + char.charCodeAt(0)) % 900;
  }
  return hash + 100;
}
