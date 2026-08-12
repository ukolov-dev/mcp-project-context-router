import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { coreToolNames, type McpToolProfile } from '../src/mcp/tool-profiles.js';
import { loadProjectConfig } from '../src/storage/config.js';

type McpConfig = {
  command: string;
  args: string[];
  cwd: string;
};

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
};

type McpTool = {
  name: string;
  execution?: unknown;
  outputSchema?: Record<string, unknown>;
};

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(testDir, '..');
const repoRoot = findRepositoryRoot();
const configDir = resolve(repoRoot, '.codex');
const configPath = resolve(configDir, 'config.toml');
const projectConfig = loadProjectConfig();
const serverName = projectConfig.contextRouter.mcpServerName;
const packageVersion = (JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as { version: string }).version;

function findRepositoryRoot(): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return packageRoot;
  }
}

describe('Codex project-context MCP launch config', () => {
  it('starts the configured server and keeps the indexed project config portable', async () => {
    const config = readProjectContextConfig(readFileSync(configPath, 'utf8'));
    const indexedConfig = readProjectContextConfig(readIndexedConfig());

    expectConfigNotMachineSpecific(indexedConfig);
    if (configContainsRepoRoot(config)) {
      expect(isSkipWorktreeConfig()).toBe(true);
    }

    const responses = await initializeAndListTools(config, 'core', 'get_project_brief');
    const result = responseResult(responses, 1);

    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo).toEqual({ name: serverName, version: packageVersion });

    const toolsResult = responseResult(responses, 2);
    const tools = toolsResult.tools as McpTool[];
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toEqual([...coreToolNames]);
    expect(toolNames).not.toContain('search_project_context');
    expect(toolNames).not.toContain('archive_records');
    expect(tools.every((tool) => !Object.hasOwn(tool, 'execution'))).toBe(true);
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);

    const callResult = responseResult(responses, 3);
    const structuredContent = callResult.structuredContent as Record<string, unknown>;
    const content = callResult.content as Array<{ type: string; text: string }>;
    expect(structuredContent.brand).toEqual(expect.objectContaining({ name: projectConfig.contextRouter.brand.name }));
    expect(structuredContent.toolProfile).toBe('core');
    expect(JSON.parse(content[0]?.text ?? '{}')).toEqual(structuredContent);
  });

  it('exposes the complete compatibility surface only in the full profile', async () => {
    const config = readProjectContextConfig(readFileSync(configPath, 'utf8'));
    const responses = await initializeAndListTools(config, 'full');
    const tools = responseResult(responses, 2).tools as McpTool[];
    const toolNames = tools.map((tool) => tool.name);

    expect(toolNames).toHaveLength(53);
    expect(toolNames).toContain('retrieve_project_context');
    expect(toolNames).toContain('search_project_context');
    expect(toolNames).toContain('promote_drafts_batch');
    expect(toolNames).toContain('archive_records');
    expect(toolNames).toContain('plan_confluence_publish');
    expect(toolNames).toContain('apply_confluence_publish');
    expect(tools.every((tool) => tool.outputSchema?.type === 'object')).toBe(true);
  });

  it('selects the analyst and admin surfaces in the running MCP server', async () => {
    const config = readProjectContextConfig(readFileSync(configPath, 'utf8'));
    const [analystResponses, developerResponses, adminResponses] = await Promise.all([
      initializeAndListTools(config, 'analyst'),
      initializeAndListTools(config, 'developer'),
      initializeAndListTools(config, 'admin'),
    ]);
    const analystTools = (responseResult(analystResponses, 2).tools as McpTool[]).map((tool) => tool.name);
    const developerTools = (responseResult(developerResponses, 2).tools as McpTool[]).map((tool) => tool.name);
    const adminTools = (responseResult(adminResponses, 2).tools as McpTool[]).map((tool) => tool.name);

    expect(analystTools).toContain('search_project_context');
    expect(analystTools).toContain('find_requirements');
    expect(analystTools).toContain('plan_confluence_publish');
    expect(analystTools).toContain('apply_confluence_publish');
    expect(analystTools).not.toContain('archive_records');
    expect(developerTools).toContain('get_shared_project_snapshot');
    expect(developerTools).toContain('accept_assigned_work');
    expect(developerTools).toContain('submit_implementation_report');
    expect(developerTools).not.toContain('apply_confluence_publish');
    expect(developerTools).not.toContain('archive_records');
    expect(adminTools).toContain('get_backlog');
    expect(adminTools).toContain('archive_records');
    expect(adminTools).not.toContain('search_project_context');
  }, 20_000);
});

