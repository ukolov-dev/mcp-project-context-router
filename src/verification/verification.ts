import { verificationBoundariesSchema } from '../execution/types.js';
import { getAgentRun, recordRunVerification } from '../execution/runs.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { findRecordPath, nextRecordId, parseRecord, readRecords, writeMarkdown } from '../storage/markdown.js';
import { contextCliCommand, contextPackCommandsForModules, loadProjectConfig, type ProjectConfig } from '../storage/config.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { inferModulesFromPath, inferModulesFromSignals, resolveModuleName } from '../storage/inference.js';
import { nowIso } from '../storage/time.js';
import type { ContextRecord } from '../storage/types.js';

export const verificationPlanInputSchema = z.object({
  id: z.string().optional(),
  query: z.string().optional(),
}).refine((value) => value.id || value.query, {
  message: 'Either id or query is required.',
});

export type VerificationCheck = {
  command: string;
  required: boolean;
  reason: string;
  source: 'record' | 'module-default' | 'context-default' | 'optional';
};

export type VerificationPlan = {
  target: {
    id?: string;
    path?: string;
    query?: string;
  };
  modules: string[];
  required: VerificationCheck[];
  optional: VerificationCheck[];
  evidence: VerificationEvidenceSummary[];
  warnings: string[];
  summary: string;
};

export const verificationEvidenceInputSchema = z.object({
  targetId: z.string(),
  targetType: z.enum(['task', 'backlog', 'record']).default('task'),
  summary: z.string().min(1),
  checks: z.array(z.object({
    command: z.string().min(1),
    status: z.enum(['passed', 'failed', 'skipped', 'not_run']),
    reason: z.string().optional(),
    durationMs: z.number().optional(),
    required: z.boolean().optional(),
  })).default([]),
  changedFiles: z.array(z.string()).default([]),
  modules: z.array(z.string()).optional(),
  recordedBy: z.string().default('agent'),
  completion: z.enum(['complete', 'partial', 'blocked']).optional(),
  retriesEvidenceId: z.string().optional(),
  boundaries: verificationBoundariesSchema.optional(),
  runId: z.string().optional(),
  expectedCodeDigest: z.string().optional(),
});

export const listVerificationEvidenceInputSchema = z.object({
  targetId: z.string().optional(),
  limit: z.number().default(20),
});

export type VerificationEvidenceSummary = {
  id: string;
  path: string;
  targetId: string;
  status: string;
  title: string;
  checks: Array<{ command: string; status: string; reason?: string; required?: boolean }>;
  completion?: string;
  boundaries?: unknown;
  retriesEvidenceId?: string;
  createdAt?: string;
};

export function getVerificationPlan(input: z.infer<typeof verificationPlanInputSchema>): VerificationPlan {
  const parsed = verificationPlanInputSchema.parse(input);
  const warnings: string[] = [];
  const config = loadProjectConfig();
  const records: ContextRecord[] = [];
  if (parsed.id) {
    const path = findRecordPath(parsed.id);
    if (path) {
      records.push(parseRecord(path));
    } else {
      warnings.push(`Context record not found: ${parsed.id}. Using query-only defaults.`);
    }
  }

  const query = [parsed.query, ...records.map((record) => `${record.title} ${record.body} ${record.tags.join(' ')}`)].filter(Boolean).join('\n');
  const explicitModules = [
    ...records.flatMap((record) => record.modules),
    ...records.flatMap((record) => record.files.flatMap((file) => inferModulesFromPath(file, config))),
  ].flatMap((module) => resolveModuleName(module, config) ?? []);
  const inferredModules = parsed.query || explicitModules.length === 0
    ? inferModulesFromSignals({ query, modules: explicitModules })
    : [];
  const modules = [...new Set([...explicitModules, ...inferredModules].filter((module) => module !== 'unknown'))];

  const required = new Map<string, VerificationCheck>();
  const optional = new Map<string, VerificationCheck>();

  for (const record of records) {
    for (const command of explicitChecks(record)) {
      required.set(command, {
        command,
        required: true,
        reason: `Declared by ${record.id}.`,
        source: 'record',
      });
    }
  }

  for (const check of contextChecks(records, modules, config)) {
    required.set(check.command, check);
  }
  for (const check of moduleDefaultChecks(modules, config)) {
    required.set(check.command, check);
  }
  for (const check of optionalChecks(modules, config)) {
    if (!required.has(check.command)) optional.set(check.command, check);
  }

  if (!existsSync(repoPaths().sqlitePath)) {
    warnings.push(`Context index is missing; run ${config.commands.context_index ?? contextCliCommand(config, 'index')} before relying on ranked search.`);
  }
  if (required.size === 0) {
    warnings.push('No concrete verification command could be inferred; ask the user or inspect the touched modules.');
  }

  return {
    target: {
      id: parsed.id,
      path: records[0]?.path,
      query: parsed.query,
    },
    modules,
    required: [...required.values()],
    optional: [...optional.values()],
    evidence: parsed.id ? listVerificationEvidence({ targetId: parsed.id, limit: 5 }).items : [],
    warnings,
    summary: `Verification plan for ${parsed.id ?? `"${parsed.query}"`}: ${required.size} required, ${optional.size} optional.`,
  };
}

