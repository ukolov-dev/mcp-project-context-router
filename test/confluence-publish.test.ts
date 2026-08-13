import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfluenceClient, type ConfluencePage } from '../src/confluence/client.js';
import {
  applyConfluencePublish,
  getConfluencePublishPlan,
  planConfluencePublish,
} from '../src/confluence/publish.js';
import { writeConfluenceIntegration } from '../src/storage/config.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-confluence-publish-'));
  mkdirSync(resolve(tempDir, '.git'));
  mkdirSync(resolve(tempDir, '.project-context/active/requirements'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/drafts'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), 'project:\n  name: Test\nmodules: {}\ncommands: {}\n');
  writeFileSync(
    resolve(tempDir, '.project-context/active/requirements/REQ-001.md'),
    '# REQ-001: Verified requirement\n\nThe system shall preserve source provenance.\n',
  );
  process.chdir(tempDir);
  writeConfluenceIntegration({
    schemaVersion: 1,
    baseUrl: 'https://help.severstal.com',
    rootPageId: '123',
    rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123',
    writeScope: 'root-and-descendants',
    includeRoot: true,
    credentialRef: 'native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN',
  });
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function page(input: Partial<ConfluencePage> = {}): ConfluencePage {
  return {
    id: '123',
    type: 'page',
    title: 'Project Context',
    ancestors: [],
    operations: [
      { operation: 'update', targetType: 'page' },
    ],
    version: { number: 2 },
    body: { storage: { value: '<p>old</p>', representation: 'storage' } },
    space: { key: 'TEAM' },
    ...input,
  };
}

function fakeConfluence(initial = page()) {
  let current = structuredClone(initial);
  let updateCalls = 0;
  let createCalls = 0;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/rest/api/user/current')) {
      return new Response(JSON.stringify({ username: 'tester' }), { status: 200 });
    }
    if (url.pathname.endsWith('/rest/api/content') && init?.method === 'POST') {
      createCalls += 1;
      const body = JSON.parse(String(init.body)) as { title: string; ancestors: Array<{ id: string }>; body: { storage: { value: string } } };
      current = page({
        id: '456',
        title: body.title,
        ancestors: [{ id: body.ancestors[0]!.id }],
        version: { number: 1 },
        body: { storage: { value: body.body.storage.value, representation: 'storage' } },
      });
      return new Response(JSON.stringify(current), { status: 200 });
    }
    if (url.pathname.endsWith(`/rest/api/content/${current.id}`) && init?.method === 'PUT') {
      updateCalls += 1;
      const body = JSON.parse(String(init.body)) as { title: string; version: { number: number }; body: { storage: { value: string } } };
      current = {
        ...current,
        title: body.title,
        version: { number: body.version.number },
        body: { storage: { value: body.body.storage.value, representation: 'storage' } },
      };
      return new Response(JSON.stringify(current), { status: 200 });
    }
    const requestedId = /\/rest\/api\/content\/(\d+)/.exec(url.pathname)?.[1];
    if (requestedId === current.id) return new Response(JSON.stringify(current), { status: 200 });
    if (requestedId === '123' && current.id === '456') return new Response(JSON.stringify(page()), { status: 200 });
    return new Response(JSON.stringify(page({ id: requestedId ?? '999', ancestors: [{ id: '999' }] })), { status: 200 });
  });
  return {
    dependencies: {
      createClient: (baseUrl: string, token: string) => new ConfluenceClient(baseUrl, token, { fetch: fetchMock }),
      resolveCredential: () => ({ token: 'DUMMY_TEST_PAT', source: 'environment' as const }),
      now: () => new Date('2026-07-23T08:00:00.000Z'),
    },
    setPage(next: ConfluencePage) {
      current = structuredClone(next);
    },
    counts() {
      return { updateCalls, createCalls };
    },
  };
}

const recordPath = '.project-context/active/requirements/REQ-001.md';

