import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { PortalIntegrationConfig } from '../storage/config.js';

const uuid = z.string().regex(
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
  'Expected a canonical Java UUID string.',
);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const portalSnapshotSchema = z.object({
  id: uuid,
  projectId: uuid,
  digest,
  createdBy: z.string().min(1),
  createdAt: z.string().datetime(),
  entries: z.array(z.object({
    documentId: uuid,
    revisionId: uuid,
    contentDigest: digest,
  })).max(10_000),
});

export const portalWorkItemSchema = z.object({
  id: uuid,
  projectId: uuid,
  snapshotId: uuid,
  snapshotDigest: digest,
  handoffId: uuid.nullable(),
  handoffDigest: digest.nullable(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  assignedSubjectId: z.string().nullable(),
  assignedSubjectName: z.string().nullable(),
  version: z.number().int().nonnegative(),
  updatedAt: z.string().datetime(),
});

export const portalHandoffSchema = z.object({
  id: uuid,
  workItemId: uuid,
  snapshotId: uuid,
  digest,
  createdAt: z.string().datetime(),
});

export const portalImplementationReportSchema = z.object({
  id: uuid,
  workItemId: uuid,
  snapshotId: uuid,
  commitRef: z.string(),
  mergeRequestUrl: z.string().nullable(),
  ciUrl: z.string().nullable(),
  summary: z.string(),
  submittedAt: z.string().datetime(),
});

export const portalContextPackSchema = z.object({
  contextSessionId: uuid,
  digest,
  query: z.string(),
  intent: z.string(),
  requestedMode: z.enum(['AUTO', 'FULL_TEXT', 'VECTOR_EXACT', 'HYBRID']).default('AUTO'),
  effectiveMode: z.string().default('FULL_TEXT'),
  fusionVersion: z.string().default('rrf-v1'),
  fallbackUsed: z.boolean().default(false),
  maximumTokens: z.number().int().nonnegative(),
  actualTokens: z.number().int().nonnegative(),
  truncated: z.boolean(),
  items: z.array(z.object({
    rank: z.number().int().positive(),
    chunkId: uuid,
    artifactKey: z.string(),
    artifactType: z.string(),
    authority: z.enum(['SOURCE', 'NORMALIZED_SOURCE', 'PROPOSAL', 'DRAFT', 'CANDIDATE', 'PUBLISHED']),
    retrievalPolicy: z.string(),
    sourceId: uuid.nullable(),
    documentId: uuid.nullable(),
    revisionId: uuid.nullable(),
    contentDigest: digest,
    headingPath: z.string(),
    excerpt: z.string(),
    tokenCount: z.number().int().nonnegative(),
    score: z.number(),
    reason: z.string(),
    mandatory: z.boolean(),
    pinned: z.boolean(),
    stale: z.boolean(),
    truncated: z.boolean(),
    retrievalChannels: z.array(z.string()).default([]),
    conflictMarkers: z.array(z.string()),
  })).max(100),
  droppedItems: z.array(z.object({
    chunkId: uuid,
    reason: z.string(),
  })).max(10_000),
  unknowns: z.array(z.string()).max(1_000),
});

export type PortalSnapshot = z.infer<typeof portalSnapshotSchema>;
export type PortalWorkItem = z.infer<typeof portalWorkItemSchema>;
export type PortalHandoff = z.infer<typeof portalHandoffSchema>;
export type PortalImplementationReport = z.infer<typeof portalImplementationReportSchema>;
export type PortalContextPack = z.infer<typeof portalContextPackSchema>;

export type PortalContextRetrievalInput = {
  query: string;
  intent: string;
  maximumTokens: number;
  topK: number;
  allowedAuthorities?: Array<'SOURCE' | 'NORMALIZED_SOURCE' | 'PROPOSAL' | 'DRAFT' | 'CANDIDATE' | 'PUBLISHED'>;
  mandatoryChunkIds?: string[];
  pinnedChunkIds?: string[];
  excludedChunkIds?: string[];
  documentType?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  participant?: string;
  sourceId?: string;
  documentId?: string;
  exactRevisionId?: string;
  exactSnapshotId?: string;
  retrievalMode?: 'AUTO' | 'FULL_TEXT' | 'VECTOR_EXACT' | 'HYBRID';
};

export type PortalSnapshotDocument = PortalSnapshot['entries'][number] & {
  body: string;
};

export type VerifiedPortalSnapshot = PortalSnapshot & {
  documents: PortalSnapshotDocument[];
};

export class PortalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PortalApiError';
  }
}