export function recordVerificationEvidence(input: z.infer<typeof verificationEvidenceInputSchema>): { status: 'RECORDED'; path: string; id: string } {
  const parsed = verificationEvidenceInputSchema.parse(input);
  if (parsed.runId) {
    const run = getAgentRun(parsed.runId);
    if (run.taskId !== parsed.targetId) throw new Error('Verification target must match the execution task.');
    if (!parsed.expectedCodeDigest) throw new Error('Execution verification requires expectedCodeDigest from get_run_snapshot.');
    return recordRunVerification({ runId: parsed.runId, expectedCodeDigest: parsed.expectedCodeDigest, summary: parsed.summary, checks: parsed.checks, completion: parsed.completion, boundaries: parsed.boundaries, retriesEvidenceId: parsed.retriesEvidenceId });
  }
  if (parsed.retriesEvidenceId) {
    const previous = findRecordPath(parsed.retriesEvidenceId);
    const record = previous ? parseRecord(previous) : undefined;
    if (!record || record.type !== 'verification-evidence' || record.frontmatter.target_id !== parsed.targetId) throw new Error('Retry evidence must reference verification for the same target.');
  }
  if (new Set(parsed.checks.map((check) => check.command)).size !== parsed.checks.length) throw new Error('Duplicate checks: record a retry in a separate evidence record using retriesEvidenceId.');
  const requiredCommands = getVerificationPlan({ id: parsed.targetId }).required.map((check) => check.command);
  const checks = parsed.checks.map((check) => ({ ...check, required: requiredCommands.includes(check.command) || check.required !== false }));
  for (const command of requiredCommands) if (!checks.some((check) => check.command === command)) checks.push({ command, status: 'not_run', required: true, reason: 'Required by verification plan; no evidence supplied.' });
  const status = aggregateStatus(checks);
  const completion = parsed.completion ?? (status === 'passed' ? 'complete' : status === 'failed' ? 'blocked' : 'partial');
  if (completion === 'complete' && status !== 'passed') throw new Error('Complete verification requires every required check to pass.');
  const paths = repoPaths();
  const id = nextRecordId('VERIFY');
  const timestamp = nowIso();
  const modules = parsed.modules ?? inferModulesFromSignals({
    query: `${parsed.targetId} ${parsed.summary}`,
    changedFiles: parsed.changedFiles,
  });
  const frontmatter = {
    id,
    type: 'verification-evidence',
    status: status === 'failed' ? 'failed' : completion === 'blocked' ? 'blocked' : completion === 'partial' ? 'partial' : status,
    completion,
    retries_evidence_id: parsed.retriesEvidenceId ?? null,
    boundaries: parsed.boundaries ?? { codeState: 'unspecified', runtime: 'unspecified', environment: 'unspecified' },
    title: `Verification evidence for ${parsed.targetId}`,
    created_at: timestamp,
    updated_at: timestamp,
    target_id: parsed.targetId,
    target_type: parsed.targetType,
    recorded_by: parsed.recordedBy,
    modules,
    files: parsed.changedFiles,
    tags: ['verification', parsed.targetType],
    checks,
    retention: 'normal',
  };
  const body = `# ${id}: Verification evidence for ${parsed.targetId}

## Summary

${parsed.summary}

## Checks

${checks.length > 0 ? checks.map((check) => {
    const reason = check.reason ? ` - ${check.reason}` : '';
    const duration = typeof check.durationMs === 'number' ? ` (${check.durationMs}ms)` : '';
    return `- ${check.status}: \`${check.command}\`${duration}${reason}`;
  }).join('\n') : 'Нет.'}