describe('scoped Confluence publication', () => {
  it('plans and applies an update only after matching digest confirmation', async () => {
    const remote = fakeConfluence();
    const planned = await planConfluencePublish({
      operation: 'update',
      recordPaths: [recordPath],
    }, remote.dependencies);

    expect(planned.page.targetPageId).toBe('123');
    expect(planned.diff).toEqual({
      kind: 'replace-page-body',
      changed: true,
      currentStorageSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedStorageSha256: planned.proposedStorageSha256,
    });
    expect(remote.counts().updateCalls).toBe(0);
    const applied = await applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, remote.dependencies);

    expect(applied.status).toBe('applied');
    expect(applied.page.version).toBe(3);
    expect(remote.counts().updateCalls).toBe(1);
    expect(getConfluencePublishPlan(planned.planDigest)).not.toHaveProperty('storageValue');
    await expect(applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, remote.dependencies)).rejects.toThrow('already been applied');
  });

  it('rejects pages outside the bound root subtree before creating a plan', async () => {
    const remote = fakeConfluence();
    await expect(planConfluencePublish({
      operation: 'update',
      targetPageId: '999',
      recordPaths: [recordPath],
    }, remote.dependencies)).rejects.toThrow('outside the project root subtree');
  });

  it('rejects stale remote versions and changed local records before write', async () => {
    const first = fakeConfluence();
    const planned = await planConfluencePublish({ operation: 'update', recordPaths: [recordPath] }, first.dependencies);
    first.setPage(page({ version: { number: 3 } }));
    await expect(applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, first.dependencies)).rejects.toThrow('changed from version 2 to 3');
    expect(first.counts().updateCalls).toBe(0);

    const second = fakeConfluence();
    const changedPlan = await planConfluencePublish({ operation: 'update', recordPaths: [recordPath] }, second.dependencies);
    writeFileSync(resolve(tempDir, recordPath), '# REQ-001\n\nChanged after planning.\n');
    await expect(applyConfluencePublish({
      planDigest: changedPlan.planDigest,
      confirmDigest: changedPlan.planDigest,
      approvedBy: 'human-reviewer',
    }, second.dependencies)).rejects.toThrow('records changed');
    expect(second.counts().updateCalls).toBe(0);
  });

  it('creates a child only under an allowed parent and verifies its ancestry', async () => {
    const remote = fakeConfluence();
    const planned = await planConfluencePublish({
      operation: 'create-child',
      parentPageId: '123',
      title: 'Published requirements',
      recordPaths: [recordPath],
    }, remote.dependencies);
    expect(planned.diff).toEqual({
      kind: 'create-child-page',
      proposedStorageSha256: planned.proposedStorageSha256,
    });
    const applied = await applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, remote.dependencies);

    expect(applied.page).toEqual(expect.objectContaining({ pageId: '456', title: 'Published requirements' }));
    expect(remote.counts().createCalls).toBe(1);
  });

  it('defers create-child authorization to Confluence instead of page operations metadata', async () => {
    const remote = fakeConfluence(page({ operations: [] }));
    const planned = await planConfluencePublish({
      operation: 'create-child',
      parentPageId: '123',
      title: 'Published requirements',
      recordPaths: [recordPath],
    }, remote.dependencies);

    await applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, remote.dependencies);

    expect(remote.counts().createCalls).toBe(1);
  });

  it('can create a direct child when the root itself is excluded from updates', async () => {
    writeConfluenceIntegration({
      schemaVersion: 1,
      baseUrl: 'https://help.severstal.com',
      rootPageId: '123',
      rootPageUrl: 'https://help.severstal.com/pages/viewpage.action?pageId=123',
      writeScope: 'root-and-descendants',
      includeRoot: false,
      credentialRef: 'native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN',
    });
    const remote = fakeConfluence();
    const planned = await planConfluencePublish({
      operation: 'create-child',
      title: 'Published requirements',
      recordPaths: [recordPath],
    }, remote.dependencies);
    await applyConfluencePublish({
      planDigest: planned.planDigest,
      confirmDigest: planned.planDigest,
      approvedBy: 'human-reviewer',
    }, remote.dependencies);
    expect(remote.counts().createCalls).toBe(1);
  });

  it('refuses to publish a record that fails secret scanning', async () => {
    writeFileSync(resolve(tempDir, recordPath), '# Secret\n\ntoken=REAL_LOOKING_SECRET_1234567890\n');
    const remote = fakeConfluence();
    await expect(planConfluencePublish({
      operation: 'update',
      recordPaths: [recordPath],
    }, remote.dependencies)).rejects.toThrow('failed secret scanning');
  });
});
