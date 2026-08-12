import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fg from 'fast-glob';
import { getBacklog } from '../backlog/backlog.js';
import { checkIndexHealth, collectDuplicateRecordIssues, openDb } from '../indexer/sqlite.js';
import { collectFileReferenceIssues } from '../storage/file-references.js';
import { contextCliCommand, loadProjectConfig, retentionNumber, type ProjectConfig } from '../storage/config.js';
import { lintContext } from '../storage/lint.js';
import { repoPaths } from '../storage/repo.js';
import { discoverRecordFiles, findRecordPath, parseRecord, readRecords } from '../storage/markdown.js';

export type DoctorDiagnostic = {
  id: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
  details?: string[];
};

export type DoctorFixProposal = {
  id: string;
  title: string;
  risk: 'low' | 'medium';
  reason: string;
  action: string;
  command?: string;
  files?: string[];
};

export type ContextDoctorResult = {
  status: 'OK' | 'WARN' | 'FAILED';
  diagnostics: DoctorDiagnostic[];
  summary: {
    ok: number;
    warn: number;
    fail: number;
  };
  fixes?: DoctorFixProposal[];
};

export type ContextDoctorOptions = {
  fixDryRun?: boolean;
};

export function contextDoctor(options: ContextDoctorOptions = {}): ContextDoctorResult {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const packageRoot = routerPackageRoot(paths.root, config);
  const records = readRecords(true);
  const activeRecords = records.filter((record) => !record.archived);
  const diagnostics: DoctorDiagnostic[] = [];

  diagnostics.push(exists(paths.contextDir, 'context-dir', '.project-context exists.', '.project-context is missing.'));
  diagnostics.push(exists(resolve(paths.contextDir, 'project.yaml'), 'project-yaml', 'project.yaml exists.', '.project-context/project.yaml is missing.'));
  diagnostics.push(exists(resolve(packageRoot, 'package.json'), 'package-json', 'Context-router package exists.', `Context-router package.json is missing at ${packageRoot}.`));
  diagnostics.push(checkDependencies(packageRoot, config));

  diagnostics.push(checkCodexConfig(paths.root, config));
  diagnostics.push(checkHooksJson(paths.root, config));
  diagnostics.push(checkGitHooksPath(paths.root, config));
  diagnostics.push(checkGitIgnore(paths.root, '.project-context/indexes/context.sqlite', 'sqlite-ignore', 'SQLite context index is ignored.', 'SQLite context index is not ignored by git.'));
  diagnostics.push(checkGitIgnore(paths.root, '.project-context/drafts/run-summaries/.doctor-probe.md', 'draft-ignore', 'Draft run summaries are ignored.', 'Draft run summaries are not ignored by git.'));
  diagnostics.push(checkIndex(records, config));
  diagnostics.push(checkSearchImplementation());
  diagnostics.push(checkRecordIds(records));
  diagnostics.push(checkFileReferences(records));
  diagnostics.push(checkBacklog(activeRecords));
  diagnostics.push(checkLint());
  diagnostics.push(checkOldHookState());
  diagnostics.push(checkOrphanFinalizeDrafts(records));
  diagnostics.push(checkPackCacheRetention());

  const summary = {
    ok: diagnostics.filter((item) => item.status === 'ok').length,
    warn: diagnostics.filter((item) => item.status === 'warn').length,
    fail: diagnostics.filter((item) => item.status === 'fail').length,
  };
  const result: ContextDoctorResult = {
    status: summary.fail > 0 ? 'FAILED' : summary.warn > 0 ? 'WARN' : 'OK',
    diagnostics,
    summary,
  };
  if (options.fixDryRun) {
    result.fixes = buildFixProposals(diagnostics, config);
  }
  return result;
}

function exists(path: string, id: string, ok: string, missing: string, missingStatus: DoctorDiagnostic['status'] = 'fail'): DoctorDiagnostic {
  return existsSync(path)
    ? { id, status: 'ok', message: ok }
    : { id, status: missingStatus, message: missing };
}

