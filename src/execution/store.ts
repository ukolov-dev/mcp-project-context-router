import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import { parseRecord, renderMarkdown } from '../storage/markdown.js';
import { repoPaths } from '../storage/repo.js';
import { redactSecrets } from '../storage/secrets.js';
import { nowCompactTimestamp } from '../storage/time.js';
import { getVerificationPlan } from '../verification/verification.js';
import { executionIdSchema, type CodeSnapshot } from './types.js';

export type ExecutionRecordKind = 'agent-runs' | 'acceptance-reviews' | 'verification';
const kinds: ExecutionRecordKind[] = ['agent-runs', 'acceptance-reviews', 'verification'];
const metadataDirectory = /^\.project-context\/(?:active|drafts|archive|trash|indexes|cache)(?:\/|$)/;
const gitLimit = 64 * 1024 * 1024;

/** Reject symlink traversal before touching repository data. Missing leaves are allowed for writes. */
export function assertExecutionPath(path: string): void {
  const root = resolve(repoPaths().root);
  const rel = relative(root, resolve(path));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Execution path escapes repository boundary.');
  let cursor = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Execution storage cannot traverse symlink: ${relative(root, cursor)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

function recordDirectory(kind: ExecutionRecordKind, create = false): string {
  if (!kinds.includes(kind)) throw new Error('Unknown execution record kind.');
  const path = resolve(repoPaths().activeDir, kind);
  assertExecutionPath(path);
  if (create) mkdirSync(path, { recursive: true });
  return path;
}

function recordPath(kind: ExecutionRecordKind, id: string): string {
  executionIdSchema.parse(id);
  const path = resolve(recordDirectory(kind), `${id}.md`);
  assertExecutionPath(path);
  return path;
}

export function executionRecordIds(kind: ExecutionRecordKind): string[] {
  const dir = recordDirectory(kind);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((file) => file.endsWith('.md')).map((file) => {
    const id = executionIdSchema.parse(file.slice(0, -3));
    assertExecutionPath(resolve(dir, file));
    return id;
  });
}

export function readExecutionRecord(kind: ExecutionRecordKind, id: string): Record<string, unknown> {
  const path = recordPath(kind, id);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Execution record is not a regular file.');
    const parsed = matter(readFileSync(fd, 'utf8')).data;
    if (parsed.id !== id) throw new Error(`Execution record identity mismatch: ${id}`);
    return parsed;
  } finally { closeSync(fd); }
}

/** The caller holds withRunLock; publication is atomic, including exclusive creation. */
export function writeExecutionRecord(kind: ExecutionRecordKind, id: string, frontmatter: Record<string, unknown>, body = '', replace = false): string {
  const dir = recordDirectory(kind, true);
  const target = recordPath(kind, id);
  if (frontmatter.id !== id) throw new Error('Execution record identity mismatch.');
  const type = kind === 'agent-runs' ? 'agent-run' : kind === 'acceptance-reviews' ? 'acceptance-review' : 'verification-evidence';
  const timestamp = frontmatter.createdAt ?? new Date().toISOString();
  const record = {
    type,
    status: frontmatter.status ?? frontmatter.verdict ?? 'recorded',
    title: `${type} ${id}`,
    created_at: timestamp,
    updated_at: frontmatter.updatedAt ?? timestamp,
    modules: [], files: [], tags: ['execution'], retention: 'normal',
    ...frontmatter,
  };
  const temporary = resolve(dir, `.${id}.${randomUUID()}.tmp`);
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, renderMarkdown(record, body || `# ${record.title}`), 'utf8');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    assertExecutionPath(target);
    if (replace) {
      if (!existsSync(target)) throw new Error(`Execution record missing: ${id}`);
      renameSync(temporary, target);
    } else {
      linkSync(temporary, target);
    }
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return relative(repoPaths().root, target).split(sep).join('/');
}

