import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import fg from 'fast-glob';
import { load } from 'js-yaml';
import { z } from 'zod';
import { discoverRecordFiles, parseRecord, readRecords } from './markdown.js';
import { repoPaths } from './repo.js';
import { scanSecrets } from './secrets.js';
import { classifyFileReference } from './file-references.js';
import { generatedIdPattern } from './record-types.js';
import { loadProjectConfig } from './config.js';

export type LintResult = {
  errors: string[];
  warnings: string[];
};

const knowledgeRecordBase = {
  status: z.string(),
  title: z.string().min(1),
  created_at: z.string(),
  modules: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  source_refs: z.array(z.string()).default([]),
  retention: z.string().default('normal'),
};

const typeSchemas: Record<string, z.ZodTypeAny> = {
  task: z.object({
    id: z.string().regex(generatedIdPattern('TASK')),
    type: z.literal('task'),
    status: z.string(),
    title: z.string(),
    created_at: z.string().optional(),
    confirmed_by_human: z.boolean(),
    modules: z.array(z.string()).default([]),
    retention: z.string().default('normal'),
  }).passthrough(),
  bug: z.object({
    id: z.string().regex(generatedIdPattern('BUG')),
    type: z.literal('bug'),
    status: z.string(),
    severity: z.string(),
    title: z.string(),
    confirmed_by_human: z.boolean(),
    modules: z.array(z.string()).default([]),
    retention: z.string().default('normal'),
  }).passthrough(),
  decision: z.object({
    id: z.string().regex(generatedIdPattern('DECISION')),
    type: z.literal('decision'),
    status: z.string(),
    title: z.string(),
    modules: z.array(z.string()).default([]),
    retention: z.string().default('keep'),
  }).passthrough(),
  refactor: z.object({
    id: z.string().regex(generatedIdPattern('REFACTOR')),
    type: z.literal('refactor'),
    status: z.string(),
    title: z.string(),
    risk: z.string(),
    modules: z.array(z.string()).default([]),
    retention: z.string().default('normal'),
  }).passthrough(),
  backlog: z.object({
    id: z.string().regex(/^BACKLOG-[A-Z0-9-]+$/),
    type: z.literal('backlog'),
    status: z.string(),
    priority: z.string().regex(/^P\d$/),
    agent_size: z.enum(['small', 'medium', 'large']),
    title: z.string(),
    modules: z.array(z.string()).default([]),
    depends_on: z.array(z.string()).default([]),
    acceptance_criteria: z.array(z.string()).default([]),
    checks: z.array(z.string()).default([]),
    retention: z.string().default('keep'),
  }).passthrough(),
  'verification-evidence': z.object({
    id: z.string().regex(generatedIdPattern('VERIFY')),
    type: z.literal('verification-evidence'),
    status: z.string(),
    title: z.string(),
    target_id: z.string(),
    target_type: z.string(),
    checks: z.array(z.object({
      command: z.string(),
      status: z.string(),
      reason: z.string().optional(),
      durationMs: z.number().optional(),
    })).default([]),
    modules: z.array(z.string()).default([]),
    retention: z.string().default('normal'),
  }).passthrough(),
  project: z.object({
    id: z.string().regex(generatedIdPattern('PROJECT')),
    type: z.literal('project'),
    ...knowledgeRecordBase,
  }).passthrough(),
  integration: z.object({
    id: z.string().regex(generatedIdPattern('INTEGRATION')),
    type: z.literal('integration'),
    ...knowledgeRecordBase,
    systems: z.array(z.string()).default([]),
  }).passthrough(),
  data_entity: z.object({
    id: z.string().regex(generatedIdPattern('DATA-ENTITY')),
    type: z.literal('data_entity'),
    ...knowledgeRecordBase,
    entity_name: z.string().optional(),
    fields: z.array(z.string()).default([]),
  }).passthrough(),
  api: z.object({
    id: z.string().regex(generatedIdPattern('API')),
    type: z.literal('api'),
    ...knowledgeRecordBase,
    endpoints: z.array(z.string()).default([]),
  }).passthrough(),
  requirement: z.object({
    id: z.string().regex(generatedIdPattern('REQUIREMENT')),
    type: z.literal('requirement'),
    ...knowledgeRecordBase,
  }).passthrough(),
  open_question: z.object({
    id: z.string().regex(generatedIdPattern('OPEN-QUESTION')),
    type: z.literal('open_question'),
    ...knowledgeRecordBase,
    owner: z.string().optional(),
    due_at: z.string().optional(),
  }).passthrough(),
  meeting_draft: z.object({
    id: z.string().regex(generatedIdPattern('MEETING-DRAFT')),
    type: z.literal('meeting_draft'),
    ...knowledgeRecordBase,
    meeting_at: z.string().optional(),
    participants: z.array(z.string()).default([]),
  }).passthrough(),
  source: z.object({
    id: z.string().regex(generatedIdPattern('SOURCE')),
    type: z.literal('source'),
    ...knowledgeRecordBase,
    source_id: z.string(),
    source_path: z.string().optional(),
    source_kind: z.string().optional(),
    processed_status: z.string().optional(),
  }).passthrough(),
  source_chunk: z.object({
    id: z.string().regex(generatedIdPattern('SOURCE-CHUNK')),
    type: z.literal('source_chunk'),
    ...knowledgeRecordBase,
    chunk_id: z.string(),
    source_id: z.string(),
    topic: z.string().optional(),
    system_area: z.string().optional(),
    information_type: z.string().optional(),
    knowledge_status: z.string().optional(),
  }).passthrough(),
  acceptance_check: z.object({
    id: z.string().regex(generatedIdPattern('ACCEPTANCE-CHECK')),
    type: z.literal('acceptance_check'),
    ...knowledgeRecordBase,
    acceptance_id: z.string(),
    requirement_keys: z.array(z.string()).default([]),
    task_keys: z.array(z.string()).default([]),
  }).passthrough(),
};

