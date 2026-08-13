import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

type LaunchConfig = {
  command: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
};

type JsonRpcResponse = {
  id?: number;
  result?: Record<string, unknown>;
  error?: unknown;
};

type OpenCodeLocalServer = {
  type: string;
  command: string[];
  cwd?: string;
  environment?: Record<string, string>;
  enabled?: boolean;
  disabled?: boolean;
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const templatesDir = resolve(packageRoot, 'templates/client-configs');
const packageName = 'mcp-project-context-router';
let consumerRoot: string | undefined;

afterEach(() => {
  if (consumerRoot) rmSync(consumerRoot, { recursive: true, force: true });
  consumerRoot = undefined;
});

describe('coding-agent installation configs', () => {
  it('launches the core MCP surface through the Codex and OpenCode templates', async () => {
    consumerRoot = createConsumerRepository();

    const codexTemplate = readFileSync(resolve(templatesDir, 'codex.toml'), 'utf8');
    const stableTemplate = readFileSync(resolve(templatesDir, 'opencode.json'), 'utf8');
    const v2Template = readFileSync(resolve(templatesDir, 'opencode-v2.json'), 'utf8');

    for (const template of [codexTemplate, stableTemplate, v2Template]) {
      expect(template).not.toContain(packageRoot);
      expect(template).toContain(`node_modules/${packageName}/bin/project-context-mcp`);
    }

    mkdirSync(resolve(consumerRoot, '.codex'), { recursive: true });
    writeFileSync(resolve(consumerRoot, '.codex/config.toml'), codexTemplate, 'utf8');
    writeFileSync(resolve(consumerRoot, 'opencode.json'), stableTemplate, 'utf8');
    const codex = readCodexConfig(readFileSync(resolve(consumerRoot, '.codex/config.toml'), 'utf8'));
    const stable = JSON.parse(stableTemplate) as {
      mcp: Record<string, OpenCodeLocalServer>;
    };
    const v2 = JSON.parse(v2Template) as {
      mcp: { servers: Record<string, OpenCodeLocalServer> };
    };

    expect(stable.mcp.project_context.enabled).toBe(true);
    expect(stable.mcp).not.toHaveProperty('servers');
    expect(v2.mcp.servers.project_context).not.toHaveProperty('enabled');
    expect(v2.mcp.servers.project_context).not.toHaveProperty('disabled');

    const launchConfigs = [
      codex,
      readOpenCodeConfig(stable.mcp.project_context),
      readOpenCodeConfig(v2.mcp.servers.project_context),
    ];
    const results = await Promise.all(launchConfigs.map((config) => initializeAndGetBrief(config)));

    for (const responses of results) {
      expect(responseResult(responses, 1).serverInfo).toEqual(expect.objectContaining({
        name: 'project_context',
      }));
      expect(responseResult(responses, 2).tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'get_project_brief' }),
        expect.objectContaining({ name: 'build_context_pack' }),
      ]));
      const brief = responseResult(responses, 3).structuredContent as Record<string, unknown>;
      expect(brief.project).toBe('Install Guide Consumer');
      expect(brief.toolProfile).toBe('core');
    }
  }, 30_000);
});

function createConsumerRepository(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'project-context-install-guide-'));
  execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
  mkdirSync(resolve(root, 'src'), { recursive: true });
  const packageTarget = resolve(root, 'node_modules', packageName);
  mkdirSync(dirname(packageTarget), { recursive: true });
  symlinkSync(packageRoot, packageTarget, process.platform === 'win32' ? 'junction' : 'dir');
  execFileSync(process.execPath, [
    resolve(packageRoot, 'bin/project-context'),
    'init',
    '--name', 'Install Guide Consumer',
    '--module', 'app:src',
  ], { cwd: root, stdio: 'ignore' });
  return root;
}

function readCodexConfig(raw: string): LaunchConfig {
  return {
    command: readTomlString(raw, 'command'),
    args: readTomlStringArray(raw, 'args'),
    cwd: resolve(consumerRoot!, '.codex', readTomlString(raw, 'cwd')),
    environment: { PROJECT_CONTEXT_TOOL_PROFILE: 'core' },
  };
}

function readOpenCodeConfig(server: OpenCodeLocalServer): LaunchConfig {
  expect(server.type).toBe('local');
  const [command, ...args] = server.command;
  return {
    command,
    args,
    cwd: resolve(consumerRoot!, server.cwd ?? '.'),
    environment: server.environment ?? {},
  };
}

function readTomlString(raw: string, key: string): string {
  const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm').exec(raw);
  if (!match) throw new Error(`Missing ${key} in Codex template`);
  return match[1];
}

function readTomlStringArray(raw: string, key: string): string[] {
  const match = new RegExp(`^${key}\\s*=\\s*\\[(.*)]`, 'm').exec(raw);
  if (!match) throw new Error(`Missing ${key} in Codex template`);
  return [...match[1].matchAll(/"([^"]*)"/g)].map((value) => value[1]);
}

function initializeAndGetBrief(config: LaunchConfig): Promise<JsonRpcResponse[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(config.command, config.args, {
      cwd: config.cwd,
      env: { ...process.env, ...config.environment },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const responses: JsonRpcResponse[] = [];
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out waiting for MCP responses. stderr: ${stderr}`));
    }, 15_000);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      let newlineIndex = stdout.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdout.slice(0, newlineIndex).trim();
        stdout = stdout.slice(newlineIndex + 1);
        newlineIndex = stdout.indexOf('\n');
        if (!line) continue;

        const response = JSON.parse(line) as JsonRpcResponse;
        if (response.error) {
          clearTimeout(timeout);
          child.kill();
          reject(new Error(`MCP request failed: ${JSON.stringify(response.error)}`));
          return;
        }
        responses.push(response);
        if (response.id === 1) {
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
        if (response.id === 2) {
          child.stdin.write(`${JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'get_project_brief', arguments: {} },
          })}\n`);
        }
        if ([1, 2, 3].every((id) => responses.some((candidate) => candidate.id === id))) {
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
        reject(new Error(`MCP process exited with code ${code}. stderr: ${stderr}`));
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'install-guide-test', version: '0.0.0' },
      },
    })}\n`);
  });
}

function responseResult(responses: JsonRpcResponse[], id: number): Record<string, unknown> {
  const response = responses.find((candidate) => candidate.id === id);
  if (!response?.result) throw new Error(`Missing MCP response ${id}`);
  return response.result;
}
