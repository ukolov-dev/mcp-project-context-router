import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lintContext } from '../src/storage/lint.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-playbook-lint-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active'), { recursive: true });
  mkdirSync(resolve(tempDir, 'playbooks'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Test
modules: {}
commands:
  context_lint:
    run: test-command
    required_for: [doc]
`, 'utf8');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('playbook lint', () => {
  it('accepts routing metadata and existing relative links', () => {
    writeFileSync(resolve(tempDir, 'AGENTS.md'), '# Root rules\n', 'utf8');
    writeFileSync(resolve(tempDir, 'playbooks/backend.md'), `---
kind: policy
modules: [backend]
routing: core
required: true
triggers: []
last_verified: '2026-07-10'
verify_with: [context_lint]
---
# Backend

Read [root rules](../AGENTS.md).
`, 'utf8');

    expect(lintContext(false).errors).toEqual([]);
  });

  it('rejects incomplete conditional metadata and broken links', () => {
    writeFileSync(resolve(tempDir, 'playbooks/auth.md'), `---
kind: notes
modules: []
routing: conditional
triggers: []
last_verified: today
verify_with: [missing_command]
---
# Auth

Read [missing](./missing.md).
`, 'utf8');

    const errors = lintContext(false).errors;

    expect(errors).toContain('playbooks/auth.md: playbook kind must be policy or runbook');
    expect(errors).toContain('playbooks/auth.md: playbook modules must be a non-empty array');
    expect(errors).toContain('playbooks/auth.md: playbook required must be true or false');
    expect(errors).toContain('playbooks/auth.md: conditional playbook must declare at least one trigger');
    expect(errors).toContain('playbooks/auth.md: playbook last_verified must use YYYY-MM-DD');
    expect(errors).toContain('playbooks/auth.md: verify_with references unknown project command: missing_command');
    expect(errors).toContain('playbooks/auth.md: linked file does not exist: ./missing.md');
  });

  it('warns when playbook verification metadata is stale', () => {
    writeFileSync(resolve(tempDir, 'playbooks/legacy.md'), `---
kind: runbook
modules: [infra]
routing: conditional
required: true
triggers: [legacy]
last_verified: '2020-01-01'
verify_with: [context_lint]
---
# Legacy
`, 'utf8');

    expect(lintContext(false).warnings).toContainEqual(
      expect.stringMatching(/^playbooks\/legacy\.md: playbook verification is stale/),
    );
  });
});
