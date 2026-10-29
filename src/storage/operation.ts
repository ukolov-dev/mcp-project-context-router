import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { repoPaths } from './repo.js';

type Cached = { stamp: string; value: string };
const operations = new AsyncLocalStorage<{ root: string; canonicalRoot?: string; texts: Map<string, Cached>; hashes: Map<string, Cached> }>();

export function withFileOperation<T>(action: () => T): T {
  const root = repoPaths().root;
  if (operations.getStore()?.root === root) return action();
  return operations.run({ root, texts: new Map(), hashes: new Map() }, action);
}

export function realPath(path: string): string {
  try { return realpathSync.native(path); }
  catch { return realpathSync(path); }
}

export function canonicalRepositoryRoot(root: string): string {
  const context = operations.getStore();
  if (!context || context.root !== root) return realPath(root);
  return context.canonicalRoot ??= realPath(root);
}

function cachedRead(path: string, kind: 'texts' | 'hashes', read: () => string): string {
  const context = operations.getStore();
  if (!context || context.root !== repoPaths().root) return read();
  // Fresh identity/metadata follows links on every access; never cache path authorization.
  const stat = statSync(path, { bigint: true });
  const stamp = `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const cache = context[kind];
  const prior = cache.get(path);
  if (prior?.stamp === stamp) return prior.value;
  const value = read();
  cache.set(path, { stamp, value });
  return value;
}

export function readOperationText(path: string): string {
  return cachedRead(path, 'texts', () => readFileSync(path, 'utf8'));
}

export function operationChecksum(path: string): string {
  return cachedRead(path, 'hashes', () => createHash('sha256').update(readFileSync(path)).digest('hex'));
}
