import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { contextDoctor } from '../src/doctor/doctor.js';
import { installGitHooks } from '../src/git-hooks/git-hooks.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-git-hooks-'));
  execFileSync('git', ['init', '-q'], { cwd: tempDir });
  mkdirSync(resolve(tempDir, '.project-context/active/tasks'), { recursive: true });
  writeFileSync(resolve(tempDir, 'tracked.txt'), 'ok\n', 'utf8');
  writeFileSync(resolve(tempDir, '.gitignore'), '.project-context/indexes/\n.project-context/drafts/\n', 'utf8');
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Hook Test
context_router:
  cli_command: project-context
  codex_config_path: false
  codex_hooks_path: false
  git_hooks_path: false
modules: {}
commands: {}
`, 'utf8');
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Git pre-commit doctor hook', () => {
  it('installs a managed executable hook and configures the repository', () => {
    const result = installGitHooks();

    expect(result).toEqual(expect.objectContaining({
      status: 'OK',
      hooksPath: '.githooks',
      hook: '.githooks/pre-commit',
      created: true,
      configured: true,
    }));
    const hook = readFileSync(resolve(tempDir, '.githooks/pre-commit'), 'utf8');
    expect(hook).toContain('PROJECT_CONTEXT managed pre-commit doctor hook');
    expect(hook).toContain('project-context doctor --commit --json');
    expect(execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: tempDir, encoding: 'utf8' }).trim()).toBe('.githooks');
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8')).toContain('git_hooks_path: .githooks');
    expect(contextDoctor().diagnostics).toContainEqual(expect.objectContaining({
      id: 'git-hooks-path',
      status: 'ok',
    }));
  });

  it('does not overwrite an unrelated pre-commit hook', () => {
    mkdirSync(resolve(tempDir, '.githooks'));
    writeFileSync(resolve(tempDir, '.githooks/pre-commit'), '#!/bin/sh\necho custom\n', 'utf8');

    expect(() => installGitHooks()).toThrow(/not managed by Project Context/);
    expect(readFileSync(resolve(tempDir, '.githooks/pre-commit'), 'utf8')).toContain('echo custom');
  });

  it('propagates validator failure and blocks the commit', () => {
    writeFileSync(resolve(tempDir, 'validator.sh'), '#!/bin/sh\nexit 23\n', 'utf8');
    chmodSync(resolve(tempDir, 'validator.sh'), 0o755);
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Hook Test
context_router:
  cli_command: ./validator.sh
  git_hooks_path: false
modules: {}
commands: {}
`, 'utf8');
    installGitHooks();

    const hook = spawnSync(resolve(tempDir, '.githooks/pre-commit'), [], { cwd: tempDir, encoding: 'utf8' });
    expect(hook.status).toBe(23);
    expect(hook.stdout).toContain('Validating mappings and file references before commit');
  });

  it('makes missing record file references fail doctor', () => {
    writeFileSync(resolve(tempDir, '.project-context/active/tasks/TASK-20260923-120000-001.md'), `---
id: TASK-20260923-120000-001
type: task
status: confirmed
title: Broken mapping
confirmed_by_human: true
modules: []
files: [missing.txt]
retention: normal
---
# Broken mapping
`, 'utf8');

    const result = contextDoctor({ commitValidation: true });
    expect(result.status).toBe('FAILED');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      id: 'context-file-references',
      status: 'fail',
      details: [expect.stringContaining('missing.txt (missing)')],
    }));
  });

  it('fails doctor when routing references an unknown module', () => {
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Hook Test
routing:
  default_modules: [missing]
context_router:
  cli_command: project-context
modules: {}
commands: {}
`, 'utf8');

    const result = contextDoctor({ commitValidation: true });
    expect(result.status).toBe('FAILED');
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      id: 'context-mappings',
      status: 'fail',
      details: ['routing references unknown module: missing'],
    }));
  });

  it('allows the managed hook to be updated idempotently', () => {
    installGitHooks();
    const second = installGitHooks();
    expect(second.created).toBe(false);
    expect(existsSync(resolve(tempDir, '.githooks/pre-commit'))).toBe(true);
  });
});