/** One short storage lock also serializes attempt/ID allocation across processes. */
export function withRunLock<T>(runId: string, action: () => T): T {
  executionIdSchema.parse(runId);
  const lock = resolve(recordDirectory('agent-runs', true), '.execution.lock');
  assertExecutionPath(lock);
  let fd: number;
  try {
    fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Execution storage is busy. Retry after the other mutation finishes; a crashed writer may require removing .execution.lock.');
    throw error;
  }
  try {
    writeFileSync(fd, `${process.pid}\n`);
    return action();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

/** Call while holding the storage lock; keep existing context record ID compatibility. */
export function newExecutionId(prefix: string): string {
  executionIdSchema.parse(prefix);
  const stamp = `${prefix}-${nowCompactTimestamp()}-`;
  const sequence = Math.max(0, ...kinds.flatMap(executionRecordIds).filter((id) => id.startsWith(stamp)).map((id) => Number(id.slice(stamp.length))).filter(Number.isFinite)) + 1;
  if (sequence > 999) throw new Error('Execution record ID capacity reached for this second; retry.');
  return `${stamp}${String(sequence).padStart(3, '0')}`;
}

function checkRecordTree(path: string): void {
  assertExecutionPath(path);
  if (!existsSync(path)) return;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name);
    assertExecutionPath(child);
    if (entry.isDirectory()) checkRecordTree(child);
  }
}

export function readTaskContract(taskId: string): {
  taskId: string; path: string; body: string; taskDigest: string;
  acceptanceCriteria: Array<{ id: string; text: string }>; requiredChecks: string[];
} {
  executionIdSchema.parse(taskId);
  const paths = repoPaths();
  const taskPath = resolve(paths.activeDir, 'tasks', `${taskId}.md`);
  assertExecutionPath(taskPath);
  assertExecutionPath(resolve(paths.contextDir, 'project.yaml'));
  // The existing verification planner discovers records; preflight its search boundary.
  for (const dir of [paths.activeDir, paths.draftsDir, paths.archiveDir]) checkRecordTree(dir);
  const task = parseRecord(taskPath);
  if (task.id !== taskId || task.type !== 'task' || task.frontmatter.confirmed_by_human !== true
    || !['confirmed', 'in_progress'].includes(task.status)) throw new Error(`A confirmed Task Contract is required: ${taskId}`);
  const criteriaSection = /^##\s+Acceptance Criteria\s*\r?\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(task.body)?.[1] ?? '';
  const acceptanceCriteria = criteriaSection.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, '')).filter((line) => Boolean(line) && !/^(?:none|нет\.?|to be confirmed\.?|-)$/i.test(line)).map((text, index) => ({ id: `AC-${index + 1}`, text }));
  const requiredChecks = [...new Set(getVerificationPlan({ id: taskId }).required.map((check) => check.command.trim()))];
  const taskDigest = hash(JSON.stringify({ taskId, body: task.body, modules: task.modules, files: task.files, acceptanceCriteria, requiredChecks }));
  return { taskId, path: relative(paths.root, taskPath).split(sep).join('/'), body: task.body, taskDigest, acceptanceCriteria, requiredChecks };
}