function checkDependencies(packageRoot: string, config: ProjectConfig): DoctorDiagnostic {
  if (!config.contextRouter.packagePath) {
    return { id: 'dependencies', status: 'ok', message: 'Context-router runtime dependencies resolved from the installed package.' };
  }
  return existsSync(resolve(packageRoot, 'node_modules'))
    ? { id: 'dependencies', status: 'ok', message: 'Context-router dependencies are installed.' }
    : {
      id: 'dependencies',
      status: 'warn',
      message: config.contextRouter.installCommand
        ? `Run ${config.contextRouter.installCommand}.`
        : `Context-router dependencies are missing under ${packageRoot}.`,
    };
}

function checkCodexConfig(root: string, config: ProjectConfig): DoctorDiagnostic {
  const relativePath = config.contextRouter.codexConfigPath;
  if (!relativePath) {
    return { id: 'codex-config', status: 'ok', message: 'Project config does not require a Codex MCP config file.' };
  }
  const configPath = resolve(root, relativePath);
  if (!existsSync(configPath)) {
    return { id: 'codex-config', status: 'fail', message: `${relativePath} is missing.` };
  }
  const content = readFileSync(configPath, 'utf8');
  if (!content.includes(config.contextRouter.mcpServerName)) {
    return { id: 'codex-config', status: 'fail', message: `${relativePath} does not declare ${config.contextRouter.mcpServerName} MCP server.` };
  }
  return { id: 'codex-config', status: 'ok', message: `Codex project config declares ${config.contextRouter.mcpServerName} MCP server.` };
}

function checkHooksJson(root: string, config: ProjectConfig): DoctorDiagnostic {
  const relativePath = config.contextRouter.codexHooksPath;
  const requiredEvents = config.contextRouter.requiredHookEvents;
  if (!relativePath || requiredEvents.length === 0) {
    return { id: 'codex-hooks-json', status: 'ok', message: 'Project config does not require Codex lifecycle hooks.' };
  }
  const hooksPath = resolve(root, relativePath);
  if (!existsSync(hooksPath)) {
    return { id: 'codex-hooks-json', status: 'fail', message: `${relativePath} is missing.` };
  }
  const content = readFileSync(hooksPath, 'utf8');
  for (const hookName of requiredEvents) {
    if (!content.includes(hookName)) {
      return { id: 'codex-hooks-json', status: 'warn', message: `${relativePath} does not mention ${hookName}.` };
    }
  }
  return { id: 'codex-hooks-json', status: 'ok', message: 'Codex hook config declares the expected lifecycle hooks.' };
}

function checkGitHooksPath(root: string, config: ProjectConfig): DoctorDiagnostic {
  const expectedPath = config.contextRouter.gitHooksPath;
  if (!expectedPath) {
    return { id: 'git-hooks-path', status: 'ok', message: 'Project config does not require a custom Git hooks path.' };
  }
  try {
    const hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (hooksPath === expectedPath) {
      return { id: 'git-hooks-path', status: 'ok', message: `Git hooks path is ${expectedPath}.` };
    }
    return { id: 'git-hooks-path', status: 'warn', message: `Git hooks path is "${hooksPath || '<unset>'}", expected "${expectedPath}".` };
  } catch {
    return { id: 'git-hooks-path', status: 'warn', message: 'Git hooks path is not configured.' };
  }
}

function checkGitIgnore(root: string, path: string, id: string, ok: string, notIgnored: string): DoctorDiagnostic {
  try {
    execFileSync('git', ['check-ignore', '-q', path], { cwd: root, stdio: 'ignore' });
    return { id, status: 'ok', message: ok };
  } catch {
    return { id, status: 'warn', message: notIgnored };
  }
}

