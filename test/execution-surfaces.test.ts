import { execFileSync, execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { executionToolNames } from '../src/mcp/tool-profiles.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const taskId = 'TASK-20260915-120000-001';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function cli(root: string, ...args: string[]): any {
  return JSON.parse(execFileSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), ...args, '--json'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  }));
}

function fixture(): string {
  const root = mkdtempSync(resolve(tmpdir(), 'context-execution-surfaces-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  cli(root, 'init', '--name', 'Execution Consumer', '--module', 'app:src');
  mkdirSync(resolve(root, 'src'), { recursive: true });
  writeFileSync(resolve(root, 'src/value.js'), 'export const value = 1;\n');
  const router = `node "${resolve(packageRoot, 'bin/project-context')}"`;
  writeFileSync(resolve(root, '.project-context/project.yaml'), `project:\n  name: Execution Consumer\nmodules:\n  app:\n    path: src\ncommands:\n  context_lint: ${JSON.stringify(`${router} lint`)}\n  context_index: ${JSON.stringify(`${router} index`)}\n`);
  writeFileSync(resolve(root, '.project-context/drafts/contract.json'), JSON.stringify({
    goal: 'Return the requested value', scope: ['src/value.js'], modules: ['app'],
    acceptanceCriteria: ['The exported value is 2'], testExpectations: ['node --version'],
  }));
  cli(root, 'confirm-task', taskId, '--input', '.project-context/drafts/contract.json');
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Execution Test', '-c', 'user.email=execution@example.invalid', 'commit', '-qm', 'fixture'], { cwd: root });
  return root;
}

describe('execution CLI and MCP surfaces', () => {
  it('keeps runner planning read-only and returns a nonzero exit on process failure', () => {
    const root = fixture();
    const adapter = {
      executor: 'implementation-session', reviewer: 'review-session',
      implementation: { command: 'nonexistent-context-test-executor', args: [] },
      review: { command: 'nonexistent-context-test-reviewer', args: [] }, timeoutMs: 1000,
    };
    writeFileSync(resolve(root, 'adapter.json'), JSON.stringify(adapter));
    const before = cli(root, 'agent-runs', taskId);
    expect(cli(root, 'run', taskId, '--adapter', 'adapter.json').dryRun).toBe(true);
    expect(cli(root, 'agent-runs', taskId)).toEqual(before);
    const result = spawnSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), 'run', taskId,
      '--adapter', 'adapter.json', '--execute', '--json'], { cwd: root, encoding: 'utf8', timeout: 20_000 });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout).status).toBe('FAILED');
    const { runs } = cli(root, 'agent-runs', taskId);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('failed');
  }, 30_000);

  it('performs the complete evidence and acceptance lifecycle through MCP with CLI readback', async () => {
    const root = fixture();
    const transport = new StdioClientTransport({
      command: process.execPath, args: [resolve(packageRoot, 'bin/project-context-mcp')], cwd: root,
      env: { ...process.env, PROJECT_CONTEXT_TOOL_PROFILE: 'developer' } as Record<string, string>, stderr: 'pipe',
    });
    const client = new Client({ name: 'execution-integration', version: '1.0.0' });
    try {
      await client.connect(transport);
      const names = (await client.listTools()).tools.map(tool => tool.name);
      expect(names).toEqual(expect.arrayContaining([...executionToolNames]));
      expect(names).not.toContain('run_task');
      const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
        const result = await client.callTool({ name, arguments: args });
        if (result.isError) throw new Error(JSON.stringify(result.content));
        return result.structuredContent;
      };
      const run = await call('create_agent_run', { taskId, executor: 'implementation-session' });
      await call('transition_agent_run', { runId: run.id, status: 'implementing' });
      writeFileSync(resolve(root, 'src/value.js'), 'export const value = 2;\n');
      await call('transition_agent_run', { runId: run.id, status: 'verifying' });
      cli(root, 'index');
      const snapshot = await call('get_agent_run_snapshot', { runId: run.id });
      const checks = run.requiredChecks.map((command: string) => {
        execSync(command, { cwd: root, stdio: 'pipe', timeout: 10_000 });
        return { command, status: 'passed' };
      });
      const evidence = await call('record_run_verification', {
        runId: run.id, expectedCodeDigest: snapshot.codeDigest, summary: 'Version check executed',
        checks,
      });
      const premature = await client.callTool({ name: 'transition_agent_run', arguments: { runId: run.id, status: 'ready_to_merge' } });
      expect(premature.isError).toBe(true);
      await call('transition_agent_run', { runId: run.id, status: 'reviewing', evidenceIds: [evidence.id] });
      const bundle = await call('build_acceptance_review_bundle', { runId: run.id });
      expect(JSON.stringify(bundle)).toContain('The exported value is 2');
      const review = await call('record_acceptance_review', {
        runId: run.id, reviewer: 'review-session', taskDigest: snapshot.taskDigest, codeDigest: snapshot.codeDigest,
        verdict: 'passed', evidenceIds: [evidence.id], findings: [],
        criteria: [{ criterionId: 'AC-1', status: 'passed', implementationEvidence: 'src/value.js exports value 2',
          verificationEvidence: `${evidence.id}: node --version passed; src/value.js inspected` }],
      });
      const ready = await call('transition_agent_run', { runId: run.id, status: 'ready_to_merge', reviewId: review.id });
      expect(ready.status).toBe('ready_to_merge');
      expect(cli(root, 'agent-run', run.id).status).toBe('ready_to_merge');
      expect(cli(root, 'acceptance-review', review.id).verdict).toBe('passed');
      expect(existsSync(resolve(root, '.project-context/active/agent-runs', `${run.id}.md`))).toBe(true);
      expect(readFileSync(resolve(root, '.project-context/active/agent-runs', `${run.id}.md`), 'utf8')).not.toContain(root);
      expect(cli(root, 'lint').errors).toEqual([]);
    } finally {
      await client.close();
      await transport.close();
    }
  }, 30_000);
});
