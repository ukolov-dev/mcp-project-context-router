import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(actual.execFileSync),
  };
});

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-perf-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.git'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });

  for (let index = 1; index <= 25; index += 1) {
    const id = `BACKLOG-PERF-${String(index).padStart(3, '0')}`;
    writeFileSync(
      resolve(tempDir, `.project-context/active/backlog/${id}.md`),
      `---
id: ${id}
type: backlog
status: ready
priority: P1
agent_size: small
title: Performance record ${index}
modules:
  - tools
tags:
  - performance
depends_on: []
acceptance_criteria:
  - Fast enough
checks:
  - npm --prefix tools/ppm-context run test
retention: keep
---

# Performance record ${index}

Record used to prove context parsing does not shell out once per file.
`,
      'utf8',
    );
  }
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe('context-router performance regressions', () => {
  it('does not resolve the git root once per parsed context record', async () => {
    const { readRecords } = await import('../src/storage/markdown.js');

    const records = readRecords(false);

    expect(records).toHaveLength(25);
    const gitRootLookups = vi.mocked(execFileSync).mock.calls.filter(([command, args]) => (
      command === 'git' && Array.isArray(args) && args.join(' ') === 'rev-parse --show-toplevel'
    ));
    expect(gitRootLookups.length).toBeLessThanOrEqual(1);
  });
});