## Changed Files

${parsed.changedFiles.length > 0 ? parsed.changedFiles.map((file) => `- ${file}`).join('\n') : 'Нет.'}
`;
  const target = resolve(paths.activeDir, 'verification', `${id}.md`);
  writeMarkdown(target, frontmatter, body);
  return { status: 'RECORDED', path: relPath(paths.root, target), id };
}

export function listVerificationEvidence(input: z.input<typeof listVerificationEvidenceInputSchema> = {}): { items: VerificationEvidenceSummary[]; count: number } {
  const parsed = listVerificationEvidenceInputSchema.parse(input);
  const items = readRecords(false)
    .filter((record) => record.type === 'verification-evidence')
    .filter((record) => !parsed.targetId || record.frontmatter.target_id === parsed.targetId)
    .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    .slice(0, parsed.limit)
    .map((record) => ({
      id: record.id,
      path: record.path,
      targetId: stringValue(record.frontmatter.target_id, ''),
      status: record.status,
      title: record.title,
      checks: evidenceChecks(record.frontmatter.checks),
      completion: typeof record.frontmatter.completion === 'string' ? record.frontmatter.completion : undefined,
      boundaries: record.frontmatter.boundaries,
      retriesEvidenceId: typeof (record.frontmatter.retries_evidence_id ?? record.frontmatter.retriesEvidenceId) === 'string' ? String(record.frontmatter.retries_evidence_id ?? record.frontmatter.retriesEvidenceId) : undefined,
      createdAt: record.createdAt,
    }));
  return { items, count: items.length };
}

function explicitChecks(record: ContextRecord): string[] {
  return [
    ...stringArray(record.frontmatter.checks),
    ...extractVerificationSection(record.body),
  ].filter((command) => !/to be confirmed|нет\.?|none/i.test(command));
}

function extractVerificationSection(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Verification Plan\s*$/i.test(line.trim()));
  if (start < 0) return [];
  const commands: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const trimmed = line.trim();
    if (!trimmed || trimmed === '-') continue;
    const withoutBullet = trimmed.replace(/^[-*]\s+/, '').trim();
    const backtickMatch = /`([^`]+)`/.exec(withoutBullet);
    commands.push((backtickMatch?.[1] ?? withoutBullet).trim());
  }
  return commands.filter(Boolean);
}

function contextChecks(records: ContextRecord[], modules: string[], config: ProjectConfig): VerificationCheck[] {
  const shouldCheckContext = modules.includes('doc')
    || modules.includes('context')
    || records.some((record) => record.path.startsWith('.project-context/') || record.tags.includes('context-router'));
  if (!shouldCheckContext) return [];
  const commands = [config.commands.context_lint, config.commands.context_index]
    .filter((command): command is string => Boolean(command));
  if (commands.length === 0) commands.push(contextCliCommand(config, 'lint'), `${contextCliCommand(config, 'index')} --check`);
  return commands.map((command) => ({
    command: command === config.commands.context_index ? `${command} --check` : command,
    required: true,
    reason: 'Context record or documentation changes require project-configured validation.',
    source: 'context-default' as const,
  }));
}

function moduleDefaultChecks(modules: string[], config: ProjectConfig): VerificationCheck[] {
  return contextPackCommandsForModules(config, modules).map((command) => ({
    command,
    required: true,
    reason: `Declared by project.yaml for ${modules.join(', ')}.`,
    source: 'module-default',
  }));
}

function optionalChecks(modules: string[], config: ProjectConfig): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  if (config.commands.full_verify) {
    checks.push({
      command: config.commands.full_verify,
      required: false,
      reason: 'Full repository verification; use when blast radius is unclear.',
      source: 'optional',
    });
  }
  return checks;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function evidenceChecks(value: unknown): VerificationEvidenceSummary["checks"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      command: stringValue(item.command, ''),
      status: stringValue(item.status, ''),
      required: typeof item.required === "boolean" ? item.required : undefined,
      reason: typeof item.reason === 'string' ? item.reason : undefined,
    }))
    .filter((item) => item.command && item.status);
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function aggregateStatus(checks: Array<{ status: string; required?: boolean }>): string {
  if (checks.some((check) => check.status === 'failed')) return 'failed';
  if (checks.some((check) => check.required !== false && check.status !== 'passed')) return 'partial';
  if (checks.some((check) => check.status === 'passed')) return 'passed';
  return 'recorded';
}