export function executionGit(args: string[]): string {
  const filterOverrides: string[] = [];
  if (args[0] === 'diff') {
    // Git may apply clean/process filters to working files even with external diff
    // and textconv disabled. Snapshotting must never run those repository programs.
    let keys = '';
    try {
      keys = execFileSync('git', ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$'], {
        cwd: repoPaths().root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      if ((error as { status?: number }).status !== 1) throw error;
    }
    for (const key of keys.split('\0').filter(Boolean)) filterOverrides.push('-c', `${key}=${key.endsWith('.required') ? 'false' : ''}`);
  }
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.fileMode=true', '-c', 'color.ui=false', ...filterOverrides, ...args], {
    cwd: repoPaths().root, encoding: 'utf8', maxBuffer: gitLimit, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function resolveExecutionCommit(ref: string): string {
  // rev-parse --end-of-options prevents revision names becoming options.
  const commit = executionGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error('Expected a Git commit.');
  return commit;
}

function sourcePathSafe(path: string): void {
  const root = resolve(repoPaths().root);
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Source path escapes repository boundary.');
  const segments = rel.split(sep);
  let cursor = root;
  for (let index = 0; index < segments.length; index++) {
    cursor = resolve(cursor, segments[index]);
    try {
      if (!lstatSync(cursor).isSymbolicLink()) continue;
      if (index < segments.length - 1) throw new Error(`Source directory is a symlink: ${path}`);
      const destination = resolve(dirname(cursor), readlinkSync(cursor));
      const realDestination = existsSync(destination) ? realpathSync(destination) : destination;
      const destinationRel = relative(realpathSync(root), realDestination);
      if (isAbsolute(destinationRel) || destinationRel === '..' || destinationRel.startsWith(`..${sep}`)) throw new Error(`Source symlink escapes repository boundary: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return;
      throw error;
    }
  }
}

export function captureCodeSnapshot(baseCommit: string): CodeSnapshot {
  const base = resolveExecutionCommit(baseCommit);
  const headCommit = resolveExecutionCommit('HEAD');
  if (executionGit(['ls-files', '--stage', '-z']).split('\0').some((entry) => entry.startsWith('160000 '))) {
    throw new Error('Execution snapshots do not support Git submodules; verify in a repository without submodules.');
  }
  if (executionGit(['ls-files', '-v', '-z']).split('\0').filter(Boolean)
    .some((entry) => !metadataDirectory.test(entry.slice(2)) && (entry[0] === 'S' || /[a-z]/.test(entry[0])))) {
    throw new Error('Execution snapshots do not support assume-unchanged or skip-worktree index flags; clear those flags before verification.');
  }
  const tracked = executionGit(['ls-files', '-z']).split('\0').filter(Boolean).filter((path) => !metadataDirectory.test(path));
  const untracked = executionGit(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).filter((path) => !metadataDirectory.test(path)).sort();
  for (const path of [...tracked, ...untracked]) sourcePathSafe(path);
  const exclusions = ['active', 'drafts', 'archive', 'trash', 'indexes', 'cache'].map((dir) => `:(exclude).project-context/${dir}/**`);
  const diffArgs = ['--no-ext-diff', '--no-textconv', '--binary', '--no-renames'];
  const cachedDiff = executionGit(['diff', ...diffArgs, '--cached', base, '--', '.', ...exclusions]);
  const unstagedDiff = executionGit(['diff', ...diffArgs, '--', '.', ...exclusions]);
  const changedFiles = [...new Set([
    ...executionGit(['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--no-renames', '-z', base, '--', '.', ...exclusions]).split('\0').filter(Boolean),
    ...executionGit(['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', '--no-renames', '-z', base, '--', '.', ...exclusions]).split('\0').filter(Boolean),
    ...untracked,
  ])].sort();
  const untrackedData = untracked.map((path) => {
    const absolute = resolve(repoPaths().root, path);
    const stat = lstatSync(absolute);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`Unsupported source file type: ${path}`);
    if (stat.size > gitLimit) throw new Error(`Untracked source file exceeds snapshot limit: ${path}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute);
    return { path, mode: stat.mode & 0o777, digest: hash(bytes), bytes };
  });
  const codeDigest = hash(JSON.stringify({ baseCommit: base, headCommit, cachedDiff, unstagedDiff, untracked: untrackedData.map(({ bytes: _bytes, ...entry }) => entry) }));
  const untrackedDiff = untrackedData.map(({ path, bytes, digest }) => `\n--- /dev/null\n+++ ${path}\n${bytes.includes(0) ? `[binary file sha256:${digest}]` : bytes.toString('utf8').split('\n').map((line) => `+${line}`).join('\n')}`).join('\n');
  return { codeDigest, baseCommit: base, headCommit, changedFiles, diff: redactExecutionText(`## Committed and staged changes\n${cachedDiff}\n## Unstaged changes\n${unstagedDiff}\n## Untracked files\n${untrackedDiff}`) };
}

function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

export function redactExecutionText(text: string): string {
  return redactSecrets(text)
    .split(repoPaths().root).join('<repo>')
    .replace(/\/(?:Users|home)\/[^\s'"`<>]+/g, '<local-path>')
    .replace(/[A-Za-z]:\\Users\\[^\s'"`<>]+/g, '<local-path>');
}
