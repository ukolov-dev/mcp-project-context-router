import { recordProvenance } from '../storage/lifecycle.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ensureFreshIndex, readSearchRecords, searchCapabilities } from '../indexer/sqlite.js';
import { parseRecord } from '../storage/markdown.js';
import { contextPackCommandsForModules, loadProjectConfig, retentionNumber, type ProjectConfig } from '../storage/config.js';
import { classifyFileReference } from '../storage/file-references.js';
import { relPath, repoPaths } from '../storage/repo.js';
import { inferModulesFromSignals, resolveModuleName } from '../storage/inference.js';
import { redactSecrets } from '../storage/secrets.js';
import type { ContextRecord } from '../storage/types.js';
import { allKnownPlaybookPaths, selectPlaybooks, type PlaybookDetail } from './playbooks.js';

export type ContextPackProfile = 'default' | 'local-model';
export type ContextPackWorkflow = 'fast' | 'standard' | 'strict';

export type ContextPackInput = {
  query: string;
  taskId?: string;
  profile?: ContextPackProfile;
  workflow?: ContextPackWorkflow;
  maxTokens?: number;
  includeArchive?: boolean;
  includeHistory?: boolean;
  explain?: boolean;
  modules?: string[];
  files?: string[];
  changedFiles?: string[];
};

export type ContextPack = {
  summary: string;
  profile: ContextPackProfile;
  workflow: ContextPackWorkflow;
  maxTokens: number;
  records: Array<{ id: string; path: string; reason: string; excerpt?: string } & Partial<ReturnType<typeof recordProvenance>>>;
  routing?: { modules: string[]; basis: string; unknownModules: string[]; unmappedFiles: string[] };
  files: Array<{ path: string; reason: string; excerpt?: string }>;
  playbooks: string[];
  playbookDetails: PlaybookDetail[];
  commands: string[];
  warnings: string[];
  budget: {
    limit: number;
    estimatedTokens: number;
    payloadTokens: number;
    playbookTokens: number;
    exceedsLimit: boolean;
    truncated: boolean;
    droppedRecords: number;
    droppedFiles: number;
    droppedPlaybooks: number;
  };
  cache?: {
    status: 'hit' | 'miss' | 'disabled';
    key?: string;
    path?: string;
    reason?: string;
  };
};

type CachedContextPack = {
  version: 5;
  state: string;
  pack: Omit<ContextPack, 'cache'>;
};

export function buildContextPack(input: ContextPackInput): ContextPack {
  let useIndex = true;
  try {
    // A pack must see record changes immediately, including within the search TTL.
    ensureFreshIndex({ force: true });
  } catch {
    useIndex = false;
  }
  if (useIndex) {
    prunePackCache();
    const cached = readCachedContextPack(input);
    if (cached) return cached;
  }
  const { pack, indexAvailable } = buildContextPackFresh(input, useIndex);
  if (!indexAvailable) return {
    ...pack,
    cache: { status: 'disabled', reason: 'Context index unavailable; the pack was built directly from Markdown.' },
  };
  return writeCachedContextPack(input, pack);
}

const lastPackCachePruneAtByRoot = new Map<string, number>();

function prunePackCache(): void {
  const now = Date.now();
  const paths = repoPaths();
  if (now - (lastPackCachePruneAtByRoot.get(paths.root) ?? 0) < 60 * 60 * 1000) return;
  lastPackCachePruneAtByRoot.set(paths.root, now);
  const dir = resolve(paths.indexesDir, 'pack-cache');
  if (!existsSync(dir)) return;
  const retentionDays = retentionNumber(loadProjectConfig(), 'context_packs', 'delete_after_days', 30);
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const path = resolve(dir, entry.name);
    try {
      if (statSync(path).mtimeMs < cutoffMs) unlinkSync(path);
    } catch {
      // Cache retention is best effort and must not block context routing.
    }
  }
}

