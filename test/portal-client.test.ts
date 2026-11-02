import { describe, expect, it, vi } from 'vitest';
import { PortalClient, portalWorkItemSchema, normalizePortalBaseUrl, sha256 } from '../src/portal/client.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const snapshotId = '00000000-0000-4000-8000-000000000002';
const documentId = '00000000-0000-4000-8000-000000000003';
const revisionId = '00000000-0000-4000-8000-000000000004';
const workItemId = '00000000-0000-4000-8000-000000000005';
const handoffId = '00000000-0000-4000-8000-000000000006';
const body = '# Verified context\n';
const contentDigest = sha256(body);
const snapshotDigest = sha256(`${documentId}:${revisionId}:${contentDigest}\n`);
const handoffDigest = sha256(`${workItemId}:${snapshotId}`);

function response(value: unknown, status = 200): Response {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' },
  });
}

describe('Portal client', () => {
  it('accepts the canonical deterministic UUIDs used by the local Java seed', async () => {
    const seededProjectId = '11111111-1111-1111-1111-111111111111';
    const fetcher = vi.fn(async () => response({
      id: seededProjectId,
      key: 'PROJECT-CONTEXT-PILOT',
      name: 'Project Context Pilot',
    }));
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.getProject(seededProjectId)).resolves.toMatchObject({
      id: seededProjectId,
      key: 'PROJECT-CONTEXT-PILOT',
    });
  });

  it.each(['current', 'exact'] as const)('materializes a verified %s snapshot', async (kind) => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/context/snapshots/')) {
        return response({
          id: snapshotId,
          projectId,
          digest: snapshotDigest,
          createdBy: 'analyst',
          createdAt: '2026-07-23T12:00:00Z',
          entries: [{ documentId, revisionId, contentDigest }],
        });
      }
      if (url.includes(`/context/revisions/${revisionId}`)) return response(body);
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    const snapshot = await (kind === 'exact'
      ? client.getExactSnapshot(snapshotId, projectId)
      : client.getCurrentSnapshot(projectId));

    expect(snapshot.digest).toBe(snapshotDigest);
    expect(snapshot.documents).toEqual([{ documentId, revisionId, contentDigest, body }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects a different exact snapshot before loading its revisions', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/context/snapshots/')) {
        return response({
          id: '00000000-0000-4000-8000-000000000009',
          projectId,
          digest: snapshotDigest,
          createdBy: 'analyst',
          createdAt: '2026-07-23T12:00:00Z',
          entries: [{ documentId, revisionId, contentDigest }],
        });
      }
      return response(body);
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.getExactSnapshot(snapshotId, projectId)).rejects.toThrow('mismatched snapshot');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(['JSON GET', 'revision GET', 'JSON POST'] as const)('keeps the timeout active while reading a %s response body', async (operation) => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (operation === 'revision GET' && String(input).includes('/context/snapshots/current')) {
          return response({
            id: snapshotId, projectId, digest: snapshotDigest, createdBy: 'analyst',
            createdAt: '2026-07-23T12:00:00Z', entries: [{ documentId, revisionId, contentDigest }],
          });
        }
        const signal = init!.signal!;
        signals.push(signal);
        return new Response(new ReadableStream({
          start(controller) {
            const timer = setTimeout(() => {
              const value = operation === 'JSON GET' ? { id: projectId, key: 'TEST', name: 'Test' } : {
                contextSessionId: snapshotId, digest: sha256('pack'), query: 'test', intent: 'test',
                maximumTokens: 100, actualTokens: 0, truncated: false, items: [], droppedItems: [], unknowns: [],
              };
              controller.enqueue(new TextEncoder().encode(operation === 'revision GET' ? body : JSON.stringify(value)));
              controller.close();
            }, 200);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              controller.error(signal.reason);
            }, { once: true });
          },
        }));
      });
      const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
        fetch: fetcher as typeof fetch,
        timeoutMs: 100,
        retries: 2,
      });
      const result = (operation === 'JSON GET'
        ? client.getProject(projectId)
        : operation === 'revision GET' ? client.getCurrentSnapshot(projectId)
        : client.retrieveContext(projectId, { query: 'test', intent: 'test', maximumTokens: 100, topK: 1 })
      ).catch(error => error);

      await vi.advanceTimersByTimeAsync(500);

      expect(await result).toMatchObject({ message: 'Portal request failed after bounded retries.' });
      expect(fetcher).toHaveBeenCalledTimes(operation === 'JSON POST' ? 1 : operation === 'revision GET' ? 4 : 3);
      expect(signals.every(signal => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects digest tampering before returning shared context', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/context/snapshots/current')) {
        return response({
          id: snapshotId,
          projectId,
          digest: snapshotDigest,
          createdBy: 'analyst',
          createdAt: '2026-07-23T12:00:00Z',
          entries: [{ documentId, revisionId, contentDigest }],
        });
      }
      return response(`${body}tampered`);
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.getCurrentSnapshot(projectId)).rejects.toThrow('digest mismatch');
  });

  it('returns the exact handoff identifiers needed by the repository MCP', async () => {
    const fetcher = vi.fn(async () => response([{
      id: workItemId,
      projectId,
      snapshotId,
      snapshotDigest,
      handoffId,
      handoffDigest,
      sourceDocumentId: documentId,
      sourceRevisionId: revisionId,
      sourceTaskCode: 'DEV-123',
      title: 'Implement exact scope',
      description: 'Use only the assigned snapshot.',
      status: 'IN_PROGRESS',
      assignedSubjectId: 'developer',
      assignedSubjectName: 'Денис Разработчик',
      version: 1,
      updatedAt: '2026-07-23T12:00:00Z',
    }]));
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.getAssignedWork(projectId)).resolves.toEqual([
      expect.objectContaining({ handoffId, handoffDigest, snapshotDigest, sourceDocumentId: documentId, sourceRevisionId: revisionId, sourceTaskCode: 'DEV-123' }),
    ]);
  });

  it('accepts optional/null source fields and rejects malformed source IDs', () => {
    const work = {
      id: workItemId, projectId, snapshotId, snapshotDigest,
      handoffId, handoffDigest, title: 'Task', description: 'Scope', status: 'ASSIGNED',
      assignedSubjectId: 'developer', assignedSubjectName: null, version: 1,
      updatedAt: '2026-10-14T12:00:00Z',
    };
    expect(portalWorkItemSchema.parse(work)).not.toHaveProperty('sourceDocumentId');
    expect(portalWorkItemSchema.parse({ ...work, sourceDocumentId: null, sourceRevisionId: null, sourceTaskCode: null }))
      .toMatchObject({ sourceDocumentId: null, sourceRevisionId: null, sourceTaskCode: null });
    expect(portalWorkItemSchema.safeParse({ ...work, sourceDocumentId: 'bad-uuid' }).success).toBe(false);
    expect(portalWorkItemSchema.safeParse({ ...work, sourceRevisionId: 'bad-uuid' }).success).toBe(false);
  });

  it('requires explicit developer acceptance before implementation starts', async () => {
    const assigned = {
      id: workItemId,
      projectId,
      snapshotId,
      snapshotDigest,
      handoffId,
      handoffDigest,
      title: 'Implement exact scope',
      description: 'Use only the assigned snapshot.',
      status: 'ASSIGNED',
      assignedSubjectId: 'developer',
      assignedSubjectName: 'Денис Разработчик',
      version: 1,
      updatedAt: '2026-07-25T08:00:00Z',
    };
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/work-items?assignedToMe=true')) return response([assigned]);
      if (url.includes('/accept-assignment') && init?.method === 'POST') {
        return response({
          ...assigned,
          status: 'IN_PROGRESS',
          version: 2,
          updatedAt: '2026-07-25T08:01:00Z',
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.acceptAssignment({
      projectId,
      workItemId,
      expectedVersion: 1,
    })).resolves.toMatchObject({ status: 'IN_PROGRESS', version: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('uses bounded GET retries and never retries typed writes', async () => {
    let currentAttempts = 0;
    let reportAttempts = 0;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/context/snapshots/current')) {
        currentAttempts += 1;
        return response({ code: 'TEMPORARY' }, 503);
      }
      if (url.includes('/work-items?assignedToMe=true')) {
        return response([{
          id: workItemId,
          projectId,
          snapshotId,
          snapshotDigest,
          handoffId,
          handoffDigest,
          title: 'Implement',
          description: 'Typed work',
          status: 'IN_PROGRESS',
          assignedSubjectId: 'developer',
          assignedSubjectName: 'Денис Разработчик',
          version: 2,
          updatedAt: '2026-07-23T12:00:00Z',
        }]);
      }
      if (url.includes('/implementation-reports') && init?.method === 'POST') {
        reportAttempts += 1;
        return response({ code: 'TEMPORARY' }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 2,
    });

    await expect(client.getCurrentSnapshot(projectId)).rejects.toThrow('HTTP 503');
    expect(currentAttempts).toBe(3);
    await expect(client.submitImplementationReport({
      projectId,
      workItemId,
      expectedVersion: 2,
      idempotencyKey: 'report:1234567',
      commitRef: 'abc1234',
      summary: 'Implemented.',
    })).rejects.toThrow('HTTP 503');
    expect(reportAttempts).toBe(1);
  });

  it('retrieves a bounded context pack through the project-scoped POST endpoint', async () => {
    const contextSessionId = '00000000-0000-4000-8000-000000000007';
    const chunkId = '00000000-0000-4000-8000-000000000008';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toContain(`/api/v1/projects/${projectId}/context-retrieval/preview`);
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: 'audit evidence',
        maximumTokens: 700,
      });
      return response({
        contextSessionId,
        digest: sha256('pack'),
        query: 'audit evidence',
        intent: 'prepare proposal',
        maximumTokens: 700,
        actualTokens: 10,
        truncated: false,
        items: [{
          rank: 1,
          chunkId,
          artifactKey: 'document:1',
          artifactType: 'DOCUMENT_REVISION',
          authority: 'PUBLISHED',
          retrievalPolicy: 'CURRENT',
          sourceId: null,
          documentId,
          revisionId,
          contentDigest,
          headingPath: 'Evidence',
          excerpt: 'Verified context',
          tokenCount: 10,
          score: 3.5,
          reason: 'published authority',
          mandatory: false,
          pinned: false,
          stale: false,
          truncated: false,
          conflictMarkers: [],
        }],
        droppedItems: [],
        unknowns: [],
      });
    });
    const client = new PortalClient('https://portal.example.test', 'DUMMY_TOKEN', {
      fetch: fetcher as typeof fetch,
      retries: 0,
    });

    await expect(client.retrieveContext(projectId, {
      query: 'audit evidence',
      intent: 'prepare proposal',
      maximumTokens: 700,
      topK: 10,
    })).resolves.toMatchObject({
      contextSessionId,
      items: [{ authority: 'PUBLISHED', revisionId }],
    });
  });

  it('allows plain HTTP only for loopback development and rejects credential-bearing URLs', () => {
    expect(normalizePortalBaseUrl('http://localhost:28081')).toBe('http://localhost:28081');
    expect(() => normalizePortalBaseUrl('http://portal.example.test')).toThrow('HTTPS');
    expect(normalizePortalBaseUrl('http://backend:8080', true)).toBe('http://backend:8080');
    expect(() => normalizePortalBaseUrl('https://user:password@portal.example.test')).toThrow('credentials');
    expect(() => normalizePortalBaseUrl('https://portal.example.test/api')).toThrow('API path');
  });
});
