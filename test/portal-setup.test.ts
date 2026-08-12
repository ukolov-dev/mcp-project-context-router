import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { portalDoctor, setupPortal } from '../src/portal/setup.js';
import { sha256, type PortalClient } from '../src/portal/client.js';
import { loadProjectConfig } from '../src/storage/config.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const snapshotId = '00000000-0000-4000-8000-000000000002';
const workItemId = '00000000-0000-4000-8000-000000000003';
let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'vincenzo-portal-setup-'));
  mkdirSync(resolve(tempDir, '.git'));
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  writeFileSync(
    resolve(tempDir, '.project-context/project.yaml'),
    'project:\n  name: Test\nmodules: {}\ncommands: {}\n',
  );
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function client(name = 'Verified Portal Project', key = 'VERIFIED-PORTAL') {
  return {
    getProject: vi.fn(async () => ({ id: projectId, key, name })),
    getCurrentSnapshot: vi.fn(async () => ({
      id: snapshotId,
      projectId,
      digest: sha256(''),
      createdBy: 'analyst',
      createdAt: '2026-07-26T12:00:00.000Z',
      entries: [],
      documents: [],
    })),
    getAssignedWork: vi.fn(async () => [{
      id: workItemId,
      projectId,
      snapshotId,
      snapshotDigest: sha256(''),
      handoffId: null,
      handoffDigest: null,
      title: 'Implement the demo scope',
      description: 'Use the exact Portal snapshot.',
      status: 'ASSIGNED',
      assignedSubjectId: 'developer',
      assignedSubjectName: 'Денис Разработчик',
      version: 1,
      updatedAt: '2026-07-26T12:05:00.000Z',
    }]),
  } as unknown as PortalClient;
}

function dependencies(portalClient = client()) {
  return {
    client: portalClient,
    credentialSource: () => 'environment' as const,
    resolveCredential: () => ({ token: 'DUMMY_TEST_TOKEN', source: 'environment' as const }),
    storeCredential: vi.fn(),
  };
}

describe('Portal setup', () => {
  it('stores the verified project id, key, and name without persisting credentials', async () => {
    const result = await setupPortal({
      baseUrl: 'https://portal.example.test',
      projectId,
      yes: true,
      nonInteractive: true,
    }, dependencies());

    expect(result.status).toBe('bound');
    expect(result.binding).toMatchObject({
      projectId,
      projectKey: 'VERIFIED-PORTAL',
      projectName: 'Verified Portal Project',
    });
    expect(result.ready).toBe(true);
    expect(result.snapshot).toMatchObject({
      status: 'ready',
      id: snapshotId,
      documentCount: 0,
    });
    expect(result.assignedWork).toMatchObject({
      status: 'ready',
      count: 1,
      workItems: [expect.objectContaining({
        id: workItemId,
        title: 'Implement the demo scope',
      })],
    });
    expect(loadProjectConfig().integrations.portal).toMatchObject({
      schemaVersion: 2,
      projectId,
      projectKey: 'VERIFIED-PORTAL',
      projectName: 'Verified Portal Project',
    });
    expect(readFileSync(resolve(tempDir, '.project-context/project.yaml'), 'utf8'))
      .not.toContain('DUMMY_TEST_TOKEN');
  });

  it('uses browser device authorization when no Portal credential exists', async () => {
    const authorizeDevice = vi.fn(async () => ({
      schemaVersion: 1 as const,
      kind: 'oauth-device' as const,
      issuerUrl: 'https://identity.example.test/realms/vincenzo',
      clientId: 'vincenzo-cli',
      accessToken: 'DUMMY_BROWSER_ACCESS_TOKEN',
      refreshToken: 'DUMMY_BROWSER_REFRESH_TOKEN',
      accessTokenExpiresAt: '2026-07-24T10:00:00.000Z',
    }));
    const storeOAuthCredential = vi.fn();
    const portalClient = client();

    const result = await setupPortal({
      baseUrl: 'https://portal.example.test',
      projectId,
      issuerUrl: 'https://identity.example.test/realms/vincenzo',
      clientId: 'vincenzo-cli',
      yes: true,
    }, {
      client: portalClient,
      credentialSource: () => 'missing',
      authorizeDevice,
      storeOAuthCredential,
    });

    expect(result.auth.credentialSource).toBe('native-store');
    expect(authorizeDevice).toHaveBeenCalledWith(expect.objectContaining({
      issuerUrl: 'https://identity.example.test/realms/vincenzo',
      clientId: 'vincenzo-cli',
    }));
    expect(storeOAuthCredential).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: 'DUMMY_BROWSER_REFRESH_TOKEN' }),
      expect.any(Object),
    );
  });

  it('keeps a successful binding visible when hydration fails and reports both failures', async () => {
    const portalClient = client() as unknown as {
      getCurrentSnapshot: ReturnType<typeof vi.fn>;
      getAssignedWork: ReturnType<typeof vi.fn>;
    };
    portalClient.getCurrentSnapshot.mockRejectedValue(new Error('No published snapshot is available.'));
    portalClient.getAssignedWork.mockRejectedValue(new Error('Assigned WorkPackages are unavailable.'));

    const result = await setupPortal({
      baseUrl: 'https://portal.example.test',
      projectId,
      yes: true,
      nonInteractive: true,
    }, dependencies(portalClient as unknown as PortalClient));

    expect(result.status).toBe('bound');
    expect(result.ready).toBe(false);
    expect(result.snapshot).toEqual({
      status: 'unavailable',
      error: 'No published snapshot is available.',
    });
    expect(result.assignedWork).toEqual({
      status: 'unavailable',
      authority: 'portal',
      count: 0,
      workItems: [],
      error: 'Assigned WorkPackages are unavailable.',
    });
  });

  it('fails doctor before snapshot sync when remote project identity drifts', async () => {
    await setupPortal({
      baseUrl: 'https://portal.example.test',
      projectId,
      yes: true,
      nonInteractive: true,
    }, dependencies());

    const result = await portalDoctor({}, dependencies(client('Neighbour Project', 'NEIGHBOUR')));

    expect(result.ok).toBe(false);
    expect(result.checks).toContainEqual(expect.objectContaining({
      name: 'project-identity',
      status: 'fail',
    }));
  });
});