function buildContextPackFresh(input: ContextPackInput, useIndex: boolean): { pack: Omit<ContextPack, 'cache'>; indexAvailable: boolean } {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const options = resolvePackOptions(input);
  const { profile, workflow, maxTokens } = options;
  const compact = workflow === 'fast';
  const indexedRecordLimit = compact ? 4 : workflow === 'strict' ? 12 : 8;
  const totalRecordLimit = compact ? 5 : workflow === 'strict' ? 12 : 10;
  const totalFileLimit = compact ? 6 : workflow === 'strict' ? 18 : 14;
  const moduleSet = new Set(inferModulesFromSignals({
    query: input.query,
    modules: input.modules,
    files: input.files,
    changedFiles: input.changedFiles,
    config,
  }));
  const records = new Map<string, { id: string; path: string; reason: string }>();
  const explicitFiles: Array<{ path: string; reason: string }> = [];
  const pathWarnings: string[] = [];
  const addExplicitFile = (file: string, reason: string) => {
    const reference = classifyFileReference(file);
    if (reference.kind === 'outside_repository') {
      pathWarnings.push(`Ignored unsafe repository file path: ${file}`);
      return;
    }
    explicitFiles.push({ path: file.replaceAll('\\', '/'), reason });
  };

  if (input.taskId) {
    const task = readSearchRecords({ recordId: input.taskId, includeArchive: true, useIndex }).records[0];
    if (task) {
      for (const module of task.modules) { const name = resolveModuleName(module, config); if (name) moduleSet.add(name); }
      for (const file of [...task.files, ...task.deletedFiles]) {
        for (const module of inferModulesFromSignals({ files: [file], fallback: [], config })) moduleSet.add(module);
      }
      for (const file of task.files) {
        addExplicitFile(file, 'Explicit task file.');
      }
      records.set(task.id, { id: task.id, path: task.path, reason: 'Explicit task id.' });
    }
  }

  for (const file of input.files ?? []) {
    addExplicitFile(file, 'Explicit input file.');
  }
  for (const file of input.changedFiles ?? []) {
    addExplicitFile(file, 'Changed file.');
  }

  const modules = [...moduleSet];
  const includeSpecification = shouldIncludeSpecification(input, modules, config);

  const specRecordPath = config.specifications.current?.runbook;
  const specRecordReference = specRecordPath ? classifyFileReference(specRecordPath) : undefined;
  if (includeSpecification && specRecordReference?.kind === 'file') {
    const specRecord = parseRecord(specRecordReference.absolutePath);
    records.set(specRecord.id, {
      id: specRecord.id,
      path: specRecord.path,
      reason: 'Active MVP v2 specification route.',
    });
  }

  const retrieved = readSearchRecords({ includeArchive: input.includeArchive, modules, useIndex });
  const candidateRecords = matchingPackRecords(retrieved.records, input.query, modules, input);
  const relevantRecords = rankRetrievedRecords(candidateRecords, input.query, modules)
    .filter((record) => !isDraft(record.path) || record.id === input.taskId)
    .filter((record) => !isDefaultHiddenHistory(record, input))
    .slice(0, indexedRecordLimit);
  for (const record of relevantRecords) {
    if (isDraft(record.path) && record.id !== input.taskId) {
      continue;
    }
    if (isDefaultHiddenHistory(record, input)) {
      continue;
    }
    if (!records.has(record.id)) {
      records.set(record.id, {
        id: record.id,
        path: record.path,
        reason: 'Matched query/module; relevance, decision type and explicit confirmation determine rank; date breaks ties only. Status and authority describe claims, not runtime proof.',
      });
    }
  }

  const files = mergeFiles([
    ...explicitFiles,
    ...findRelevantFiles(input.query, modules, config, retrieved.source === 'index')
      .filter((file) => includeSpecification || !(config.specifications.current?.files ?? []).includes(file.path)),
    ...(includeSpecification && !compact
      ? (config.specifications.current?.files ?? []).map((path) => ({ path, reason: 'Active product specification source.' }))
      : []),
  ], totalFileLimit);
  const playbookSelection = selectPlaybooks(
    modules,
    input.query,
    explicitFiles.map((file) => file.path),
    config,
  );
  const playbooks = playbookSelection.details.map((playbook) => playbook.path);
  const commands = commandsForModules(modules, config);
  const unknownModules = (input.modules ?? []).filter((name) => !resolveModuleName(name, config));
  const unmappedFiles = [...(input.files ?? []), ...(input.changedFiles ?? [])].filter((file) => inferModulesFromSignals({ files: [file], fallback: [], config }).length === 0);
  const directModules = inferModulesFromSignals({ query: input.query, modules: input.modules, files: input.files, changedFiles: input.changedFiles, fallback: [], config });
  const routing = { modules, basis: directModules.length ? 'explicit/query/path signals' : 'configured fallback', unknownModules, unmappedFiles };
  const warnings: string[] = [...pathWarnings, ...playbookSelection.warnings];
  if (retrieved.source === 'markdown') warnings.push('Context index unavailable; records were read directly from Markdown. This pack is not cached.');
  if (!directModules.length) warnings.push('No module signal matched; using configured default_modules. Configure aliases in the languages used by your team.');
  if (!modules.length) warnings.push('No configured module selected; inspect project.yaml routing and module coverage.');
  if (unknownModules.length) warnings.push(`Unknown or ambiguous module names: ${unknownModules.join(', ')}. Configure reviewed aliases; no implicit spelling migration is applied.`);
  if (unmappedFiles.length) warnings.push(`Files outside configured module coverage: ${unmappedFiles.join(', ')}.`);
  if (commands.length === 0) {
    warnings.push(`No context-pack verification commands are configured for module(s): ${modules.join(', ') || '<none>'}.`);
  }
  if (!existsSync(paths.sqlitePath)) {
    warnings.push('Context index is missing; run ppm-context index for better ranking.');
  }

  const pack = fitContextPackBudget({
    summary: `Context pack for "${input.query}" (${modules.join(', ')}) workflow=${workflow} profile=${profile}.`,
    profile,
    workflow,
    maxTokens,
    routing,
    records: [...records.values()].slice(0, totalRecordLimit).map((record) => withRecordExcerpt(record, input.query)),
    files: files.map((file) => withFileExcerpt(file, input.query)),
    playbooks,
    playbookDetails: playbookSelection.details,
    commands,
    warnings,
    budget: {
      limit: maxTokens,
      estimatedTokens: 0,
      payloadTokens: 0,
      playbookTokens: playbookSelection.details.reduce((total, playbook) => total + playbook.estimatedTokens, 0),
      exceedsLimit: false,
      truncated: false,
      droppedRecords: 0,
      droppedFiles: 0,
      droppedPlaybooks: 0,
    },
  });
  return { pack, indexAvailable: retrieved.source === 'index' };
}

