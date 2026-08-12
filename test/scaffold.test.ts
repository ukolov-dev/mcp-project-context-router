import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initializeProjectContext, parseModuleSeed } from '../src/scaffold/init.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-scaffold-test-'));
  mkdirSync(resolve(tempDir, '.git'));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('project-context scaffold', () => {
  it('creates an idempotent generic configuration and workflow templates', () => {
    const result = initializeProjectContext({
      name: 'Example Workspace',
      modules: [parseModuleSeed('api:services/api'), parseModuleSeed('docs:handbook')],
    });

    expect(result.status).toBe('OK');
    expect(result.created).toContain('.project-context/project.yaml');
    expect(result.created).toContain('.project-context/templates/TASK-CONTRACT.md');
    const projectYaml = readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8');
    expect(projectYaml).toContain('name: "Example Workspace"');
    expect(projectYaml).toContain('default_modules: ["api"]');
    expect(projectYaml).toContain('documentation_modules: ["docs"]');
    expect(projectYaml).toContain('path: "services/api"');
    expect(projectYaml).not.toContain('PPM_CONTEXT');
    expect(readFileSync(resolve(tempDir, '.gitignore'), 'utf8')).toContain('.project-context/indexes/');

    const second = initializeProjectContext({ name: 'Ignored Name' });
    expect(second.skipped).toContain('.project-context/project.yaml');
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8')).toContain('Example Workspace');
  });

  it('rejects unsafe or malformed module definitions', () => {
    expect(() => parseModuleSeed('missing-path')).toThrow('Expected name:path');
    expect(() => parseModuleSeed('API:services/api')).toThrow('Invalid module name');
    expect(() => parseModuleSeed('api:../outside')).toThrow('repository-relative path');
  });
});