export class PortalClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly options: {
      fetch?: typeof fetch;
      timeoutMs?: number;
      retries?: number;
      allowInsecureDevelopment?: boolean;
    } = {},
  ) {
    this.baseUrl = normalizePortalBaseUrl(
      baseUrl,
      options.allowInsecureDevelopment
        ?? process.env.VINCENZO_ALLOW_INSECURE_LOCAL_PORTAL === 'true',
    );
    if (!token.trim()) throw new Error('Portal access token is empty.');
  }

  async getProject(projectId: string): Promise<Record<string, unknown>> {
    assertUuid(projectId, 'projectId');
    const value = await this.json(`/api/v1/projects/${projectId}`);
    const project = z.object({ id: uuid, key: z.string(), name: z.string() }).passthrough().parse(value);
    if (project.id !== projectId) throw new Error('Portal returned a mismatched project.');
    return project;
  }

  async getCurrentSnapshot(projectId: string): Promise<VerifiedPortalSnapshot> {
    assertUuid(projectId, 'projectId');
    const manifest = portalSnapshotSchema.parse(
      await this.json(`/api/v1/projects/${projectId}/context/snapshots/current`),
    );
    return this.materializeSnapshot(manifest, projectId);
  }

  async getExactSnapshot(snapshotId: string, expectedProjectId: string): Promise<VerifiedPortalSnapshot> {
    assertUuid(snapshotId, 'snapshotId');
    assertUuid(expectedProjectId, 'projectId');
    const manifest = portalSnapshotSchema.parse(await this.json(`/api/v1/context/snapshots/${snapshotId}`));
    return this.materializeSnapshot(manifest, expectedProjectId);
  }

  async getAssignedWork(projectId: string): Promise<PortalWorkItem[]> {
    assertUuid(projectId, 'projectId');
    const values = z.array(portalWorkItemSchema).parse(
      await this.json(`/api/v1/projects/${projectId}/work-items?assignedToMe=true`),
    );
    if (values.some((value) => value.projectId !== projectId)) {
      throw new Error('Portal returned work from a different project.');
    }
    return values;
  }

  async retrieveContext(projectId: string, input: PortalContextRetrievalInput): Promise<PortalContextPack> {
    assertUuid(projectId, 'projectId');
    for (const [label, values] of Object.entries({
      mandatoryChunkIds: input.mandatoryChunkIds,
      pinnedChunkIds: input.pinnedChunkIds,
      excludedChunkIds: input.excludedChunkIds,
    })) {
      for (const value of values ?? []) assertUuid(value, label);
    }
    for (const [label, value] of Object.entries({
      sourceId: input.sourceId,
      documentId: input.documentId,
      exactRevisionId: input.exactRevisionId,
      exactSnapshotId: input.exactSnapshotId,
    })) {
      if (value) assertUuid(value, label);
    }
    if (!Number.isInteger(input.maximumTokens) || input.maximumTokens < 64 || input.maximumTokens > 128_000) {
      throw new Error('maximumTokens must be an integer from 64 to 128000.');
    }
    if (!Number.isInteger(input.topK) || input.topK < 1 || input.topK > 50) {
      throw new Error('topK must be an integer from 1 to 50.');
    }
    return portalContextPackSchema.parse(await this.json(
      `/api/v1/projects/${projectId}/context-retrieval/preview`,
      {
        method: 'POST',
        body: JSON.stringify(input),
      },
    ));
  }

  async getHandoff(handoffId: string): Promise<PortalHandoff> {
    assertUuid(handoffId, 'handoffId');
    return portalHandoffSchema.parse(await this.json(`/api/v1/handoffs/${handoffId}`));
  }

  async acceptAssignment(input: {
    projectId: string;
    workItemId: string;
    expectedVersion: number;
  }): Promise<PortalWorkItem> {
    assertUuid(input.projectId, 'projectId');
    assertUuid(input.workItemId, 'workItemId');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('expectedVersion must be a non-negative integer.');
    }
    const assigned = await this.getAssignedWork(input.projectId);
    const workItem = assigned.find((candidate) => candidate.id === input.workItemId);
    if (!workItem) throw new Error('Work item is not assigned to the current identity in the bound project.');
    if (workItem.status === 'IN_PROGRESS') return workItem;
    if (workItem.status !== 'ASSIGNED' || !workItem.handoffId) {
      throw new Error('Work item is not ready for developer acceptance.');
    }
    if (workItem.version !== input.expectedVersion) {
      throw new Error(`Stale WorkPackage version: expected ${input.expectedVersion}, current ${workItem.version}.`);
    }
    const accepted = portalWorkItemSchema.parse(await this.json(
      `/api/v1/work-items/${input.workItemId}/accept-assignment`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedVersion: input.expectedVersion }),
      },
    ));
    if (
      accepted.id !== input.workItemId
      || accepted.projectId !== input.projectId
      || accepted.snapshotId !== workItem.snapshotId
      || accepted.status !== 'IN_PROGRESS'
    ) {
      throw new Error('Portal returned a mismatched accepted WorkPackage.');
    }
    return accepted;
  }

  async submitImplementationReport(input: {
    projectId: string;
    workItemId: string;
    expectedVersion: number;
    idempotencyKey: string;
    commitRef: string;
    mergeRequestUrl?: string;
    ciUrl?: string;
    summary: string;
  }): Promise<PortalImplementationReport> {
    assertUuid(input.projectId, 'projectId');
    assertUuid(input.workItemId, 'workItemId');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new Error('expectedVersion must be a non-negative integer.');
    }
    if (!/^[A-Za-z0-9._:/-]{7,255}$/.test(input.idempotencyKey)) {
      throw new Error('Idempotency key must be 7-255 safe ASCII characters.');
    }
    const assigned = await this.getAssignedWork(input.projectId);
    const workItem = assigned.find((candidate) => candidate.id === input.workItemId);
    if (!workItem) throw new Error('Work item is not assigned to the current identity in the bound project.');
    if (workItem.version !== input.expectedVersion) {
      throw new Error(`Stale WorkPackage version: expected ${input.expectedVersion}, current ${workItem.version}.`);
    }
    const response = await this.json(
      `/api/v1/work-items/${input.workItemId}/implementation-reports`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': input.idempotencyKey },
        body: JSON.stringify({
          expectedVersion: input.expectedVersion,
          commitRef: input.commitRef,
          mergeRequestUrl: input.mergeRequestUrl,
          ciUrl: input.ciUrl,
          summary: input.summary,
        }),
      },
    );
    const report = portalImplementationReportSchema.parse(response);
    if (report.workItemId !== input.workItemId || report.snapshotId !== workItem.snapshotId) {
      throw new Error('Portal returned an implementation report with mismatched provenance.');
    }
    return report;
  }

  private async materializeSnapshot(
    manifest: PortalSnapshot,
    expectedProjectId: string,
  ): Promise<VerifiedPortalSnapshot> {
    if (manifest.projectId !== expectedProjectId) throw new Error('Portal returned a cross-project snapshot.');
    const canonical = manifest.entries
      .map((entry) => `${entry.documentId}:${entry.revisionId}:${entry.contentDigest}\n`)
      .join('');
    if (sha256(canonical) !== manifest.digest) throw new Error('Portal snapshot manifest digest mismatch.');
    const documents = await Promise.all(manifest.entries.map(async (entry) => {
      const body = await this.text(
        `/api/v1/context/revisions/${entry.revisionId}?documentId=${entry.documentId}`,
      );
      if (Buffer.byteLength(body, 'utf8') > 1_000_000) {
        throw new Error(`Portal revision ${entry.revisionId} exceeds the 1 MB connector limit.`);
      }
      if (sha256(body) !== entry.contentDigest) {
        throw new Error(`Portal revision ${entry.revisionId} digest mismatch.`);
      }
      return { ...entry, body };
    }));
    return { ...manifest, documents };
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.request(path, init);
    const raw = await response.text();
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`Portal returned invalid JSON for ${path}.`);
    }
  }

  private async text(path: string): Promise<string> {
    return (await this.request(path)).text();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith('/api/v1/')) throw new Error('Portal client path must use the versioned API.');
    const method = init.method ?? 'GET';
    const retries = method === 'GET' ? (this.options.retries ?? 2) : 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5_000);
      try {
        const response = await (this.options.fetch ?? fetch)(`${this.baseUrl}${path}`, {
          ...init,
          signal: controller.signal,
          headers: {
            accept: 'application/json, text/plain',
            authorization: `Bearer ${this.token}`,
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...init.headers,
          },
        });
        if (response.ok) return response;
        const body = (await response.text()).slice(0, 2_000);
        const error = parseApiError(response.status, body);
        if (attempt < retries && retryableStatus(response.status)) {
          lastError = error;
          continue;
        }
        throw error;
      } catch (error) {
        if (error instanceof PortalApiError) throw error;
        lastError = error;
        if (attempt === retries) break;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw new Error('Portal request failed after bounded retries.', { cause: lastError });
  }
}

export function normalizePortalBaseUrl(value: string, allowInsecureDevelopment = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Portal base URL cannot contain credentials, query, or fragment.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureDevelopment))) {
    throw new Error('Portal base URL must use HTTPS; HTTP is allowed only for loopback development.');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Portal base URL must not include an API path.');
  }
  return url.origin;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

function parseApiError(status: number, body: string): PortalApiError {
  try {
    const value = JSON.parse(body) as { code?: unknown; message?: unknown };
    return new PortalApiError(
      status,
      typeof value.code === 'string' ? value.code : 'PORTAL_REQUEST_FAILED',
      typeof value.message === 'string' ? value.message : `Portal request failed with HTTP ${status}.`,
    );
  } catch {
    return new PortalApiError(status, 'PORTAL_REQUEST_FAILED', `Portal request failed with HTTP ${status}.`);
  }
}

function assertUuid(value: string, label: string): void {
  if (!uuid.safeParse(value).success) throw new Error(`${label} must be a UUID.`);
}
