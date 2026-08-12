import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { z } from 'zod';
import { relPath, repoPaths } from './repo.js';
import { classifyFileReference } from './file-references.js';
import type { ContextRecord } from './types.js';
import { nowCompactTimestamp, nowIso, todayArchiveYear } from './time.js';
import { segmentForRecordType } from './record-types.js';

const stringArray = z.preprocess(
  (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []),
  z.array(z.string()),
);

const frontmatterSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    status: z.string().min(1),
    title: z.string().min(1),
    created_at: z.string().optional(),
    updated_at: z.string().optional(),
    retention: z.string().default('normal'),
    modules: stringArray.default([]),
    files: stringArray.default([]),
    deleted_files: stringArray.default([]),
    tags: stringArray.default([]),
  })
  .passthrough();

export function discoverRecordFiles(includeArchive = true): string[] {
  const paths = repoPaths();
  const patterns = [
    '.project-context/active/**/*.md',
    '.project-context/drafts/**/*.md',
    ...(includeArchive ? ['.project-context/archive/**/*.md'] : []),
  ];
  return fg.sync(patterns, {
    cwd: paths.root,
    absolute: true,
    ignore: ['**/README.md'],
  });
}

export function parseRecord(file: string, root = repoPaths().root): ContextRecord {
  const raw = readFileSync(file, 'utf8');
  const parsed = matter(raw);
  const frontmatter = frontmatterSchema.parse(parsed.data);
  const relative = relPath(root, file);
  return {
    id: frontmatter.id,
    type: frontmatter.type,
    status: frontmatter.status,
    title: frontmatter.title,
    path: relative,
    body: parsed.content.trim(),
    createdAt: frontmatter.created_at,
    updatedAt: frontmatter.updated_at,
    retention: frontmatter.retention,
    archived: relative.includes('/archive/'),
    modules: frontmatter.modules,
    files: frontmatter.files,
    deletedFiles: frontmatter.deleted_files,
    tags: frontmatter.tags,
    frontmatter,
  };
}

export function readRecords(includeArchive = true): ContextRecord[] {
  const paths = repoPaths();
  return discoverRecordFiles(includeArchive).map((file) => parseRecord(file, paths.root));
}

export function renderMarkdown(frontmatter: Record<string, unknown>, body: string): string {
  return matter.stringify(`${body.trim()}\n`, frontmatter).replace(/^---\n---\n/, '---\n---\n');
}

export function writeMarkdown(path: string, frontmatter: Record<string, unknown>, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, renderMarkdown(frontmatter, body), 'utf8');
}

export function updateRecord(path: string, updater: (frontmatter: Record<string, unknown>, body: string) => void): void {
  const raw = readFileSync(path, 'utf8');
  const parsed = matter(raw);
  updater(parsed.data, parsed.content);
  writeFileSync(path, renderMarkdown(parsed.data, parsed.content), 'utf8');
}

export function checksumForFile(path: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function nextRecordId(prefix: string, includeArchive = true): string {
  const timestamp = nowCompactTimestamp();
  const max = recordIds(includeArchive)
    .map((id) => id.match(new RegExp(`^${escapeRegExp(prefix)}-${timestamp}-(\\d{3})$`))?.[1])
    .filter((value): value is string => Boolean(value))
    .map((value) => Number(value))
    .reduce((currentMax, value) => Math.max(currentMax, value), 0);
  return `${prefix}-${timestamp}-${String(max + 1).padStart(3, '0')}`;
}

function recordIds(includeArchive: boolean): string[] {
  const paths = repoPaths();
  const patterns = [
    '.project-context/active/**/*.md',
    '.project-context/drafts/**/*.md',
    ...(includeArchive ? ['.project-context/archive/**/*.md', '.project-context/trash/**/*.md'] : []),
  ];
  return fg.sync(patterns, {
    cwd: paths.root,
    absolute: true,
    ignore: ['**/README.md'],
  }).flatMap((file) => {
    try {
      return [parseRecord(file, paths.root).id];
    } catch {
      const raw = readFileSync(file, 'utf8');
      const match = raw.match(/^id:\s*['"]?([^'"\n]+)['"]?/m);
      return match?.[1] ? [match[1].trim()] : [];
    }
  });
}

export function findRecordPath(recordId: string): string | null {
  const paths = repoPaths();
  for (const file of discoverRecordFiles(true)) {
    if (parseRecord(file, paths.root).id === recordId) {
      return file;
    }
  }
  const fallback = classifyFileReference(`.project-context/active/tasks/${recordId}.md`);
  return fallback.kind === 'file' ? fallback.absolutePath : null;
}

export function moveToArchive(record: ContextRecord): string {
  const paths = repoPaths();
  const reference = classifyFileReference(record.path);
  if (reference.kind !== 'file') throw new Error(`Record path is not a repository file: ${record.path}`);
  const from = reference.absolutePath;
  const segment = segmentForRecordType(record.type);
  const target = resolve(paths.archiveDir, todayArchiveYear(), segment, `${record.id}.md`);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(from, target);
  return relPath(paths.root, target);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createTaskDraft(title: string, query: string, modules: string[], questions: string[], inferred: string[]): ContextRecord {
  const paths = repoPaths();
  const id = nextRecordId('TASK');
  const timestamp = nowIso();
  const frontmatter = {
    id,
    type: 'task',
    status: questions.length > 0 ? 'clarification_required' : 'validating',
    title,
    created_at: timestamp,
    updated_at: timestamp,
    confirmed_by_human: false,
    source: { kind: 'user_prompt' },
    related: { bugs: [], decisions: [], refactors: [] },
    modules,
    files: [],
    tags: inferTags(query),
    retention: 'normal',
  };
  const body = `# ${id}: ${title}

## Goal

${query}

## Scope

To be confirmed.

## Out Of Scope

To be confirmed.

## Acceptance Criteria

To be confirmed.

## Open Questions

${questions.length > 0 ? questions.map((question) => `- ${question}`).join('\n') : 'Нет.'}

## Inferred

${inferred.length > 0 ? inferred.map((item) => `- ${item}`).join('\n') : 'Нет.'}

## Risks

To be confirmed.

## Verification Plan

To be confirmed.
`;
  const path = resolve(paths.draftsDir, 'tasks', `${id}.md`);
  writeMarkdown(path, frontmatter, body);
  return parseRecord(path);
}

export function inferTags(text: string): string[] {
  const normalized = text.toLowerCase();
  const tags = new Set<string>();
  const pairs: Array<[RegExp, string]> = [
    [/project|проект/i, 'projects'],
    [/filter|фильтр/i, 'filters'],
    [/resource|ресурс/i, 'resource-planning'],
    [/budget|бюджет/i, 'budgeting'],
    [/auth|keycloak|роль|доступ/i, 'auth'],
    [/export|экспорт/i, 'exports'],
    [/api|endpoint|dto/i, 'api'],
    [/ui|frontend|react|страниц/i, 'frontend'],
    [/backend|spring|java/i, 'backend'],
  ];
  for (const [pattern, tag] of pairs) {
    if (pattern.test(normalized)) {
      tags.add(tag);
    }
  }
  return [...tags];
}
