import { execFileSync } from 'node:child_process';
import { isCapabilitySourcePath } from './capabilities.js';
import { repoPaths } from '../storage/repo.js';

export function changedFilesInCommit(commit = 'HEAD'): string[] {
  const output = execFileSync(
    'git',
    ['diff-tree', '--root', '-m', '--no-commit-id', '--name-only', '-r', '-z', commit],
    {
      cwd: repoPaths().root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  return [...new Set(output.split('\0').filter(Boolean))];
}

export function isIndexRelevantPath(filePath: string): boolean {
  if (/^\.project-context\/(?:active|drafts|archive)\/.*\.md$/.test(filePath)) {
    return !filePath.endsWith('/README.md');
  }
  return isCapabilitySourcePath(filePath);
}