function readProjectContextConfig(raw: string): McpConfig {
  const escapedName = serverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const sectionMatch = new RegExp(`\\[mcp_servers\\.${escapedName}]\\n(?<body>[\\s\\S]*?)(?:\\n\\[|$)`).exec(raw);
  if (!sectionMatch?.groups?.body) {
    throw new Error(`Missing [mcp_servers.${serverName}] section`);
  }

  const body = sectionMatch.groups.body;
  const command = readStringField(body, 'command');
  const cwd = readStringField(body, 'cwd');
  const args = readStringArrayField(body, 'args');

  return { command, args, cwd };
}

function readIndexedConfig(): string {
  try {
    return execFileSync('git', ['show', ':.codex/config.toml'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return readFileSync(configPath, 'utf8');
  }
}

function expectConfigNotMachineSpecific(config: McpConfig): void {
  expect(configContainsRepoRoot(config)).toBe(false);
}

function configContainsRepoRoot(config: McpConfig): boolean {
  return config.command.includes(repoRoot)
    || config.cwd.includes(repoRoot)
    || config.args.some((arg) => arg.includes(repoRoot));
}

function isSkipWorktreeConfig(): boolean {
  try {
    const output = execFileSync('git', ['ls-files', '-v', '--', '.codex/config.toml'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return output.trimStart().startsWith('S ');
  } catch {
    return false;
  }
}

function readStringField(body: string, key: string): string {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(body);
  if (!match) {
    throw new Error(`Missing ${key} in ${serverName} MCP config`);
  }
  return match[1];
}

function readStringArrayField(body: string, key: string): string[] {
  const match = new RegExp(`^${key}\\s*=\\s*\\[(.*)]`, 'm').exec(body);
  if (!match) {
    throw new Error(`Missing ${key} in ${serverName} MCP config`);
  }
  const values = match[1].match(/"([^"]*)"/g) ?? [];
  return values.map((value) => value.slice(1, -1));
}

function initializeAndListTools(config: McpConfig, profile: McpToolProfile, callToolName?: string): Promise<JsonRpcResponse[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.command, config.args, {
      cwd: resolve(configDir, config.cwd),
      env: { ...process.env, PPM_CONTEXT_TOOL_PROFILE: profile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';
    let toolListRequested = false;
    let toolCallRequested = false;
    const responses: JsonRpcResponse[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for MCP initialize/tools response. stderr: ${stderr}`));
    }, 10_000);

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');

      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');

        if (!line) {
          continue;
        }

        const message = JSON.parse(line) as JsonRpcResponse;
        if (message.error) {
          clearTimeout(timeout);
          child.kill();
          reject(new Error(`MCP request failed: ${JSON.stringify(message.error)}`));
          return;
        }

        responses.push(message);
        if (message.id === 1 && !toolListRequested) {
          toolListRequested = true;
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            method: 'notifications/initialized',
            params: {},
          })}\n`);
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          })}\n`);
        }

        if (message.id === 2 && callToolName && !toolCallRequested) {
          toolCallRequested = true;
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: callToolName, arguments: {} },
          })}\n`);
        }

        const expectedIds = callToolName ? [1, 2, 3] : [1, 2];
        if (expectedIds.every((id) => responses.some((response) => response.id === id))) {
          clearTimeout(timeout);
          child.kill();
          resolvePromise(responses);
          return;
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('exit', (code) => {
      if (responses.length === 0) {
        clearTimeout(timeout);
        reject(new Error(`MCP process exited before initialize response with code ${code}. stderr: ${stderr}`));
      }
    });

    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'project-context-vitest', version: '0.0.0' },
      },
    })}\n`);
  });
}

function responseResult(responses: JsonRpcResponse[], id: number): Record<string, unknown> {
  const response = responses.find((candidate) => candidate.id === id);
  if (!response?.result) {
    throw new Error(`Missing MCP response result for id ${id}`);
  }
  return response.result;
}
