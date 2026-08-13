import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { loadProjectConfig, type PortalIntegrationConfig } from '../storage/config.js';
import { repoPaths } from '../storage/repo.js';
import {
  PortalApiError,
  PortalClient,
  portalSnapshotSchema,
  sha256,
  type PortalHandoff,
  type PortalContextPack,
  type PortalContextRetrievalInput,
  type PortalImplementationReport,
  type PortalWorkItem,
  type VerifiedPortalSnapshot,
} from './client.js';
import { resolvePortalAccessToken } from './credential-store.js';

const verifiedSnapshotSchema = portalSnapshotSchema.extend({
  documents: z.array(z.object({
    documentId: z.string().uuid(),
    revisionId: z.string().uuid(),
    contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
    body: z.string().max(1_000_000),
  })),
});

const cacheEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.literal('portal'),
  baseUrl: z.string().url(),
  projectId: z.string().uuid(),
  verifiedAt: z.string().datetime(),
  snapshot: verifiedSnapshotSchema,
});

export type PortalSnapshotResult = {
  authority: 'portal';
  projectId: string;
  snapshot: VerifiedPortalSnapshot;
  freshness: {
    state: 'fresh' | 'stale';
    verifiedAt: string;
    source: 'portal' | 'verified-cache';
  };
};

type BridgeDependencies = {
  client?: PortalClient;
  now?: () => Date;
};

export async function syncPortalSnapshot(
  options: { offline?: boolean } = {},
  dependencies: BridgeDependencies = {},
): Promise<PortalSnapshotResult> {
  const binding = requirePortalBinding();
  if (options.offline) return cachedResult(binding);
  const client = dependencies.client ?? await authenticatedClient(binding);
  try {
    const snapshot = await client.getCurrentSnapshot(binding.projectId);
    const verifiedAt = (dependencies.now?.() ?? new Date()).toISOString();
    writeCache(binding, { verifiedAt, snapshot });
    return {
      authority: 'portal',
      projectId: binding.projectId,
      snapshot,
      freshness: { state: 'fresh', verifiedAt, source: 'portal' },
    };
  } catch (error) {
    if (error instanceof PortalApiError && (error.status === 401 || error.status === 403)) throw error;
    if (!isNetworkFailure(error)) throw error;
    return cachedResult(binding);
  }
}

export async function getExactPortalSnapshot(
  snapshotId: string,
  dependencies: BridgeDependencies = {},
): Promise<PortalSnapshotResult> {
  const binding = requirePortalBinding();
  const client = dependencies.client ?? await authenticatedClient(binding);
  const snapshot = await client.getExactSnapshot(snapshotId, binding.projectId);
  return {
    authority: 'portal',
    projectId: binding.projectId,
    snapshot,
    freshness: {
      state: 'fresh',
      verifiedAt: (dependencies.now?.() ?? new Date()).toISOString(),
      source: 'portal',
    },
  };
}

export async function getAssignedPortalWork(
  dependencies: BridgeDependencies = {},
): Promise<{ authority: 'portal'; projectId: string; workItems: PortalWorkItem[] }> {
  const binding = requirePortalBinding();
  const client = dependencies.client ?? await authenticatedClient(binding);
  return {
    authority: 'portal',
    projectId: binding.projectId,
    workItems: await client.getAssignedWork(binding.projectId),
  };
}

export async function retrievePortalContext(
  input: PortalContextRetrievalInput,
  dependencies: BridgeDependencies = {},
): Promise<{ authority: 'portal'; projectId: string; contextPack: PortalContextPack }> {
  const binding = requirePortalBinding();
  const client = dependencies.client ?? await authenticatedClient(binding);
  return {
    authority: 'portal',
    projectId: binding.projectId,
    contextPack: await client.retrieveContext(binding.projectId, input),
  };
}

export async function getPortalHandoff(
  handoffId: string,
  dependencies: BridgeDependencies = {},
): Promise<{ authority: 'portal'; projectId: string; handoff: PortalHandoff; snapshot: VerifiedPortalSnapshot }> {
  const binding = requirePortalBinding();
  const client = dependencies.client ?? await authenticatedClient(binding);
  const handoff = await client.getHandoff(handoffId);
  const snapshot = await client.getExactSnapshot(handoff.snapshotId, binding.projectId);
  return { authority: 'portal', projectId: binding.projectId, handoff, snapshot };
}

export async function acceptPortalAssignment(
  input: {
    workItemId: string;
    expectedVersion: number;
  },
  dependencies: BridgeDependencies = {},
): Promise<{ authority: 'portal'; projectId: string; workItem: PortalWorkItem }> {
  const binding = requirePortalBinding();
  const client = dependencies.client ?? await authenticatedClient(binding);
  const workItem = await client.acceptAssignment({ ...input, projectId: binding.projectId });
  return { authority: 'portal', projectId: binding.projectId, workItem };
}

export async function submitPortalImplementationReport(
  input: {
    workItemId: string;
    expectedVersion: number;
    idempotencyKey: string;
    commitRef: string;
    mergeRequestUrl?: string;
    ciUrl?: string;
    summary: string;
  },
  dependencies: BridgeDependencies = {},
): Promise<{ authority: 'portal'; projectId: string; report: PortalImplementationReport }> {
  const binding = requirePortalBinding();
  rejectSecretLikeText(input.summary);
  validateReferenceUrl(input.mergeRequestUrl, 'mergeRequestUrl');
  validateReferenceUrl(input.ciUrl, 'ciUrl');
  const client = dependencies.client ?? await authenticatedClient(binding);
  const report = await client.submitImplementationReport({ ...input, projectId: binding.projectId });
  return { authority: 'portal', projectId: binding.projectId, report };
}

