import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const hookPath = resolve(here, '../hooks/user-prompt-submit.js');

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-user-prompt-hook-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('UserPromptSubmit hook draft inbox reminder', () => {
  it('adds reviewable draft counts without dropping the task workflow reminder', () => {
    writeDraft('apis/API-20260622-001.md');
    writeDraft('apis/API-20260622-002.md');
    writeDraft('data-entities/DATA-ENTITY-20260622-001.md');
    writeDraft('run-summaries/20260622-001.md');
    writeDraft('tasks/TASK-20260622-001.md');
    writeDraft('refactors/REFACTOR-20260622-001.md');

    const output = runHook({ prompt: 'добавь draft inbox hook', cwd: tempDir });

    expect(output.hookSpecificOutput.hookEventName).toBe('UserPromptSubmit');
    expect(output.hookSpecificOutput.additionalContext).toContain('Context workflow');
    expect(output.hookSpecificOutput.additionalContext).toContain('Draft inbox:');
    expect(output.hookSpecificOutput.additionalContext).toContain('api=2');
    expect(output.hookSpecificOutput.additionalContext).toContain('data_entity=1');
    expect(output.hookSpecificOutput.additionalContext).toContain('promote-draft RECORD-ID --apply --approved-by');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('run-summary');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('task=');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('refactor=');
  });

  it('stays quiet about drafts when no reviewable draft exists', () => {
    writeDraft('run-summaries/20260622-001.md');
    writeDraft('tasks/TASK-20260622-001.md');

    const output = runHook({ prompt: 'добавь обычный hook', cwd: tempDir });

    expect(output.hookSpecificOutput.additionalContext).toContain('Context workflow');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('Draft inbox');
  });

  it('uses project-configured branding and MCP names', () => {
    const configDir = resolve(tempDir, '.project-context');
    mkdirSync(configDir, { recursive: true });
    writeFileSync(resolve(configDir, 'project.yaml'), `context_router:
  cli_command: custom-context
  mcp_server_name: custom_context
  resource_scheme: custom-context
  brand:
    logo_text: "[Custom Context]"
`, 'utf8');

    const output = runHook({ prompt: 'добавь context workflow', cwd: tempDir });

    expect(output.hookSpecificOutput.additionalContext).toContain('[Custom Context]');
    expect(output.hookSpecificOutput.additionalContext).toContain('custom_context.validate_task');
    expect(output.hookSpecificOutput.additionalContext).not.toContain('ppm_context');
  });

  it.each([
    'сделай bootstrap checklist',
    'перепиши project.yaml metadata',
    'обнови task contract template',
    'подключи context hook',
    'build portable workflow docs',
    'update command metadata',
  ])('recognizes multilingual task prompt: %s', (prompt) => {
    const output = runHook({ prompt, cwd: tempDir });

    expect(output.hookSpecificOutput.additionalContext).toContain('Context workflow');
  });

  it('does not classify a read-only review as implementation work', () => {
    const result = spawnSync(process.execPath, [hookPath], {
      cwd: tempDir,
      input: JSON.stringify({ prompt: 'проверь переносимый workflow', cwd: tempDir }),
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
  });
});

function writeDraft(relativePath: string) {
  const target = resolve(tempDir, '.project-context/drafts', relativePath);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, '---\nstatus: draft\n---\n\n# Draft\n', 'utf8');
}

function runHook(payload: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [hookPath], {
    cwd: tempDir,
    input: JSON.stringify(payload),
    encoding: 'utf8',
  });

  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout).not.toBe('');
  return JSON.parse(result.stdout);
}
