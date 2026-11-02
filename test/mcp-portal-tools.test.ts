import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';
import { sha256 } from '../src/portal/client.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const portalReads = ['get_shared_project_snapshot', 'get_exact_shared_snapshot', 'get_assigned_work', 'get_handoff_bundle'];
const projectId = '00000000-0000-4000-8000-000000000001';

it.each([
  { profile: 'default', binding: 'none' },
  { profile: 'core', binding: 'none' },
  { profile: 'core', binding: 'incomplete' },
  { profile: 'full', binding: 'none' },
  { profile: 'default', binding: 'complete' },
  { profile: 'core', binding: 'complete' },
  { profile: 'full', binding: 'complete' },
])('advertises usable Portal reads for $profile with $binding binding', async ({ profile, binding }) => {
  const root = mkdtempSync(resolve(tmpdir(), 'mcp-portal-tools-'));
  const client = new Client({ name: 'portal-tools-test', version: '1' });
  try {
    mkdirSync(resolve(root, '.git'));
    mkdirSync(resolve(root, '.project-context'));
    const portalConfig = binding === 'none' ? '' : `integrations:
  portal:
    base_url: https://portal.example.test
    project_id: ${projectId}
${binding === 'complete' ? '    project_key: TEST\n    project_name: Test\n' : ''}`;
    writeFileSync(resolve(root, '.project-context/project.yaml'), `project:\n  name: Portal tools\nmodules: {}\ncommands: {}\n${portalConfig}`);
    if (binding === 'complete') {
      mkdirSync(resolve(root, '.project-context/indexes/portal'), { recursive: true });
      writeFileSync(resolve(root, `.project-context/indexes/portal/${projectId}.verified-snapshot.json`), JSON.stringify({
        schemaVersion: 1, authority: 'portal', baseUrl: 'https://portal.example.test', projectId,
        verifiedAt: '2026-11-02T12:00:00Z', snapshot: {
          id: '00000000-0000-4000-8000-000000000002', projectId, digest: sha256(''),
          createdBy: 'test', createdAt: '2026-11-02T12:00:00Z', entries: [], documents: [],
        },
      }));
    }
    const env = { ...process.env };
    delete env.PROJECT_CONTEXT_TOOL_PROFILE;
    delete env.PPM_CONTEXT_TOOL_PROFILE;
    if (profile !== 'default') env.PROJECT_CONTEXT_TOOL_PROFILE = profile;
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [resolve(packageRoot, 'bin/project-context-mcp')],
      cwd: root, env: env as Record<string, string>, stderr: 'pipe',
    }));

    const { tools } = await client.listTools();
    const visible = binding === 'complete' || profile === 'full';
    expect(tools.filter(tool => portalReads.includes(tool.name)).map(tool => tool.name)).toEqual(visible ? portalReads : []);
    expect(tools.some(tool => tool.name === 'get_portal_sync_status')).toBe(true);
    const status = await client.callTool({ name: 'get_portal_sync_status', arguments: {} });
    expect(status.isError).not.toBe(true);
    expect(status.structuredContent?.configured).toBe(binding !== 'none');

    const snapshot = await client.callTool({ name: 'get_shared_project_snapshot', arguments: { offline: true } });
    if (binding === 'complete') {
      expect(snapshot.isError).not.toBe(true);
      expect(snapshot.structuredContent?.projectId).toBe(projectId);
      expect(snapshot.structuredContent?.freshness).toMatchObject({ source: 'verified-cache', state: 'stale' });
    } else {
      expect(snapshot.isError).toBe(true);
      expect(JSON.stringify(snapshot)).toContain(visible ? 'not bound' : 'disabled');
    }
    const backlog = await client.readResource({ uri: 'project-context://backlog' });
    expect(JSON.parse((backlog.contents[0] as { text: string }).text)).toMatchObject({ items: [], count: 0 });
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});
