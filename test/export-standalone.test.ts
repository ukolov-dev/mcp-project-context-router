import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let destination: string | undefined;

afterEach(() => {
  if (destination) rmSync(destination, { recursive: true, force: true });
  destination = undefined;
});

describe('standalone repository export', () => {
  it('copies only reusable source and creates clean repository context', () => {
    destination = mkdtempSync(resolve(tmpdir(), 'project-context-export-test-'));
    const result = spawnSync(process.execPath, [
      resolve(packageRoot, 'scripts/export-standalone.mjs'),
      '--destination', destination,
      '--name', 'Standalone Context Router',
      '--version', '0.4.0',
    ], { cwd: packageRoot, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ copiedProjectRecords: false }));
    expect(existsSync(resolve(destination, 'src/mcp/server.ts'))).toBe(true);
    expect(existsSync(resolve(destination, 'test/portability.test.ts'))).toBe(true);
    expect(existsSync(resolve(destination, '.project-context/project.yaml'))).toBe(true);
    expect(existsSync(resolve(destination, '.project-context/active/tasks'))).toBe(true);
    expect(readdirSync(resolve(destination, '.project-context/active/tasks'))).toEqual([]);
    expect(existsSync(resolve(destination, '.gitlab-ci.yml'))).toBe(false);
    expect(existsSync(resolve(destination, 'release'))).toBe(false);
    expect(existsSync(resolve(destination, 'scripts/configure-npm-auth.mjs'))).toBe(false);
    expect(existsSync(resolve(destination, 'scripts/release-artifacts.mjs'))).toBe(false);
    expect(existsSync(resolve(destination, 'scripts/macos-portal-credential.js'))).toBe(true);
    expect(existsSync(resolve(destination, 'scripts/windows-confluence-credential.ps1'))).toBe(true);
    expect(existsSync(resolve(destination, 'scripts/windows-portal-credential.ps1'))).toBe(true);
    expect(existsSync(resolve(destination, 'test/ci-contract.test.ts'))).toBe(false);
    expect(existsSync(resolve(destination, 'test/release.test.ts'))).toBe(false);
    expect(existsSync(resolve(destination, 'README.ru.md'))).toBe(false);
    expect(existsSync(resolve(destination, 'standalone/README.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'docs/install/codex.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'docs/install/opencode.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'CONTRIBUTING.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'SECURITY.md'))).toBe(true);
    expect(existsSync(resolve(destination, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(resolve(destination, '.github/ISSUE_TEMPLATE/bug_report.yml'))).toBe(true);
    expect(existsSync(resolve(destination, 'dist'))).toBe(false);
    expect(existsSync(resolve(destination, 'node_modules'))).toBe(false);

    const packageJson = JSON.parse(readFileSync(resolve(destination, 'package.json'), 'utf8'));
    expect(packageJson.name).toBe('mcp-project-context-router');
    expect(packageJson.version).toBe('0.4.0');
    expect(packageJson.scripts['quality:smoke']).toBeUndefined();
    expect(packageJson.scripts['perf:smoke']).toBeUndefined();
    expect(packageJson.scripts['ci:check']).toBeUndefined();
    expect(packageJson.scripts['release:check']).toBeUndefined();
    expect(packageJson.scripts['release:prepare']).toBeUndefined();
    expect(readFileSync(resolve(destination, 'README.md'), 'utf8')).not.toMatch(/Artifactory|corporate registry/i);
    expect(readFileSync(resolve(destination, 'src/version.ts'), 'utf8')).toContain("'0.4.0'");
    expect(readFileSync(resolve(destination, 'scripts/package-smoke.mjs'), 'utf8')).toContain('mcp-project-context-router@0.4.0');
    const packageLock = JSON.parse(readFileSync(resolve(destination, 'package-lock.json'), 'utf8'));
    expect(packageLock.version).toBe('0.4.0');
    expect(packageLock.packages[''].version).toBe('0.4.0');
    const projectYaml = readFileSync(resolve(destination, '.project-context/project.yaml'), 'utf8');
    expect(projectYaml).toContain('name: "Standalone Context Router"');
    expect(projectYaml).toContain('repository: "project-context-export-test-');
    expect(projectYaml).not.toContain('__PROJECT_NAME__');
  });
});