function readCachedContextPack(input: ContextPackInput): ContextPack | undefined {
  const descriptor = cacheDescriptor(input);
  try {
    if (!existsSync(descriptor.absolutePath)) return undefined;
    const cached = JSON.parse(readFileSync(descriptor.absolutePath, 'utf8')) as CachedContextPack;
    if (cached.version !== 5 || cached.state !== buildCacheState(input)) return undefined;
    return {
      ...cached.pack,
      cache: {
        status: 'hit',
        key: descriptor.key,
        path: descriptor.relativePath,
      },
    };
  } catch {
    return undefined;
  }
}

function writeCachedContextPack(input: ContextPackInput, pack: Omit<ContextPack, 'cache'>): ContextPack {
  const descriptor = cacheDescriptor(input);
  try {
    mkdirSync(descriptor.dir, { recursive: true });
    const cached: CachedContextPack = {
      version: 5,
      state: buildCacheState(input),
      pack,
    };
    writeFileSync(descriptor.absolutePath, `${JSON.stringify(cached, null, 2)}\n`, 'utf8');
    return {
      ...pack,
      cache: {
        status: 'miss',
        key: descriptor.key,
        path: descriptor.relativePath,
      },
    };
  } catch (error) {
    return {
      ...pack,
      cache: {
        status: 'disabled',
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

function cacheDescriptor(input: ContextPackInput): { key: string; dir: string; absolutePath: string; relativePath: string } {
  const paths = repoPaths();
  const dir = resolve(paths.indexesDir, 'pack-cache');
  const key = createHash('sha256').update(JSON.stringify(normalizeCacheInput(input))).digest('hex').slice(0, 24);
  const absolutePath = resolve(dir, `${key}.json`);
  return {
    key,
    dir,
    absolutePath,
    relativePath: relPath(paths.root, absolutePath),
  };
}

function normalizeCacheInput(input: ContextPackInput): Required<Pick<ContextPackInput, 'query' | 'maxTokens' | 'includeArchive' | 'explain' | 'profile' | 'modules' | 'files' | 'changedFiles'>> & {
  taskId: string | null;
  workflow: ContextPackWorkflow;
  includeHistory: boolean;
} {
  const options = resolvePackOptions(input);
  return {
    query: input.query,
    taskId: input.taskId ?? null,
    profile: options.profile,
    workflow: options.workflow,
    maxTokens: options.maxTokens,
    includeArchive: input.includeArchive ?? false,
    includeHistory: input.includeHistory ?? false,
    explain: input.explain ?? false,
    modules: [...(input.modules ?? [])].sort(),
    files: [...(input.files ?? [])].sort(),
    changedFiles: [...(input.changedFiles ?? [])].sort(),
  };
}

function resolvePackOptions(input: ContextPackInput): { profile: ContextPackProfile; workflow: ContextPackWorkflow; maxTokens: number } {
  const profile = input.profile ?? 'default';
  const workflow = input.workflow ?? (profile === 'local-model' ? 'fast' : 'standard');
  const defaultMaxTokens = profile === 'local-model'
    ? 4000
    : workflow === 'strict'
      ? 16_000
      : 10_000;
  return {
    profile,
    workflow,
    maxTokens: Math.max(500, Math.floor(input.maxTokens ?? defaultMaxTokens)),
  };
}

function buildCacheState(input: ContextPackInput): string {
  const paths = repoPaths();
  const dependencies = [
    ...contextRecordStateFiles(paths.contextDir, input.includeArchive ?? false),
    ...cacheDependencyFiles(input),
    paths.sqlitePath,
  ];
  const state = dependencies
    .map((path) => `${relPath(paths.root, path)}:${safeFileStat(path)}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(state).digest('hex');
}

function contextRecordStateFiles(contextDir: string, includeArchive: boolean): string[] {
  const roots = [
    resolve(contextDir, 'active'),
    ...(includeArchive ? [resolve(contextDir, 'archive')] : []),
  ];
  return roots.flatMap((root) => listMarkdownFiles(root));
}

function listMarkdownFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...listMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      output.push(path);
    }
  }
  return output;
}

function cacheDependencyFiles(input: ContextPackInput): string[] {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const files = new Set<string>([
    resolve(paths.contextDir, 'project.yaml'),
    ...config.contextRouter.cacheDependencyFiles,
    ...allKnownPlaybookPaths(config),
    ...(config.specifications.current?.files ?? []),
    ...(input.files ?? []),
    ...(input.changedFiles ?? []),
  ]);
  if (input.taskId) {
    const task = readSearchRecords({ recordId: input.taskId, includeArchive: true }).records[0];
    for (const file of task?.files ?? []) files.add(file);
  }
  return [...files]
    .map((path) => classifyFileReference(path))
    .filter((reference) => reference.kind !== 'outside_repository')
    .map((reference) => reference.absolutePath);
}

function safeFileStat(path: string): string {
  try {
    const stat = statSync(path);
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function withRecordExcerpt(record: { id: string; path: string; reason: string }, query: string): ContextPack['records'][number] {
  try {
    const reference = classifyFileReference(record.path);
    if (reference.kind !== 'file') return record;
    const parsed = parseRecord(reference.absolutePath, repoPaths().root);
    return { ...record, ...recordProvenance(parsed), excerpt: buildExcerpt(redactSecrets(`${parsed.title}\n${parsed.body}`), query) };
  } catch {
    return record;
  }
}

function withFileExcerpt(file: { path: string; reason: string }, query: string): { path: string; reason: string; excerpt?: string } {
  const reference = classifyFileReference(file.path);
  if (reference.kind !== 'file') return file;
  try {
    const raw = readFileSync(reference.absolutePath, 'utf8');
    return { ...file, excerpt: buildExcerpt(redactSecrets(raw), query) };
  } catch {
    return file;
  }
}

function buildExcerpt(text: string, query: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length > 3);
  const lower = normalized.toLowerCase();
  const hit = words.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, hit - 180);
  const end = Math.min(normalized.length, hit + 520);
  const prefix = start > 0 ? '...' : '';
  const suffix = end < normalized.length ? '...' : '';
  return `${prefix}${normalized.slice(start, end)}${suffix}`;
}

function isDraft(path: string): boolean {
  return path.includes('/drafts/');
}

function isDefaultHiddenHistory(record: { id: string; type: string; status: string }, input: ContextPackInput): boolean {
  if (input.includeHistory) return false;
  if (record.id === input.taskId) return false;
  if (['superseded', 'cancelled', 'canceled', 'retired', 'archived'].includes(record.status)) return true;
  if (['run-summary', 'verification-evidence', 'refactor', 'agent-run', 'acceptance-review'].includes(record.type)) return true;
  if (record.type === 'research' && record.status === 'closed') return true;
  if (record.type === 'task' && record.status === 'done') return true;
  if (record.type === 'backlog' && (record.status === 'done' || record.status === 'cancelled')) return true;
  return false;
}

function matchingPackRecords(records: ContextRecord[], query: string, modules: string[], input: ContextPackInput) {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
  return records
    .filter((record) => {
      if (record.modules.some((name) => modules.includes(resolveModuleName(name) ?? name))) return true;
      const fields = [record.title, record.tags.join(' '), record.body].map((field) => field.toLowerCase());
      return terms.some((term) => fields.some((field) => field.includes(term)));
    })
    .filter((record) => !isDefaultHiddenHistory(record, input) && !isDraft(record.path));
}

function rankRetrievedRecords(records: ContextRecord[], query: string, modules: string[]): ContextRecord[] {
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
  const primaryModule = modules[0];
  const typeWeight: Record<string, number> = {
    task: 2,
    backlog: 2,
    decision: 12,
    pattern: 6,
    runbook: 5,
    api: 4,
    integration: 4,
    data_entity: 4,
    requirement: 2,
    source: -4,
    source_chunk: -8,
    acceptance_check: -4,
  };
  return records
    .map((record) => {
      const title = record.title.toLowerCase();
      const tags = record.tags.join(' ').toLowerCase();
      const body = record.body.toLowerCase();
      const termScore = terms.reduce((total, term) => total
        + (title.includes(term) ? 8 : 0)
        + (tags.includes(term) ? 5 : 0)
        + (body.includes(term) ? 1 : 0), 0);
      const moduleScore = primaryModule && record.modules.includes(primaryModule) ? 20 : 0;
      return { record, score: termScore + moduleScore + (typeWeight[record.type] ?? 0) + (record.frontmatter.confirmed_by_human === true ? 8 : 0) };
    })
    .sort((left, right) => right.score - left.score || String(right.record.frontmatter.confirmed_at ?? '').localeCompare(String(left.record.frontmatter.confirmed_at ?? '')) || left.record.path.localeCompare(right.record.path))
    .map((item) => item.record);
}

function mergeFiles(files: Array<{ path: string; reason: string }>, limit = 14): Array<{ path: string; reason: string }> {
  const seen = new Set<string>();
  const output: Array<{ path: string; reason: string }> = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    output.push(file);
  }
  return output.slice(0, limit);
}

function findRelevantFiles(query: string, modules: string[], config: ProjectConfig, useIndex: boolean): Array<{ path: string; reason: string }> {
  const rows = useIndex ? querySymbols(query, modules) : [];
  if (rows.length > 0) return rows;
  return modules
    .flatMap((module) => {
      const path = config.modules[module]?.path;
      return path ? [{ path, reason: `${module} module inferred from task signals.` }] : [];
    })
    .slice(0, 10);
}

function querySymbols(query: string, modules: string[]): Array<{ path: string; reason: string }> {
  try {
    const seen = new Set<string>();
    return searchCapabilities(query, modules, 40)
      .filter((row) => {
        if (seen.has(row.path)) return false;
        seen.add(row.path);
        return true;
      })
      .slice(0, 12)
      .map((row) => ({ path: row.path, reason: `Matched ${row.kind} ${row.name} (score ${row.score}).` }));
  } catch {
    return [];
  }
}

function commandsForModules(modules: string[], config: ProjectConfig): string[] {
  return contextPackCommandsForModules(config, modules);
}

function shouldIncludeSpecification(input: ContextPackInput, modules: string[], config: ProjectConfig): boolean {
  if (config.specifications.current?.includeInContextPack !== true) return false;
  if (modules.some((module) => config.specifications.current?.modules.includes(module))) return true;
  const specificationDirectories = new Set((config.specifications.current.files ?? []).map((file) => dirname(file)));
  if ([...(input.files ?? []), ...(input.changedFiles ?? [])]
    .some((file) => [...specificationDirectories].some((directory) => file === directory || file.startsWith(`${directory}/`)))) return true;
  return /\b(?:spec|specification|mvp|product contract)\b|спецификац|техническ\w+\s+задан|\bтз\b|\bгип\b/i.test(input.query);
}

function fitContextPackBudget(pack: Omit<ContextPack, 'cache'>): Omit<ContextPack, 'cache'> {
  const output: Omit<ContextPack, 'cache'> = {
    ...pack,
    records: pack.records.map((record) => ({ ...record })),
    files: pack.files.map((file) => ({ ...file })),
    playbooks: [...pack.playbooks],
    playbookDetails: pack.playbookDetails.map((playbook) => ({ ...playbook })),
    warnings: [...pack.warnings],
    budget: { ...pack.budget },
  };
  const originalRecordCount = output.records.length;
  const originalFileCount = output.files.length;
  const originalPlaybookCount = output.playbookDetails.length;
  // Reserve a small envelope for the final budget counters and truncation warnings,
  // which are populated after payload trimming and otherwise can push a pack a few
  // tokens back over its declared limit.
  const overBudget = (): boolean => estimateContextPackTokens(output) + 128 > output.maxTokens;

  if (overBudget()) {
    output.budget.truncated = true;
    for (let index = output.playbookDetails.length - 1; index >= 0 && overBudget(); index -= 1) {
      if (output.playbookDetails[index]?.required) continue;
      output.playbookDetails.splice(index, 1);
    }
    output.playbooks = output.playbookDetails.map((playbook) => playbook.path);
    for (let index = output.files.length - 1; index >= 0 && overBudget(); index -= 1) delete output.files[index].excerpt;
    for (let index = output.records.length - 1; index >= 1 && overBudget(); index -= 1) delete output.records[index].excerpt;
    while (output.files.length > 0 && overBudget()) output.files.pop();
    while (output.records.length > 1 && overBudget()) output.records.pop();
    if (overBudget() && output.records[0]?.excerpt) output.records[0].excerpt = output.records[0].excerpt.slice(0, 160);
    if (overBudget() && output.records[0]?.excerpt) delete output.records[0].excerpt;
    if (overBudget()) output.records = [];
    output.budget.droppedRecords = originalRecordCount - output.records.length;
    output.budget.droppedFiles = originalFileCount - output.files.length;
    output.budget.droppedPlaybooks = originalPlaybookCount - output.playbookDetails.length;
    output.warnings.push(`Context pack payload truncated toward maxTokens=${output.maxTokens}.`);
    if (output.budget.droppedPlaybooks > 0) {
      output.warnings.push(`Dropped ${output.budget.droppedPlaybooks} optional playbook(s) to preserve required guidance.`);
    }
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    output.budget.payloadTokens = estimateTokens(output);
    output.budget.playbookTokens = output.playbookDetails.reduce(
      (total, playbook) => total + playbook.estimatedTokens,
      0,
    );
    output.budget.estimatedTokens = output.budget.payloadTokens + output.budget.playbookTokens;
  }
  output.budget.exceedsLimit = output.budget.estimatedTokens > output.maxTokens;
  if (output.budget.exceedsLimit) {
    output.budget.truncated = true;
    output.warnings.push(
      `Required playbooks and payload exceed maxTokens=${output.maxTokens}; `
      + `playbooks=${output.budget.playbookTokens}, payload=${output.budget.payloadTokens}.`,
    );
  }
  return output;
}

function estimateContextPackTokens(pack: Omit<ContextPack, 'cache'>): number {
  return estimateTokens(pack) + pack.playbookDetails.reduce(
    (total, playbook) => total + playbook.estimatedTokens,
    0,
  );
}

export function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
}
