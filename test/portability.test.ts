import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { discoverCapabilities, isCapabilitySourcePath } from '../src/indexer/capabilities.js';
import { rebuildIndex } from '../src/indexer/sqlite.js';
import { getProjectSnapshot } from '../src/project-snapshot/snapshot.js';
import { loadProjectConfig } from '../src/storage/config.js';
import { inferModulesFromPath, inferModulesFromQuery } from '../src/storage/inference.js';
import { projectContextVersion } from '../src/version.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, '..');
const requireFromPackage = createRequire(import.meta.url);
const integrationTestTimeout = 30_000;

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-portability-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.git'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  mkdirSync(resolve(tempDir, 'services/api/src'), { recursive: true });
  mkdirSync(resolve(tempDir, 'apps/web/src'), { recursive: true });
  mkdirSync(resolve(tempDir, 'handbook'), { recursive: true });
  writeFileSync(resolve(tempDir, 'AGENTS.md'), '# Acme agent rules\n', 'utf8');
  writeFileSync(resolve(tempDir, 'services/api/src/CustomerService.java'), 'public class CustomerService {}\n', 'utf8');
  writeFileSync(resolve(tempDir, 'apps/web/src/CustomerPanel.tsx'), 'export function CustomerPanel() { return null; }\n', 'utf8');
  writeFileSync(resolve(tempDir, 'handbook/testing.md'), '# Testing\n\nRun focused tests.\n', 'utf8');
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Acme Workbench
  repository: acme-workbench
  context_version: 1
  timezone: UTC
  purpose: Coordinate customer operations.
  roles: [Operator, Developer]
  flows: [Validate task, Build context pack, finalize work]
routing:
  default_modules: [web]
  documentation_modules: [docs]
context_router:
  cli_command: project-context
  mcp_server_name: project_context
  resource_scheme: project-context
  codex_config_path: false
  codex_hooks_path: false
  git_hooks_path: false
modules:
  api:
    path: services/api
    aliases: [api, server, java]
    source_globs: ["services/api/src/**/*.java"]
    playbooks: [AGENTS.md]
  web:
    path: apps/web
    aliases: [web, react, screen, panel]
    source_globs: ["apps/web/src/**/*.{ts,tsx}"]
    playbooks: [AGENTS.md]
  docs:
    path: handbook
    aliases: [docs, handbook, documentation]
    source_globs: ["handbook/**/*.md"]
    playbooks: [AGENTS.md]
commands:
  api_tests:
    run: npm --prefix services/api test
    context_pack: true
    required_for: [api]
    writes_to: []
  web_tests:
    run: npm --prefix apps/web test
    context_pack: true
    required_for: [web]
    writes_to: []
`, 'utf8');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('portable non-PPM repository', () => {
  it('drives metadata, module routing, capability discovery, and context packs from project.yaml', () => {
    const config = loadProjectConfig();

    expect(config.project.name).toBe('Acme Workbench');
    expect(inferModulesFromPath('apps/web/src/CustomerPanel.tsx')).toEqual(['web']);
    expect(inferModulesFromQuery('Update the React customer panel')).toEqual(['web']);
    expect(inferModulesFromQuery('Change the Java customer API')).toEqual(['api']);
    expect(isCapabilitySourcePath('apps/web/src/CustomerPanel.tsx')).toBe(true);
    expect(isCapabilitySourcePath('apps/web/public/logo.svg')).toBe(false);

    const discovered = discoverCapabilities();
    expect(discovered.capabilities).toContainEqual(expect.objectContaining({
      name: 'CustomerPanel',
      module: 'web',
      filePath: 'apps/web/src/CustomerPanel.tsx',
    }));
    expect(discovered.capabilities).toContainEqual(expect.objectContaining({
      name: 'CustomerService',
      module: 'api',
      filePath: 'services/api/src/CustomerService.java',
    }));

    rebuildIndex();
    const pack = buildContextPack({ query: 'Update the React customer panel' });
    expect(pack.summary).toContain('(web)');
    expect(pack.files.map((file) => file.path)).toContain('apps/web/src/CustomerPanel.tsx');
    expect(pack.commands).toEqual(['npm --prefix apps/web test']);
    expect(pack.playbooks).toEqual(['AGENTS.md']);

    const snapshot = getProjectSnapshot({ includeDirty: false, includeBacklog: false });
    expect(snapshot.project).toEqual(expect.objectContaining({
      name: 'Acme Workbench',
      purpose: 'Coordinate customer operations.',
    }));
    expect(snapshot.brand).toEqual(expect.objectContaining({ marker: 'PROJECT_CONTEXT', logoText: '[Project Context]' }));
    expect(snapshot.roles).toEqual(['Operator', 'Developer']);
    expect(snapshot.modules).toContainEqual({ name: 'web', path: 'apps/web' });
    expect(snapshot.contextRouter.failures).toEqual([]);
  });

  it('uses configured project identity in CLI and MCP brief output', () => {
    const cli = spawnSync(resolve(packageRoot, 'bin/ppm-context'), ['brief', '--json'], {
      cwd: tempDir,
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(cli.status, cli.stderr).toBe(0);
    expect(JSON.parse(cli.stdout)).toEqual(expect.objectContaining({ project: 'Acme Workbench' }));

    const responses = runMcpBrief();
    expect(responses.find((response) => response.id === 1)?.result).toEqual(expect.objectContaining({
      serverInfo: { name: 'project_context', version: projectContextVersion },
    }));
    const brief = responses.find((response) => response.id === 2)?.result as Record<string, unknown>;
    expect(brief.structuredContent).toEqual(expect.objectContaining({
      project: 'Acme Workbench',
      brand: expect.objectContaining({ marker: 'PROJECT_CONTEXT' }),
    }));
  }, integrationTestTimeout);
});

function runMcpBrief(): Array<{ id?: number; result?: Record<string, unknown>; error?: unknown }> {
  const tsxLoader = requireFromPackage.resolve('tsx');
  const input = [
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'portability-test', version: '1.0.0' },
      },
    }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_project_brief', arguments: {} },
    }),
    '',
  ].join('\n');
  const result = spawnSync(process.execPath, ['--import', tsxLoader, resolve(packageRoot, 'src/mcp/server.ts')], {
    cwd: tempDir,
    input,
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, PPM_CONTEXT_TOOL_PROFILE: 'core' },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: unknown });
}
