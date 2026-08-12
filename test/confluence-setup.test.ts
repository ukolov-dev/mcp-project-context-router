import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfluenceClient, type ConfluencePage } from '../src/confluence/client.js';
import {
  authenticateConfluence,
  bindConfluenceRoot,
  confluenceDoctor,
  setupConfluence,
} from '../src/confluence/setup.js';
import { loadProjectConfig } from '../src/storage/config.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'vincenzo-confluence-setup-'));
  mkdirSync(resolve(tempDir, '.git'));
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), 'project:\n  name: Test\nmodules: {}\ncommands: {}\n');
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function rootPage(id = '123456'): ConfluencePage {
  return {
    id,
    type: 'page',
    title: 'Approved project root',
    ancestors: [{ id: '10', title: 'Space home' }],
    operations: [
      { operation: 'update', targetType: 'page' },
    ],
    version: { number: 7 },
    space: { key: 'TEAM' },
  };
}

function dependencies(page = rootPage()) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rest/api/user/current')) {
      return new Response(JSON.stringify({ username: 'tester', displayName: 'Test User' }), { status: 200 });
    }
    if (url.pathname.includes('/rest/api/content/')) {
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return {
    createClient: (baseUrl: string, token: string) => new ConfluenceClient(baseUrl, token, { fetch: fetchMock }),
    credentialSource: () => 'environment' as const,
    resolveCredential: () => ({ token: 'DUMMY_TEST_PAT', source: 'environment' as const }),
    storeCredential: vi.fn(),
  };
}

describe('Confluence setup', () => {
  it('validates an environment credential without persisting it', async () => {
    const result = await authenticateConfluence({ nonInteractive: true }, dependencies());
    expect(result).toEqual({
      status: 'authenticated',
      baseUrl: 'https://help.severstal.com',
      credentialSource: 'environment',
      user: { username: 'tester', displayName: 'Test User' },
    });
  });

  it('authenticates, verifies root update access, and writes the project root atomically', async () => {
    const result = await setupConfluence({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      yes: true,
      nonInteractive: true,
    }, dependencies());

    expect(result.binding.status).toBe('bound');
    expect(result.binding.permissions).toEqual({
      updateRoot: true,
      createChildren: 'deferred-to-apply',
    });
    expect(loadProjectConfig().integrations.confluence?.rootPageId).toBe('123456');
    const config = readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8');
    expect(config).not.toContain('DUMMY_TEST_PAT');
  });

  it('requires rebind semantics before replacing an existing project root', async () => {
    const deps = dependencies();
    await bindConfluenceRoot({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      yes: true,
      nonInteractive: true,
    }, deps);

    await expect(bindConfluenceRoot({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=654321',
      yes: true,
      nonInteractive: true,
    }, dependencies(rootPage('654321')))).rejects.toThrow('Use confluence rebind');
  });

  it('fails closed when included root updates are not allowed', async () => {
    const readOnly = rootPage();
    readOnly.operations = [];
    await expect(bindConfluenceRoot({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      yes: true,
      nonInteractive: true,
    }, dependencies(readOnly))).rejects.toThrow('requires update-page permission');
  });

  it('binds a read-only root when root updates are excluded and defers child creation to apply', async () => {
    const readOnly = rootPage();
    readOnly.operations = [];
    const result = await bindConfluenceRoot({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      includeRoot: false,
      yes: true,
      nonInteractive: true,
    }, dependencies(readOnly));
    expect(result.permissions).toEqual({
      updateRoot: false,
      createChildren: 'deferred-to-apply',
    });
    expect(result.includeRoot).toBe(false);
  });

  it('reports project root, credential, identity, and permissions through doctor', async () => {
    const deps = dependencies();
    await bindConfluenceRoot({
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123456',
      yes: true,
      nonInteractive: true,
    }, deps);

    const result = await confluenceDoctor({}, deps);
    expect(result.ok).toBe(true);
    expect(result.credentialSource).toBe('environment');
    expect(result.checks.map((check) => check.name)).toEqual([
      'project-root',
      'credential',
      'identity',
      'root-reachable',
      'root-permissions',
    ]);
    expect(result.checks.at(-1)?.detail).toContain('create-child=deferred-to-apply');
  });
});
