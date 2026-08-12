import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type RepoPaths = {
  root: string;
  contextDir: string;
  activeDir: string;
  draftsDir: string;
  archiveDir: string;
  trashDir: string;
  indexesDir: string;
  sqlitePath: string;
};

const repoRootByCwd = new Map<string, string>();
const repoPathsByRoot = new Map<string, RepoPaths>();

export function findRepoRoot(cwd = process.cwd()): string {
  const resolvedCwd = resolve(cwd);
  const cached = repoRootByCwd.get(resolvedCwd);
  if (cached) return cached;

  let root: string;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: resolvedCwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    let cursor = resolvedCwd;
    while (true) {
      if (existsSync(resolve(cursor, '.git'))) {
        root = cursor;
        break;
      }
      const parent = dirname(cursor);
      if (parent === cursor) {
        root = resolvedCwd;
        break;
      }
      cursor = parent;
    }
  }
  repoRootByCwd.set(resolvedCwd, root);
  return root;
}

export function repoPaths(cwd = process.cwd()): RepoPaths {
  const root = findRepoRoot(cwd);
  const cached = repoPathsByRoot.get(root);
  if (cached) return cached;

  const contextDir = resolve(root, '.project-context');
  const indexesDir = resolve(contextDir, 'indexes');
  const paths = {
    root,
    contextDir,
    activeDir: resolve(contextDir, 'active'),
    draftsDir: resolve(contextDir, 'drafts'),
    archiveDir: resolve(contextDir, 'archive'),
    trashDir: resolve(contextDir, 'trash'),
    indexesDir,
    sqlitePath: resolve(indexesDir, 'context.sqlite'),
  };
  repoPathsByRoot.set(root, paths);
  return paths;
}

export function relPath(root: string, path: string): string {
  return resolve(path).startsWith(resolve(root)) ? resolve(path).slice(resolve(root).length + 1) : path;
}

export function gitIgnoredPaths(paths: Iterable<string>, cwd = process.cwd()): Set<string> {
  const candidates = [...new Set(paths)].filter(Boolean);
  if (candidates.length === 0) return new Set();

  const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin', '-z'], {
    cwd: findRepoRoot(cwd),
    input: `${candidates.join('\0')}\0`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  if (result.status !== 0 && result.status !== 1) return new Set();
  return new Set((result.stdout ?? '').split('\0').filter(Boolean));
}
