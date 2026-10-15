import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
    expect(existsSync(resolve(tempDir, '.agents'))).toBe(false);
    expect(existsSync(resolve(tempDir, '.codex'))).toBe(false);
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

  it('installs both bundled skills on request and preserves customized files', () => {
    const result = initializeProjectContext({ withSkills: true });
    for (const name of ['project-context-workflow', 'context-research']) {
      const relative = `.agents/skills/${name}/SKILL.md`;
      expect(result.created).toContain(relative);
      expect(readFileSync(resolve(tempDir, relative), 'utf8')).toContain(`name: ${name}`);
    }
    const workflow = '.agents/skills/project-context-workflow/SKILL.md';
    writeFileSync(resolve(tempDir, workflow), 'Customized workflow', 'utf8');
    const repeated = initializeProjectContext({ withSkills: true });
    expect(repeated.created).toEqual([]);
    expect(repeated.skipped).toContain(workflow);
    expect(readFileSync(resolve(tempDir, workflow), 'utf8')).toBe('Customized workflow');
  });

  it('can add skills to an existing initialized project without replacing its configuration', () => {
    initializeProjectContext({ name: 'Existing project' });
    const result = initializeProjectContext({ name: 'Ignored name', withSkills: true });
    expect(result.created).toHaveLength(2);
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8')).toContain('Existing project');
  });

  it('refuses a skill directory that redirects writes outside the repository', () => {
    const external = mkdtempSync(resolve(tmpdir(), 'router-skills-external-'));
    try {
      symlinkSync(external, resolve(tempDir, '.agents'), 'junction');
      expect(() => initializeProjectContext({ withSkills: true })).toThrow('must stay inside the repository');
      expect(existsSync(resolve(external, 'skills'))).toBe(false);
      expect(existsSync(resolve(tempDir, '.project-context'))).toBe(false);
    } finally { rmSync(external, { recursive: true, force: true }); }
  });

  it('leaves an existing dangling skill symlink untouched', () => {
    const directory = resolve(tempDir, '.agents/skills/project-context-workflow');
    mkdirSync(directory, { recursive: true });
    symlinkSync(resolve(tempDir, 'missing-user-skill.md'), resolve(directory, 'SKILL.md'));
    const result = initializeProjectContext({ withSkills: true });
    expect(result.skipped).toContain('.agents/skills/project-context-workflow/SKILL.md');
    expect(existsSync(resolve(tempDir, 'missing-user-skill.md'))).toBe(false);
    expect(result.created).toContain('.agents/skills/context-research/SKILL.md');
  });

  it('installs optional lifecycle hooks together with skills and registers fresh config diagnostics', () => {
    const result = initializeProjectContext({ withHooks: true, withSkills: true });
    expect(result.created).toContain('.codex/hooks.json');
    const config = JSON.parse(readFileSync(resolve(tempDir, '.codex/hooks.json'), 'utf8'));
    expect(Object.keys(config.hooks)).toEqual(['UserPromptSubmit', 'PostToolUse', 'Stop']);
    expect(config.hooks.Stop[0].hooks[0].command).toContain('node_modules/mcp-project-context-router/hooks/stop-capture.js');
    expect(config.hooks.Stop[0].hooks[0].commandWindows).toContain('Join-Path');
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8')).toContain('required_hook_events: [UserPromptSubmit, PostToolUse, Stop]');
    writeFileSync(resolve(tempDir, '.codex/hooks.json'), '{"custom": true}');
    expect(initializeProjectContext({ withHooks: true }).skipped).toContain('.codex/hooks.json');
    expect(readFileSync(resolve(tempDir, '.codex/hooks.json'), 'utf8')).toBe('{"custom": true}');
  });

  it('adds hooks later without replacing project configuration', () => {
    initializeProjectContext();
    const before = readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8');
    expect(initializeProjectContext({ withHooks: true }).created).toContain('.codex/hooks.json');
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8')).toBe(before);
  });

  it('refuses escaping hook destinations before creating project files', () => {
    const external = mkdtempSync(resolve(tmpdir(), 'router-hooks-external-'));
    try {
      symlinkSync(external, resolve(tempDir, '.codex'), 'junction');
      expect(() => initializeProjectContext({ withHooks: true })).toThrow('must stay inside the repository');
      expect(existsSync(resolve(external, 'hooks.json'))).toBe(false);
      expect(existsSync(resolve(tempDir, '.project-context'))).toBe(false);
    } finally { rmSync(external, { recursive: true, force: true }); }
  });

  it('preserves an existing dangling hooks file symlink', () => {
    mkdirSync(resolve(tempDir, '.codex'));
    symlinkSync(resolve(tempDir, 'missing-hooks.json'), resolve(tempDir, '.codex/hooks.json'));
    expect(initializeProjectContext({ withHooks: true }).skipped).toContain('.codex/hooks.json');
    expect(existsSync(resolve(tempDir, 'missing-hooks.json'))).toBe(false);
  });

  it('rejects unsafe or malformed module definitions', () => {
    expect(() => parseModuleSeed('missing-path')).toThrow('Expected name:path');
    expect(() => parseModuleSeed('API:services/api')).toThrow('Invalid module name');
    expect(() => parseModuleSeed('api:../outside')).toThrow('repository-relative path');
  });
});
