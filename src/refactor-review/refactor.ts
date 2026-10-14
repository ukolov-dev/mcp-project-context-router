import { execFileSync } from 'node:child_process';
import { findRecordPath, parseRecord } from '../storage/markdown.js';
import { repoPaths } from '../storage/repo.js';
import { inferModule } from '../indexer/capabilities.js';
import { loadProjectConfig } from '../storage/config.js';

export type RefactorCandidate = {
  title: string;
  risk: 'low' | 'medium' | 'high';
  doNow: boolean;
  reason: string;
  files: string[];
};

export function reviewDiffForRefactor(taskId?: string, options: { files?: string[]; baseCommit?: string } = {}): { candidates: RefactorCandidate[]; scope: string; files: string[]; warnings: string[]; heuristic: true } {
  const paths = repoPaths();
  const config = loadProjectConfig();
  const excludedRoots = ['.project-context', config.contextRouter.packagePath].filter((path): path is string => Boolean(path));
  const normalize = (path: string) => path.replaceAll('\\', '/').replace(/^\.\//, '');
  const taskPath = taskId ? findRecordPath(taskId) : undefined;
  const taskFiles = taskPath ? parseRecord(taskPath).files : undefined;
  const scopeFiles = options.files ?? (taskId ? taskFiles ?? [] : undefined);
  const warnings: string[] = [];
  const scope = options.files !== undefined ? 'explicit files' : taskId ? 'task contract' : options.baseCommit ? 'base commit' : 'working tree fallback';
  if (taskId && !scopeFiles?.length) warnings.push('Task has no concrete file scope; no unrelated working-tree files are reviewed. Supply explicit files.');
  if (scope === 'working tree fallback') warnings.push('Unscoped working-tree heuristic; changes may belong to other tasks.');
  let base = 'HEAD';
  if (options.baseCommit) base = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${options.baseCommit}^{commit}`], { cwd: paths.root, encoding: 'utf8' }).trim();
  let changed: string[] = [];
  try {
    changed = execFileSync('git', ['diff', '--name-only', '-z', base, '--'], { cwd: paths.root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean)
      .filter((path) => !excludedRoots.some((root) => path === root || path.startsWith(`${root}/`)));
  } catch {
    changed = [];
  }
  try { changed.push(...execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: paths.root, encoding: 'utf8' }).split('\0').filter(Boolean)); } catch { /* Git unavailable: retain the explicit diagnostic scope. */ }
  changed = [...new Set(changed.map(normalize))].filter((path) => !excludedRoots.some((root) => path === root || path.startsWith(`${root}/`)));
  if (scopeFiles !== undefined) { const allowed = new Set(scopeFiles.map(normalize)); changed = changed.filter((file) => allowed.has(file)); }
  const modules = new Set(changed.map(inferModule).filter((module) => module !== 'unknown'));
  const candidates: RefactorCandidate[] = [];
  if (changed.length >= 3 && modules.size === 1) {
    candidates.push({
      title: `Review local duplication in ${[...modules][0]} changes`,
      risk: 'low',
      doNow: true,
      reason: 'Multiple files changed in one module; local extraction may be safe if duplication was introduced by the current task.',
      files: changed,
    });
  }
  if (modules.size > 1) {
    const candidate = {
      title: 'Cross-module cleanup after current change',
      risk: 'medium' as const,
      doNow: false,
      reason: 'Current diff spans multiple modules; broad cleanup should be a separate confirmed refactor task.',
      files: changed,
    };
    candidates.push(candidate);

  }
  return { candidates, scope, files: changed, warnings, heuristic: true };
}
