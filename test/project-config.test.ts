import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectConfig, writeConfluenceIntegration, writePortalIntegration } from '../src/storage/config.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-config-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('project context config', () => {
  it('reads portable project metadata, routing, modules, and command metadata blocks', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/project.yaml'),
      `project:
  name: Test
  repository: test-repo
  context_version: 2
  timezone: UTC
  purpose: Portable test project
  roles: [Developer]
  flows: [Validate task, Verify work]

routing:
  default_modules: [tools]
  documentation_modules: [docs]

context_router:
  package_path: packages/project-context
  cli_command: project-context
  install_command: npm install
  mcp_server_name: project_context
  resource_scheme: project-context
  codex_config_path: .codex/config.toml
  codex_hooks_path: false
  required_hook_events: []
  git_hooks_path: false
  cache_dependency_files: [packages/project-context/dist/context-pack.js]

modules:
  tools:
    path: tools/ppm-context
    stack: TypeScript
    playbooks: [AGENTS.md, tools/ppm-context/README.md]
    aliases: [router, mcp]
    source_globs: ["tools/ppm-context/src/**/*.ts"]

commands:
  context_lint: tools/ppm-context/bin/ppm-context lint
  tools_tests:
    run: npm --prefix tools/ppm-context run test
    context_pack: true
    required_for: [tools, doc]
    timeout_seconds: 120
    network: false
    writes_to: [coverage]
    ci_equivalent: ppm-context-test
retention:
  completed_tasks:
    archive_after_days: 90
specifications:
  current:
    include_in_context_pack: true
    modules: [tools]
    files: [doc/specification/current.md]
    runbook: .project-context/active/runbooks/current.md
integrations:
  portal:
    schema_version: 2
    base_url: https://portal.example.test
    project_id: 00000000-0000-4000-8000-000000000001
    project_key: TEST-PORTAL
    project_name: Test Portal Project
    cache_path: .project-context/indexes/portal
    credential_ref: native:project-context-hub/PROJECT_CONTEXT_HUB_TOKEN
  confluence:
    schema_version: 1
    base_url: https://help.severstal.com
    root_page_id: "123456"
    root_page_url: https://help.severstal.com/pages/viewpage.action?pageId=123456
    write_scope: root-and-descendants
    include_root: true
    credential_ref: native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN
`,
      'utf8',
    );

    const config = loadProjectConfig();

    expect(config.project).toEqual({
      name: 'Test',
      repository: 'test-repo',
      contextVersion: 2,
      timezone: 'UTC',
      purpose: 'Portable test project',
      roles: ['Developer'],
      flows: ['Validate task', 'Verify work'],
    });
    expect(config.modules.tools).toEqual({
      path: 'tools/ppm-context',
      stack: 'TypeScript',
      playbooks: ['AGENTS.md', 'tools/ppm-context/README.md'],
      aliases: ['router', 'mcp'],
      sourceGlobs: ['tools/ppm-context/src/**/*.ts'],
    });
    expect(config.routing).toEqual({ defaultModules: ['tools'], documentationModules: ['docs'] });
    expect(config.contextRouter).toEqual({
      packagePath: 'packages/project-context',
      cliCommand: 'project-context',
      installCommand: 'npm install',
      mcpServerName: 'project_context',
      resourceScheme: 'project-context',
      codexConfigPath: '.codex/config.toml',
      codexHooksPath: undefined,
      requiredHookEvents: [],
      gitHooksPath: undefined,
      gitHooksInstallCommand: undefined,
      cacheDependencyFiles: ['packages/project-context/dist/context-pack.js'],
      brand: {
        name: 'Project Context Router',
        shortName: 'Project Context',
        marker: 'PROJECT_CONTEXT',
        logoText: '[Project Context]',
        description: 'local-first project memory, backlog, and verification router',
      },
    });
    expect(config.commands.context_lint).toBe('tools/ppm-context/bin/ppm-context lint');
    expect(config.commands.tools_tests).toBe('npm --prefix tools/ppm-context run test');
    expect(config.commandMetadata.context_lint).toEqual({
      run: 'tools/ppm-context/bin/ppm-context lint',
      requiredFor: [],
      writesTo: [],
    });
    expect(config.commandMetadata.tools_tests).toEqual({
      run: 'npm --prefix tools/ppm-context run test',
      requiredFor: ['tools', 'doc'],
      timeoutSeconds: 120,
      network: false,
      writesTo: ['coverage'],
      ciEquivalent: 'ppm-context-test',
      includeInContextPack: true,
    });
    expect(config.retention.completed_tasks.archive_after_days).toBe(90);
    expect(config.specifications.current).toEqual({
      includeInContextPack: true,
      files: ['doc/specification/current.md'],
      runbook: '.project-context/active/runbooks/current.md',
      modules: ['tools'],
    });
    expect(config.integrations.confluence).toEqual({
      schemaVersion: 1,
      baseUrl: 'https://help.severstal.com',
      rootPageId: '123456',
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      writeScope: 'root-and-descendants',
      includeRoot: true,
      credentialRef: 'native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN',
    });
    expect(config.integrations.portal).toEqual({
      schemaVersion: 2,
      baseUrl: 'https://portal.example.test',
      projectId: '00000000-0000-4000-8000-000000000001',
      projectKey: 'TEST-PORTAL',
      projectName: 'Test Portal Project',
      cachePath: '.project-context/indexes/portal',
      credentialRef: 'native:project-context-hub/PROJECT_CONTEXT_HUB_TOKEN',
    });
  });

  it('keeps older minimal project configs readable with neutral defaults', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/project.yaml'),
      `project:
  name: Legacy
modules:
  app:
    path: src
    playbooks: []
commands: {}
`,
      'utf8',
    );

    const config = loadProjectConfig();

    expect(config.project.name).toBe('Legacy');
    expect(config.modules.app).toEqual({
      path: 'src',
      stack: undefined,
      playbooks: [],
      aliases: [],
      sourceGlobs: [],
    });
    expect(config.contextRouter.cliCommand).toBe('project-context');
    expect(config.contextRouter.mcpServerName).toBe('project_context');
    expect(config.routing).toEqual({ defaultModules: [], documentationModules: [] });
    expect(config.integrations).toEqual({});
  });

  it('writes only non-secret project-scoped Confluence binding data', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/project.yaml'),
      `project:
  name: Binding test
modules: {}
commands: {}
`,
      'utf8',
    );

    writeConfluenceIntegration({
      schemaVersion: 1,
      baseUrl: 'https://help.severstal.com',
      rootPageId: '123456',
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      writeScope: 'root-and-descendants',
      includeRoot: true,
      credentialRef: 'native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN',
    });

    const raw = readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8');
    expect(raw).toContain('root_page_id:');
    expect(raw).toContain('credential_ref:');
    expect(raw).not.toContain('DUMMY_PAT');
    expect(loadProjectConfig().integrations.confluence?.rootPageId).toBe('123456');
  });

  it('writes only non-secret project-scoped Portal binding data', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/project.yaml'),
      `project:
  name: Portal binding test
modules: {}
commands: {}
`,
      'utf8',
    );

    writePortalIntegration({
      schemaVersion: 2,
      baseUrl: 'https://portal.example.test',
      projectId: '00000000-0000-4000-8000-000000000001',
      projectKey: 'PORTAL-BINDING',
      projectName: 'Portal binding test',
      cachePath: '.project-context/indexes/portal',
      credentialRef: 'native:project-context-hub/PROJECT_CONTEXT_HUB_TOKEN',
    });

    const raw = readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8');
    expect(raw).toContain('project_id:');
    expect(raw).toContain('project_key: PORTAL-BINDING');
    expect(raw).toContain('project_name: Portal binding test');
    expect(raw).toContain('cache_path:');
    expect(raw).not.toContain('DUMMY_TOKEN');
    expect(loadProjectConfig().integrations.portal?.projectId)
      .toBe('00000000-0000-4000-8000-000000000001');
  });
});