export function portalSyncStatus(): {
  configured: boolean;
  authority: 'portal';
  projectId?: string;
  projectKey?: string;
  projectName?: string;
  baseUrl?: string;
  cache?: {
    present: boolean;
    verifiedAt?: string;
    snapshotId?: string;
    snapshotDigest?: string;
  };
} {
  const binding = loadProjectConfig().integrations.portal;
  if (!binding) return { configured: false, authority: 'portal' };
  try {
    const cache = readCache(binding);
    return {
      configured: true,
      authority: 'portal',
      projectId: binding.projectId,
      projectKey: binding.projectKey,
      projectName: binding.projectName,
      baseUrl: binding.baseUrl,
      cache: {
        present: true,
        verifiedAt: cache.verifiedAt,
        snapshotId: cache.snapshot.id,
        snapshotDigest: cache.snapshot.digest,
      },
    };
  } catch {
    return {
      configured: true,
      authority: 'portal',
      projectId: binding.projectId,
      projectKey: binding.projectKey,
      projectName: binding.projectName,
      baseUrl: binding.baseUrl,
      cache: { present: false },
    };
  }
}

function requirePortalBinding(): PortalIntegrationConfig {
  const binding = loadProjectConfig().integrations.portal;
  if (!binding) {
    throw new Error('Portal project is not bound. Run `project-context portal setup`.');
  }
  if (!binding.projectKey || !binding.projectName) {
    throw new Error('Portal project binding is incomplete. Run `project-context portal setup` again.');
  }
  return binding;
}

async function authenticatedClient(binding: PortalIntegrationConfig): Promise<PortalClient> {
  return new PortalClient(binding.baseUrl, (await resolvePortalAccessToken()).token);
}

function writeCache(
  binding: PortalIntegrationConfig,
  value: { verifiedAt: string; snapshot: VerifiedPortalSnapshot },
): void {
  const path = cacheFile(binding);
  const parent = dirname(path);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new Error('Portal cache directory must not be a symbolic link.');
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const envelope = cacheEnvelopeSchema.parse({
    schemaVersion: 1,
    authority: 'portal',
    baseUrl: binding.baseUrl,
    projectId: binding.projectId,
    verifiedAt: value.verifiedAt,
    snapshot: value.snapshot,
  });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(envelope)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function readCache(binding: PortalIntegrationConfig): z.infer<typeof cacheEnvelopeSchema> {
  const path = cacheFile(binding);
  if (!existsSync(path)) throw new Error('No verified Portal snapshot cache is available.');
  if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
    throw new Error('Portal snapshot cache must be a regular file.');
  }
  const envelope = cacheEnvelopeSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  if (envelope.baseUrl !== binding.baseUrl || envelope.projectId !== binding.projectId) {
    throw new Error('Portal snapshot cache does not match the current project binding.');
  }
  if (envelope.snapshot.projectId !== binding.projectId) {
    throw new Error('Portal snapshot cache does not match the current project binding.');
  }
  const canonical = envelope.snapshot.entries
    .map((entry) => `${entry.documentId}:${entry.revisionId}:${entry.contentDigest}\n`)
    .join('');
  if (sha256(canonical) !== envelope.snapshot.digest) {
    throw new Error('Portal snapshot cache manifest digest mismatch.');
  }
  if (envelope.snapshot.documents.length !== envelope.snapshot.entries.length) {
    throw new Error('Portal snapshot cache is incomplete.');
  }
  for (const entry of envelope.snapshot.entries) {
    const document = envelope.snapshot.documents.find(
      (candidate) => candidate.documentId === entry.documentId && candidate.revisionId === entry.revisionId,
    );
    if (!document || document.contentDigest !== entry.contentDigest || sha256(document.body) !== entry.contentDigest) {
      throw new Error(`Portal snapshot cache revision ${entry.revisionId} digest mismatch.`);
    }
  }
  return envelope;
}

function cachedResult(binding: PortalIntegrationConfig): PortalSnapshotResult {
  const cache = readCache(binding);
  return {
    authority: 'portal',
    projectId: binding.projectId,
    snapshot: cache.snapshot,
    freshness: { state: 'stale', verifiedAt: cache.verifiedAt, source: 'verified-cache' },
  };
}

function cacheFile(binding: PortalIntegrationConfig): string {
  const paths = repoPaths();
  const requiredRoot = resolve(paths.contextDir, 'indexes');
  const cacheRoot = resolve(paths.root, binding.cachePath);
  const rel = relative(requiredRoot, cacheRoot);
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
    throw new Error('Portal cache_path must be a child of .project-context/indexes.');
  }
  return resolve(cacheRoot, `${binding.projectId}.verified-snapshot.json`);
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof PortalApiError) return false;
  return error.message.includes('bounded retries')
    || error.name === 'AbortError'
    || error.cause instanceof TypeError;
}

function rejectSecretLikeText(value: string): void {
  if (value.length > 4_000) throw new Error('Implementation summary exceeds 4000 characters.');
  const patterns = [
    /\b(?:password|passwd|pwd)\s*[:=]\s*\S+/i,
    /\b(?:api[_-]?key|access[_-]?token|secret)\s*[:=]\s*\S+/i,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}/,
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    throw new Error('Implementation summary contains secret-like material.');
  }
}

function validateReferenceUrl(value: string | undefined, label: string): void {
  if (!value) return;
  const url = new URL(value);
  if (url.username || url.password) throw new Error(`${label} cannot contain credentials.`);
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`${label} must use HTTPS, except for loopback development.`);
  }
}
