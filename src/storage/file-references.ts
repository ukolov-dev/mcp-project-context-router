import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { repoPaths } from './repo.js';
import type { ContextRecord } from './types.js';

export type FileReferenceKind = 'file' | 'missing' | 'directory' | 'other' | 'outside_repository';

export type FileReferenceStatus = {
  filePath: string;
  absolutePath: string;
  kind: FileReferenceKind;
  reason?: string;
};

export type FileReferenceIssue = {
  recordId: string;
  recordPath: string;
  filePath: string;
  kind: Exclude<FileReferenceKind, 'file'>;
};

export function classifyFileReference(filePath: string): FileReferenceStatus {
  const root = repoPaths().root;
  const absolutePath = resolve(root, filePath);
  if (!filePath.trim() || isAbsolute(filePath) || !isPathWithin(root, absolutePath)) {
    return {
      filePath,
      absolutePath,
      kind: 'outside_repository',
      reason: 'Path must be a non-empty repository-relative path.',
    };
  }
  if (!existingAncestorStaysWithinRepository(root, absolutePath)) {
    return {
      filePath,
      absolutePath,
      kind: 'outside_repository',
      reason: 'Path resolves outside the repository through a symbolic link.',
    };
  }
  if (!existsSync(absolutePath)) {
    return { filePath, absolutePath, kind: 'missing' };
  }
  const stat = statSync(absolutePath);
  if (stat.isFile()) {
    return { filePath, absolutePath, kind: 'file' };
  }
  if (stat.isDirectory()) {
    return { filePath, absolutePath, kind: 'directory' };
  }
  return { filePath, absolutePath, kind: 'other' };
}

export function isRepositoryPath(filePath: string): boolean {
  return classifyFileReference(filePath).kind !== 'outside_repository';
}

function existingAncestorStaysWithinRepository(root: string, target: string): boolean {
  let existing = target;
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return false;
    existing = parent;
  }

  try {
    return isPathWithin(realpathSync(root), realpathSync(existing));
  } catch {
    return false;
  }
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === ''
    || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot));
}

export function collectFileReferenceIssues(records: ContextRecord[]): FileReferenceIssue[] {
  return records.flatMap((record) => {
    const deletedFiles = new Set(record.deletedFiles);
    return record.files.flatMap((filePath) => {
      if (deletedFiles.has(filePath)) return [];
      const status = classifyFileReference(filePath);
      if (status.kind === 'file') return [];
      return [{
        recordId: record.id,
        recordPath: record.path,
        filePath,
        kind: status.kind,
      }];
    });
  });
}