function checkIndex(records: ReturnType<typeof readRecords>, config: ProjectConfig): DoctorDiagnostic {
  const paths = repoPaths();
  const indexCommand = config.commands.context_index ?? contextCliCommand(config, 'index');
  if (!existsSync(paths.sqlitePath)) {
    return { id: 'context-index', status: 'warn', message: `Context SQLite index is missing; run ${indexCommand}.` };
  }
  try {
    return checkIndexHealth(records).fresh
      ? { id: 'context-index', status: 'ok', message: 'Context SQLite index is present and fresh.' }
      : { id: 'context-index', status: 'warn', message: `Context SQLite index is stale; run ${indexCommand}.` };
  } catch (error) {
    return {
      id: 'context-index',
      status: 'fail',
      message: 'Context SQLite index freshness check failed.',
      details: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function checkSearchImplementation(): DoctorDiagnostic {
  const paths = repoPaths();
  if (!existsSync(paths.sqlitePath)) {
    return { id: 'context-search', status: 'warn', message: 'Context search index is unavailable until the SQLite index is built.' };
  }
  try {
    const db = openDb();
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'search_index'").get();
    db.close();
    return { id: 'context-search', status: 'ok', message: 'Context search index implementation is queryable.' };
  } catch (error) {
    return {
      id: 'context-search',
      status: 'fail',
      message: 'Context search/index implementation check failed.',
      details: [error instanceof Error ? error.message : String(error)],
    };
  }
}

function checkFileReferences(records: ReturnType<typeof readRecords>): DoctorDiagnostic {
  const directoryIssues = collectFileReferenceIssues(records).filter((issue) => issue.kind === 'directory');
  if (directoryIssues.length === 0) {
    return { id: 'context-file-references', status: 'ok', message: 'Context file references do not point at directories.' };
  }
  return {
    id: 'context-file-references',
    status: 'fail',
    message: `${directoryIssues.length} directory file reference(s) found in context records.`,
    details: directoryIssues.slice(0, 10).map((issue) => `${issue.recordPath}: ${issue.filePath}`),
  };
}

function checkRecordIds(records: ReturnType<typeof readRecords>): DoctorDiagnostic {
  const duplicateIssues = collectDuplicateRecordIssues(records);
  if (duplicateIssues.length === 0) {
    return { id: 'context-record-ids', status: 'ok', message: 'Context record ids are unique across indexed records.' };
  }
  return {
    id: 'context-record-ids',
    status: 'fail',
    message: `${duplicateIssues.length} duplicate context id(s) found across indexed records.`,
    details: duplicateIssues.slice(0, 10).map((issue) => `${issue.recordId}: ${issue.paths.join(', ')}`),
  };
}

function checkBacklog(records: ReturnType<typeof readRecords>): DoctorDiagnostic {
  const backlog = getBacklog({ status: 'ready,open', limit: 100, records });
  const pickable = backlog.items.filter((item) => item.blockedBy.length === 0);
  if (pickable.length === 0) {
    return { id: 'backlog-ready', status: 'warn', message: 'No unblocked ready/open backlog items are available.' };
  }
  return { id: 'backlog-ready', status: 'ok', message: `${pickable.length} unblocked ready/open backlog item(s) are available.` };
}

function checkLint(): DoctorDiagnostic {
  const lint = lintContext(false);
  if (lint.errors.length > 0) {
    return { id: 'context-lint', status: 'fail', message: `${lint.errors.length} context lint error(s).`, details: lint.errors.slice(0, 10) };
  }
  if (lint.warnings.length > 0) {
    return { id: 'context-lint', status: 'warn', message: `${lint.warnings.length} context lint warning(s).`, details: lint.warnings.slice(0, 10) };
  }
  return { id: 'context-lint', status: 'ok', message: 'Context lint is clean.' };
}

function checkOldHookState(): DoctorDiagnostic {
  const paths = repoPaths();
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const oldFiles = fg.sync('.project-context/indexes/hook-state/*.json', { cwd: paths.root })
    .filter((file) => {
      try {
        return statSync(resolve(paths.root, file)).mtimeMs < cutoffMs;
      } catch {
        return false;
      }
    });
  return oldFiles.length === 0
    ? { id: 'hook-state-retention', status: 'ok', message: 'Codex hook session state is within the 7-day TTL.' }
    : {
      id: 'hook-state-retention',
      status: 'warn',
      message: `${oldFiles.length} hook-state file(s) are older than 7 days.`,
      details: oldFiles.slice(0, 10),
    };
}

function checkOrphanFinalizeDrafts(records: ReturnType<typeof readRecords>): DoctorDiagnostic {
  const recordIds = new Set(records.map((record) => record.id));
  const orphans = records.filter((record) => {
    if (record.type !== 'run-summary' || !record.path.includes('/drafts/')) return false;
    const sourceTask = typeof record.frontmatter.source_task === 'string' ? record.frontmatter.source_task : '';
    return !sourceTask || !recordIds.has(sourceTask);
  });
  return orphans.length === 0
    ? { id: 'orphan-finalize-drafts', status: 'ok', message: 'Draft run summaries are linked to valid tasks.' }
    : {
      id: 'orphan-finalize-drafts',
      status: 'warn',
      message: `${orphans.length} draft run-summary file(s) have no valid source_task.`,
      details: orphans.slice(0, 10).map((record) => record.path),
    };
}

function checkPackCacheRetention(): DoctorDiagnostic {
  const paths = repoPaths();
  const retentionDays = retentionNumber(loadProjectConfig(), 'context_packs', 'delete_after_days', 30);
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const staleFiles = fg.sync('.project-context/indexes/pack-cache/*.json', { cwd: paths.root })
    .filter((file) => {
      try {
        return statSync(resolve(paths.root, file)).mtimeMs < cutoffMs;
      } catch {
        return false;
      }
    });
  return staleFiles.length === 0
    ? { id: 'pack-cache-retention', status: 'ok', message: `Context pack cache is within the ${retentionDays}-day retention window.` }
    : {
      id: 'pack-cache-retention',
      status: 'warn',
      message: `${staleFiles.length} context pack cache file(s) are older than ${retentionDays} days.`,
      details: staleFiles.slice(0, 10),
    };
}

function buildFixProposals(diagnostics: DoctorDiagnostic[], config: ProjectConfig): DoctorFixProposal[] {
  return [
    ...gitHooksPathFixes(diagnostics, config),
    ...duplicateIdFixes(),
    ...missingReferenceFixes(),
    ...staleIndexFixes(diagnostics, config),
    ...oldHookStateFixes(),
    ...orphanFinalizeDraftFixes(),
  ];
}

function gitHooksPathFixes(diagnostics: DoctorDiagnostic[], config: ProjectConfig): DoctorFixProposal[] {
  const diagnostic = diagnostics.find((item) => item.id === 'git-hooks-path');
  if (!diagnostic || diagnostic.status === 'ok') return [];
  const hooksPath = config.contextRouter.gitHooksPath;
  return [{
    id: 'install-git-hooks',
    title: 'Enable repository Git hooks',
    risk: 'low',
    reason: diagnostic.message,
    action: `Configure the local clone to use the versioned ${hooksPath} directory.`,
    command: config.contextRouter.gitHooksInstallCommand,
    files: hooksPath ? [`${hooksPath}/pre-commit`, `${hooksPath}/pre-push`, `${hooksPath}/post-commit`] : undefined,
  }];
}

function duplicateIdFixes(): DoctorFixProposal[] {
  const byId = new Map<string, string[]>();
  for (const file of discoverRecordFiles(true)) {
    try {
      const record = parseRecord(file);
      byId.set(record.id, [...(byId.get(record.id) ?? []), record.path]);
    } catch {
      // Lint reports invalid records separately.
    }
  }
  return [...byId.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([id, files]) => ({
      id: `duplicate-id-${id}`,
      title: `Resolve duplicate context id ${id}`,
      risk: 'medium' as const,
      reason: `Context id ${id} appears in ${files.length} indexed records.`,
      action: 'Keep the reviewed active record and move stale draft duplicates to .project-context/trash, or assign a new id before indexing.',
      command: `rg -n "^id: ${id}$" .project-context/active .project-context/drafts .project-context/archive -g '*.md'`,
      files,
    }));
}

function missingReferenceFixes(): DoctorFixProposal[] {
  const lint = lintContext(false);
  return lint.warnings
    .filter((warning) => warning.includes('referenced file does not exist'))
    .slice(0, 20)
    .map((warning, index) => {
      const [recordPath, message] = warning.split(': referenced file does not exist: ');
      const missing = message?.trim();
      return {
        id: `missing-reference-${index + 1}`,
        title: 'Review missing context file reference',
        risk: 'low' as const,
        reason: warning,
        action: 'If the file was intentionally deleted, move it from files to deleted_files in the record; otherwise restore or correct the path.',
        files: [recordPath, missing].filter((value): value is string => Boolean(value)),
      };
    });
}

function staleIndexFixes(diagnostics: DoctorDiagnostic[], config: ProjectConfig): DoctorFixProposal[] {
  const diagnostic = diagnostics.find((item) => item.id === 'context-index');
  if (!diagnostic || diagnostic.status === 'ok') return [];
  return [{
    id: 'rebuild-context-index',
    title: 'Rebuild context SQLite index',
    risk: 'low' as const,
    reason: diagnostic.message,
    action: 'Rebuild the disposable SQLite cache from Markdown/YAML and code.',
    command: config.commands.context_index ?? contextCliCommand(config, 'index'),
  }];
}

function routerPackageRoot(repositoryRoot: string, config: ProjectConfig): string {
  if (config.contextRouter.packagePath) return resolve(repositoryRoot, config.contextRouter.packagePath);
  return resolve(dirname(fileURLToPath(import.meta.url)), '../..');
}

function oldHookStateFixes(): DoctorFixProposal[] {
  const paths = repoPaths();
  const files = fg.sync('.project-context/indexes/hook-state/*.json', { cwd: paths.root });
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const oldFiles = files.filter((file) => {
    try {
      return statSync(resolve(paths.root, file)).mtimeMs < cutoffMs;
    } catch {
      return false;
    }
  });
  if (oldFiles.length === 0) return [];
  return [{
    id: 'old-hook-state',
    title: 'Clean old Codex hook session state',
    risk: 'low' as const,
    reason: `${oldFiles.length} ignored hook-state file(s) are older than 7 days.`,
    action: 'Remove stale ignored session-state files after confirming no active Codex run uses them.',
    files: oldFiles.slice(0, 20),
  }];
}

function orphanFinalizeDraftFixes(): DoctorFixProposal[] {
  const paths = repoPaths();
  const orphanFiles = fg.sync('.project-context/drafts/run-summaries/*.md', { cwd: paths.root })
    .filter((file) => {
      try {
        const record = parseRecord(resolve(paths.root, file));
        const sourceTask = typeof record.frontmatter.source_task === 'string' ? record.frontmatter.source_task : '';
        return !sourceTask || !findRecordPath(sourceTask);
      } catch {
        return false;
      }
    });
  if (orphanFiles.length === 0) return [];
  return [{
    id: 'orphan-finalize-drafts',
    title: 'Review orphan finalize drafts',
    risk: 'low' as const,
    reason: `${orphanFiles.length} draft run-summary file(s) have no valid source_task.`,
    action: 'Attach each draft to a task, promote reviewed knowledge, archive stale drafts, or leave intentionally local.',
    files: orphanFiles.slice(0, 20),
  }];
}
