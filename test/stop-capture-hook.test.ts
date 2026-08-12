import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../hooks/stop-capture.js');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-stop-hook-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Stop hook task boundary', () => {
  it('does not block changes that are not linked to a confirmed task', () => {
    const statePath = writeState('quiet-session', ['doc/unrelated.md']);

    const result = runHook('quiet-session');

    expect(result.stdout).toBe('');
    expect(existsSync(statePath)).toBe(false);
  });

  it('blocks when a confirmed task explicitly owns a changed file', () => {
    writeState('task-session', ['tools/ppm-context/src/context-pack/pack.ts']);
    const taskDir = resolve(tempDir, '.project-context/active/tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, 'TASK-CONTEXT-001.md'), `---
id: TASK-CONTEXT-001
type: task
status: confirmed
title: Improve context pack
files:
  - tools/ppm-context/src/context-pack/pack.ts
---
`, 'utf8');

    const result = runHook('task-session');
    const output = JSON.parse(result.stdout);

    expect(output.decision).toBe('block');
    expect(output.reason).toContain('TASK-CONTEXT-001');
  });

  it('uses project-configured branding and MCP server names', () => {
    writeState('custom-session', ['src/context-pack/pack.ts']);
    const taskDir = resolve(tempDir, '.project-context/active/tasks');
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(resolve(taskDir, 'TASK-CONTEXT-002.md'), `---
id: TASK-CONTEXT-002
type: task
status: confirmed
title: Improve context pack
files:
  - src/context-pack/pack.ts
---
`, 'utf8');
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `context_router:
  mcp_server_name: custom_context
  brand:
    logo_text: "[Custom Context]"
`, 'utf8');

    const output = JSON.parse(runHook('custom-session').stdout);

    expect(output.reason).toContain('[Custom Context]');
    expect(output.reason).toContain('custom_context.finalize_work');
  });
});

function writeState(sessionId: string, changedFiles: string[]): string {
  const statePath = resolve(tempDir, '.project-context/indexes/hook-state', `${sessionId}.json`);
  mkdirSync(resolve(statePath, '..'), { recursive: true });
  writeFileSync(statePath, JSON.stringify({ changedFiles, updatedAt: new Date().toISOString() }), 'utf8');
  return statePath;
}

function runHook(sessionId: string) {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: tempDir,
    input: JSON.stringify({ cwd: tempDir, session_id: sessionId }),
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  return result;
}
