import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptPortalAssignment,
  portalSyncStatus,
  submitPortalImplementationReport,
  syncPortalSnapshot,
} from '../src/portal/bridge.js';
import { sha256, type PortalClient, type VerifiedPortalSnapshot } from '../src/portal/client.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const snapshotId = '00000000-0000-4000-8000-000000000002';
const documentId = '00000000-0000-4000-8000-000000000003';
const revisionId = '00000000-0000-4000-8000-000000000004';
const body = '# Portal authority\n';
const contentDigest = sha256(body);
const snapshotDigest = sha256(`${documentId}:${revisionId}:${contentDigest}\n`);

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'project-context-portal-bridge-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: Portal bridge
modules: {}
commands: {}
integrations:
  portal:
    schema_version: 2
    base_url: https://portal.example.test
    project_id: ${projectId}
    project_key: PORTAL-BRIDGE
    project_name: Portal bridge
    cache_path: .project-context/indexes/portal
    credential_ref: native:project-context-hub/PROJECT_CONTEXT_HUB_TOKEN
`, 'utf8');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function snapshot(): VerifiedPortalSnapshot {
  return {
    id: snapshotId,
    projectId,
    digest: snapshotDigest,
    createdBy: 'analyst',
    createdAt: '2026-07-23T12:00:00Z',
    entries: [{ documentId, revisionId, contentDigest }],
    documents: [{ documentId, revisionId, contentDigest, body }],
  };
}

describe('Portal verified snapshot bridge', () => {
  it('writes an ignored project-scoped cache and labels offline reads stale', async () => {
    const client = { getCurrentSnapshot: async () => snapshot() } as unknown as PortalClient;
    const online = await syncPortalSnapshot({}, {
      client,
      now: () => new Date('2026-07-23T12:30:00Z'),
    });
    const offline = await syncPortalSnapshot({ offline: true });

    expect(online.freshness).toEqual({
      state: 'fresh',
      verifiedAt: '2026-07-23T12:30:00.000Z',
      source: 'portal',
    });
    expect(offline.freshness.state).toBe('stale');
    expect(offline.freshness.source).toBe('verified-cache');
    expect(offline.authority).toBe('portal');
    expect(portalSyncStatus().cache).toMatchObject({
      present: true,
      snapshotId,
      snapshotDigest,
    });
    expect(portalSyncStatus()).toMatchObject({
      projectId,
      projectKey: 'PORTAL-BRIDGE',
      projectName: 'Portal bridge',
    });
  });

  it('rejects a corrupt cache rather than indexing it', async () => {
    const client = { getCurrentSnapshot: async () => snapshot() } as unknown as PortalClient;
    await syncPortalSnapshot({}, { client });
    const path = resolve(
      tempDir,
      '.project-context/indexes/portal',
      `${projectId}.verified-snapshot.json`,
    );
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    cached.snapshot.projectId = '00000000-0000-4000-8000-000000000099';
    writeFileSync(path, JSON.stringify(cached), 'utf8');

    await expect(syncPortalSnapshot({ offline: true })).rejects.toThrow('does not match');
  });

  it('rejects secret-like implementation evidence before any remote write', async () => {
    const client = {
      submitImplementationReport: async () => {
        throw new Error('must not be called');
      },
    } as unknown as PortalClient;

    await expect(submitPortalImplementationReport({
      workItemId: '00000000-0000-4000-8000-000000000005',
      expectedVersion: 1,
      idempotencyKey: 'report:1234567',
      commitRef: 'abc1234',
      summary: 'access_token=super-secret-value',
    }, { client })).rejects.toThrow('secret-like');
  });

  it('accepts only the repository-bound developer assignment', async () => {
    const workItemId = '00000000-0000-4000-8000-000000000005';
    const client = {
      acceptAssignment: async (input: {
        projectId: string;
        workItemId: string;
        expectedVersion: number;
      }) => ({
        id: input.workItemId,
        projectId: input.projectId,
        snapshotId,
        snapshotDigest,
        handoffId: '00000000-0000-4000-8000-000000000006',
        handoffDigest: sha256('handoff'),
        title: 'Demo task',
        description: 'Implement the exact snapshot.',
        status: 'IN_PROGRESS',
        assignedSubjectId: 'developer',
        assignedSubjectName: 'Денис Разработчик',
        version: input.expectedVersion + 1,
        updatedAt: '2026-07-25T08:00:00Z',
      }),
    } as unknown as PortalClient;

    await expect(acceptPortalAssignment({
      workItemId,
      expectedVersion: 1,
    }, { client })).resolves.toMatchObject({
      authority: 'portal',
      projectId,
      workItem: { id: workItemId, status: 'IN_PROGRESS' },
    });
  });
});
