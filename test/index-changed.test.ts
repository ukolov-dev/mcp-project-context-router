import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { changedFilesInCommit, isIndexRelevantPath } from '../src/indexer/changed.js';

let originalCwd: string | undefined;
let tempDir: string | undefined;

afterEach(() => {
  if (originalCwd) process.chdir(originalCwd);
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  originalCwd = undefined;
  tempDir = undefined;
});

describe('post-commit index routing', () => {
  it.each([
    '.project-context/active/tasks/TASK-1.md',
    '.project-context/drafts/decisions/DECISION-1.md',
  ])('treats %s as index relevant', (path) => {
    expect(isIndexRelevantPath(path)).toBe(true);
  });

  it('uses project-configured source globs instead of source-repository paths', () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-index-routing-'));
    mkdirSync(resolve(tempDir, '.git'));
    mkdirSync(resolve(tempDir, '.project-context'));
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Neutral Router Test
modules:
  api:
    path: services/api
    source_globs: ["services/api/src/**/*.java"]
  web:
    path: apps/web
    source_globs: ["apps/web/src/**/*.{ts,tsx}"]
  router:
    path: packages/router
    source_globs: ["packages/router/src/**/*.ts"]
  infra:
    path: deploy
    source_globs: ["deploy/**/*.{yaml,yml}"]
  docs:
    path: handbook
    source_globs: ["handbook/**/*.md"]
`, 'utf8');
    process.chdir(tempDir);

    for (const path of [
      'apps/web/src/ProjectsPage.tsx',
      'services/api/src/Service.java',
      'packages/router/src/cli.ts',
      'deploy/docker-compose.local.yml',
      'handbook/testing.md',
    ]) {
      expect(isIndexRelevantPath(path), path).toBe(true);
    }
    for (const path of [
      '.project-context/README.md',
      '.project-context/active/README.md',
      'apps/web/public/favicon.svg',
      'services/api/README.md',
      'scripts/verify.sh',
      'ppm-frontend/src/Legacy.tsx',
    ]) {
      expect(isIndexRelevantPath(path), path).toBe(false);
    }
  });

  it('reads NUL-delimited paths from the committed tree', () => {
    originalCwd = process.cwd();
    tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-index-changed-'));
    execFileSync('git', ['init', '-q'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.name', 'Index Tests'], { cwd: tempDir });
    execFileSync('git', ['config', 'user.email', 'index-tests@localhost'], { cwd: tempDir });
    const unusualPath = 'doc/file\nname.md';
    mkdirSync(resolve(tempDir, 'doc'), { recursive: true });
    writeFileSync(resolve(tempDir, unusualPath), '# changed\n', 'utf8');
    execFileSync('git', ['add', unusualPath], { cwd: tempDir });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: tempDir });
    process.chdir(tempDir);

    expect(changedFilesInCommit()).toEqual([unusualPath]);
  });
});
