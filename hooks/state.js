import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { assertExecutionPath } from '../dist/execution/store.js';
import { findRepoRoot } from '../dist/storage/repo.js';

// Keep fingerprints after finalization: a later read-only tool must not reopen the task.
export function captureChanges(input, patchFiles = []) {
  const root = findRepoRoot(input.cwd ?? process.cwd());
  process.chdir(root);
  const stateDirectory = resolve(root, '.project-context/indexes/hook-state');
  assertExecutionPath(stateDirectory);
  if (existsSync(stateDirectory)) for (const entry of readdirSync(stateDirectory)) {
    if (!entry.endsWith('.json')) continue;
    const old = resolve(stateDirectory, entry);
    assertExecutionPath(old);
    if (statSync(old).mtimeMs < Date.now() - 7 * 86400000) unlinkSync(old);
  }
  const session = createHash('sha256').update(String(input.session_id ?? 'unknown')).digest('hex');
  const path = resolve(root, '.project-context/indexes/hook-state', `${session}.json`);
  assertExecutionPath(path);
  let previous = {};
  try { previous = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
  if (!previous || typeof previous !== 'object' || Array.isArray(previous)) previous = {};
  const candidates = new Set([
    ...(Array.isArray(previous.changedFiles) ? previous.changedFiles : []), ...patchFiles,
    ...gitFiles(root, ['diff', 'HEAD', '--name-only', '-z']),
    ...gitFiles(root, ['diff', '--cached', '--name-only', '-z']),
    ...gitFiles(root, ['diff', '--name-only', '-z']),
    ...gitFiles(root, ['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const fingerprints = Object.create(null);
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const absolute = resolve(root, candidate);
    const file = relative(root, absolute).replaceAll('\\', '/');
    if (!file || file === '..' || file.startsWith('../') || isAbsolute(file)) continue;
    if (/(?:^|\/)(?:\.git|node_modules)(?:\/|$)|^\.project-context\/(?:active|drafts|archive|trash|indexes|cache)(?:\/|$)/.test(file)) continue;
    assertExecutionPath(absolute);
    if (existsSync(absolute)) {
      if (!lstatSync(absolute).isFile()) continue;
      fingerprints[file] = createHash('sha256').update(readFileSync(absolute)).digest('hex');
    } else fingerprints[file] = 'deleted';
  }
  const changedFiles = Object.keys(fingerprints).sort();
  const changed = changedFiles.some((file) => previous.fingerprints?.[file] !== fingerprints[file])
    || Object.keys(previous.fingerprints ?? {}).some((file) => !(file in fingerprints));
  const state = { changedFiles, fingerprints, startedAt: previous.startedAt ?? new Date().toISOString(), updatedAt: changed ? new Date().toISOString() : previous.updatedAt };
  if (changed || !existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } else {
    const now = new Date();
    utimesSync(path, now, now);
  }
  return { root, ...state };
}

function gitFiles(root, args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean);
  } catch { return []; }
}