export function lintContext(staged = false): LintResult {
  const paths = repoPaths();
  const errors: string[] = [];
  const warnings: string[] = [];
  const files = staged ? stagedContextFiles() : discoverRecordFiles(true).map((path) => path.replace(`${paths.root}/`, ''));

  for (const relative of files) {
    const absolute = resolve(paths.root, relative);
    if (!existsSync(absolute) || !absolute.endsWith('.md')) continue;
    let record;
    try {
      record = parseRecord(absolute);
    } catch (error) {
      errors.push(`${relative}: invalid frontmatter: ${formatError(error)}`);
      continue;
    }
    const schema = typeSchemas[record.type];
    if (schema) {
      const parsed = schema.safeParse(record.frontmatter);
      if (!parsed.success) errors.push(`${relative}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);
    }
    if (record.path.includes('/active/tasks/') && record.status !== 'confirmed' && record.status !== 'in_progress' && record.status !== 'done') {
      errors.push(`${relative}: active task must have a confirmed contract`);
    }
    if (record.path.includes('/active/decisions/') && !record.frontmatter.source_task && record.retention !== 'keep') {
      errors.push(`${relative}: active decision must have a source or keep retention`);
    }
    const deletedFiles = new Set(record.deletedFiles);
    for (const file of record.files) {
      if (deletedFiles.has(file)) continue;
      const reference = classifyFileReference(file);
      if (reference.kind === 'missing') {
        warnings.push(`${relative}: referenced file does not exist: ${file}`);
      } else if (reference.kind === 'outside_repository') {
        errors.push(`${relative}: referenced path escapes the repository: ${file}`);
      } else if (reference.kind === 'directory') {
        errors.push(`${relative}: referenced file is a directory, expected concrete file: ${file}`);
      } else if (reference.kind === 'other') {
        errors.push(`${relative}: referenced path is not a regular file: ${file}`);
      }
    }
    const raw = readFileSync(absolute, 'utf8');
    for (const hit of scanSecrets(relative, raw)) {
      errors.push(`${hit.path}:${hit.line}: possible ${hit.reason}`);
    }
  }

  for (const schemaFile of fg.sync('.project-context/schemas/**/*.json', { cwd: paths.root })) {
    try {
      JSON.parse(readFileSync(resolve(paths.root, schemaFile), 'utf8'));
    } catch (error) {
      errors.push(`${schemaFile}: invalid JSON: ${formatError(error)}`);
    }
  }

  for (const sqliteFile of trackedSqliteFiles()) {
    errors.push(`${sqliteFile}: sqlite index must not be committed`);
  }

  lintPlaybooks(staged, errors, warnings);

  return { errors, warnings };
}

function lintPlaybooks(staged: boolean, errors: string[], warnings: string[]): void {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const playbooks = staged
    ? stagedFiles().filter((path) => path.startsWith('playbooks/') && path.endsWith('.md'))
    : fg.sync('playbooks/*.md', { cwd: paths.root, absolute: false }).sort();
  for (const relative of playbooks) {
    const absolute = resolve(paths.root, relative);
    if (!existsSync(absolute)) continue;
    const raw = readFileSync(absolute, 'utf8');
    const frontmatter = parsePlaybookFrontmatter(raw);
    if (!frontmatter) {
      errors.push(`${relative}: playbook must start with YAML frontmatter`);
      continue;
    }
    if (frontmatter.kind !== 'policy' && frontmatter.kind !== 'runbook') {
      errors.push(`${relative}: playbook kind must be policy or runbook`);
    }
    if (!Array.isArray(frontmatter.modules) || frontmatter.modules.length === 0) {
      errors.push(`${relative}: playbook modules must be a non-empty array`);
    }
    if (frontmatter.routing !== 'core' && frontmatter.routing !== 'conditional') {
      errors.push(`${relative}: playbook routing must be core or conditional`);
    }
    if (typeof frontmatter.required !== 'boolean') {
      errors.push(`${relative}: playbook required must be true or false`);
    }
    if (frontmatter.routing === 'conditional' && (!Array.isArray(frontmatter.triggers) || frontmatter.triggers.length === 0)) {
      errors.push(`${relative}: conditional playbook must declare at least one trigger`);
    }
    if (typeof frontmatter.last_verified !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(frontmatter.last_verified)) {
      errors.push(`${relative}: playbook last_verified must use YYYY-MM-DD`);
    } else {
      const verifiedAt = Date.parse(`${frontmatter.last_verified}T00:00:00Z`);
      const ageDays = Math.floor((Date.now() - verifiedAt) / (24 * 60 * 60 * 1000));
      if (ageDays < -1) errors.push(`${relative}: playbook last_verified is in the future`);
      if (ageDays > 120) warnings.push(`${relative}: playbook verification is stale (${ageDays} days)`);
    }
    const verifyWith = Array.isArray(frontmatter.verify_with)
      ? frontmatter.verify_with.filter((item): item is string => typeof item === 'string')
      : [];
    if (verifyWith.length === 0) {
      errors.push(`${relative}: playbook verify_with must name at least one project command`);
    }
    for (const command of verifyWith) {
      if (!config.commandMetadata[command]) {
        errors.push(`${relative}: verify_with references unknown project command: ${command}`);
      }
    }
    for (const target of markdownLinkTargets(raw)) {
      if (/^(?:https?:|mailto:|#)/i.test(target)) continue;
      const clean = safeDecodeURIComponent(target.split('#')[0] ?? '');
      if (clean && !existsSync(resolve(dirname(absolute), clean))) {
        errors.push(`${relative}: linked file does not exist: ${target}`);
      }
    }
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parsePlaybookFrontmatter(raw: string): Record<string, unknown> | undefined {
  if (!raw.startsWith('---\n')) return undefined;
  const end = raw.indexOf('\n---\n', 4);
  if (end < 0) return undefined;
  try {
    const parsed = load(raw.slice(4, end));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function markdownLinkTargets(raw: string): string[] {
  return [...raw.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim())
    .filter((target): target is string => Boolean(target));
}

function stagedContextFiles(): string[] {
  return stagedFiles().filter(isContextRecordPath);
}

function stagedFiles(): string[] {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: repoPaths().root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isContextRecordPath(path: string): boolean {
  return path.endsWith('.md')
    && !path.endsWith('/README.md')
    && (
      path.startsWith('.project-context/active/')
      || path.startsWith('.project-context/drafts/')
      || path.startsWith('.project-context/archive/')
    );
}

function trackedSqliteFiles(): string[] {
  try {
    return execFileSync('git', ['ls-files', '.project-context/indexes/*.sqlite', '.project-context/indexes/*.sqlite-*'], {
      cwd: repoPaths().root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch {
    return [];
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
