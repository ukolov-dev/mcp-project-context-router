import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { ConfluenceClient, assertPageInsideRoot, pageAllows } from './client.js';
import { resolveConfluenceCredential } from './credential-store.js';
import { loadProjectConfig, type ConfluenceIntegrationConfig } from '../storage/config.js';
import { repoPaths } from '../storage/repo.js';
import { scanSecrets } from '../storage/secrets.js';

export const planConfluencePublishInputSchema = z.object({
  operation: z.enum(['update', 'create-child']).default('update'),
  targetPageId: z.string().regex(/^\d+$/).optional(),
  parentPageId: z.string().regex(/^\d+$/).optional(),
  title: z.string().trim().min(1).max(255).optional(),
  recordPaths: z.array(z.string().min(1)).min(1).max(100),
}).superRefine((input, context) => {
  if (input.operation === 'create-child' && !input.title) {
    context.addIssue({ code: 'custom', message: 'create-child requires title.' });
  }
  if (input.operation === 'create-child' && input.targetPageId) {
    context.addIssue({ code: 'custom', message: 'create-child uses parentPageId, not targetPageId.' });
  }
  if (input.operation === 'update' && input.parentPageId) {
    context.addIssue({ code: 'custom', message: 'update uses targetPageId, not parentPageId.' });
  }
});

export const applyConfluencePublishInputSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  confirmDigest: z.string().regex(/^[a-f0-9]{64}$/),
  approvedBy: z.string().trim().min(1).max(120),
});

export type PlanConfluencePublishInput = z.infer<typeof planConfluencePublishInputSchema>;
export type ApplyConfluencePublishInput = z.infer<typeof applyConfluencePublishInputSchema>;

type RecordSnapshot = {
  path: string;
  sha256: string;
  bytes: number;
  title: string;
};

type ConfluencePublishPlan = {
  schemaVersion: 1;
  status: 'planned' | 'applied';
  createdAt: string;
  appliedAt?: string;
  approvedBy?: string;
  baseUrl: string;
  rootPageId: string;
  includeRoot: boolean;
  operation: 'update' | 'create-child';
  targetPageId?: string;
  parentPageId?: string;
  title: string;
  expectedVersion?: number;
  expectedRemoteContentSha256?: string;
  records: RecordSnapshot[];
  proposedStorageSha256: string;
  storageValue: string;
  planDigest: string;
  result?: {
    pageId: string;
    title: string;
    version?: number;
  };
};

type PublishDependencies = {
  createClient?: (baseUrl: string, token: string) => ConfluenceClient;
  resolveCredential?: typeof resolveConfluenceCredential;
  now?: () => Date;
};

export async function planConfluencePublish(
  rawInput: PlanConfluencePublishInput,
  dependencies: PublishDependencies = {},
): Promise<{
  status: 'planned';
  planDigest: string;
  confirmation: string;
  operation: 'update' | 'create-child';
  page: { targetPageId?: string; parentPageId?: string; title: string; expectedVersion?: number };
  diff:
    | { kind: 'replace-page-body'; changed: boolean; currentStorageSha256: string; proposedStorageSha256: string }
    | { kind: 'create-child-page'; proposedStorageSha256: string };
  records: RecordSnapshot[];
  proposedStorageSha256: string;
  scope: { rootPageId: string; includeRoot: boolean };
}> {
  const input = planConfluencePublishInputSchema.parse(rawInput);
  const config = requireConfluenceConfig();
  const client = clientFor(config, dependencies);
  const records = loadRecordSnapshots(input.recordPaths);
  const storageValue = renderRecordsForConfluence(records);
  const proposedStorageSha256 = sha256(storageValue);
  let targetPageId: string | undefined;
  let parentPageId: string | undefined;
  let title: string;
  let expectedVersion: number | undefined;
  let expectedRemoteContentSha256: string | undefined;

  if (input.operation === 'update') {
    targetPageId = input.targetPageId ?? config.rootPageId;
    const page = await assertPageInsideRoot(client, targetPageId, config, { includeBody: true });
    if (!pageAllows(page, 'update')) throw new Error(`Confluence page ${page.id} does not allow update.`);
    const version = page.version?.number;
    if (!Number.isInteger(version) || Number(version) < 1) {
      throw new Error(`Confluence page ${page.id} has no usable version.`);
    }
    title = input.title ?? page.title;
    expectedVersion = Number(version);
    expectedRemoteContentSha256 = sha256(page.body?.storage?.value ?? '');
  } else {
    parentPageId = input.parentPageId ?? config.rootPageId;
    const parent = await assertPageInsideRoot(client, parentPageId, config, { allowRootAsParent: true });
    if (!parent.space?.key) throw new Error(`Confluence parent page ${parent.id} has no space key.`);
    title = input.title!;
  }

  const unsigned = {
    schemaVersion: 1 as const,
    status: 'planned' as const,
    createdAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    baseUrl: config.baseUrl,
    rootPageId: config.rootPageId,
    includeRoot: config.includeRoot,
    operation: input.operation,
    targetPageId,
    parentPageId,
    title,
    expectedVersion,
    expectedRemoteContentSha256,
    records,
    proposedStorageSha256,
    storageValue,
  };
  const planDigest = sha256(canonicalize(unsigned));
  const plan: ConfluencePublishPlan = { ...unsigned, planDigest };
  writePlan(plan);
  return {
    status: 'planned',
    planDigest,
    confirmation: `Review the plan, then apply with confirmDigest=${planDigest}`,
    operation: plan.operation,
    page: {
      targetPageId,
      parentPageId,
      title,
      expectedVersion,
    },
    diff: plan.operation === 'update'
      ? {
        kind: 'replace-page-body',
        changed: expectedRemoteContentSha256 !== proposedStorageSha256,
        currentStorageSha256: expectedRemoteContentSha256!,
        proposedStorageSha256,
      }
      : {
        kind: 'create-child-page',
        proposedStorageSha256,
      },
    records,
    proposedStorageSha256,
    scope: { rootPageId: config.rootPageId, includeRoot: config.includeRoot },
  };
}

export async function applyConfluencePublish(
  rawInput: ApplyConfluencePublishInput,
  dependencies: PublishDependencies = {},
): Promise<{
  status: 'applied';
  planDigest: string;
  page: { pageId: string; title: string; version?: number };
  approvedBy: string;
}> {
  const input = applyConfluencePublishInputSchema.parse(rawInput);
  if (input.confirmDigest !== input.planDigest) throw new Error('Confluence publish confirmation digest differs from the plan digest.');
  const plan = readPlan(input.planDigest);
  if (plan.status !== 'planned') throw new Error(`Confluence publish plan ${plan.planDigest} has already been applied.`);
  const digest = sha256(canonicalize(unsignedPlan(plan)));
  if (digest !== plan.planDigest) throw new Error('Confluence publish plan content or digest was modified.');

  const config = requireConfluenceConfig();
  if (config.baseUrl !== plan.baseUrl || config.rootPageId !== plan.rootPageId || config.includeRoot !== plan.includeRoot) {
    throw new Error('Project Confluence binding changed after this plan was created.');
  }
  const records = loadRecordSnapshots(plan.records.map((record) => record.path));
  if (canonicalize(records) !== canonicalize(plan.records)) {
    throw new Error('Project Context records changed after this Confluence publish plan was created.');
  }
  const storageValue = renderRecordsForConfluence(records);
  if (sha256(storageValue) !== plan.proposedStorageSha256 || storageValue !== plan.storageValue) {
    throw new Error('Proposed Confluence content changed after this plan was created.');
  }

  const client = clientFor(config, dependencies);
  let page;
  if (plan.operation === 'update') {
    if (!plan.targetPageId || !plan.expectedVersion || !plan.expectedRemoteContentSha256) {
      throw new Error('Confluence update plan is incomplete.');
    }
    const current = await assertPageInsideRoot(client, plan.targetPageId, config, { includeBody: true });
    if (!pageAllows(current, 'update')) throw new Error(`Confluence page ${current.id} no longer allows update.`);
    if (current.version?.number !== plan.expectedVersion) {
      throw new Error(`Confluence page ${current.id} changed from version ${plan.expectedVersion} to ${current.version?.number ?? 'unknown'}. Create a new plan.`);
    }
    if (sha256(current.body?.storage?.value ?? '') !== plan.expectedRemoteContentSha256) {
      throw new Error(`Confluence page ${current.id} content changed without the expected version. Create a new plan.`);
    }
    page = await client.updatePage({
      pageId: current.id,
      title: plan.title,
      expectedVersion: plan.expectedVersion,
      storageValue,
    });
  } else {
    if (!plan.parentPageId) throw new Error('Confluence create-child plan is incomplete.');
    const parent = await assertPageInsideRoot(client, plan.parentPageId, config, { allowRootAsParent: true });
    if (!parent.space?.key) throw new Error(`Confluence parent page ${parent.id} has no space key.`);
    page = await client.createPage({
      parentPageId: parent.id,
      spaceKey: parent.space.key,
      title: plan.title,
      storageValue,
    });
    const created = await assertPageInsideRoot(client, page.id, config);
    if (created.id !== page.id) throw new Error('Created Confluence page could not be verified inside the project root.');
  }

  const applied: ConfluencePublishPlan = {
    ...plan,
    status: 'applied',
    appliedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    approvedBy: input.approvedBy,
    result: {
      pageId: page.id,
      title: page.title,
      version: page.version?.number,
    },
  };
  writePlan(applied);
  return {
    status: 'applied',
    planDigest: plan.planDigest,
    page: applied.result!,
    approvedBy: input.approvedBy,
  };
}

export function getConfluencePublishPlan(planDigest: string): Omit<ConfluencePublishPlan, 'storageValue'> {
  const plan = readPlan(z.string().regex(/^[a-f0-9]{64}$/).parse(planDigest));
  const { storageValue: _storageValue, ...safe } = plan;
  return safe;
}

function requireConfluenceConfig(): ConfluenceIntegrationConfig {
  const config = loadProjectConfig().integrations.confluence;
  if (!config) {
    throw new Error('Confluence root is not bound for this project. Run `vincenzo confluence setup`.');
  }
  return config;
}

function clientFor(config: ConfluenceIntegrationConfig, dependencies: PublishDependencies): ConfluenceClient {
  const credential = (dependencies.resolveCredential ?? resolveConfluenceCredential)();
  return dependencies.createClient?.(config.baseUrl, credential.token)
    ?? new ConfluenceClient(config.baseUrl, credential.token);
}

function loadRecordSnapshots(paths: string[]): RecordSnapshot[] {
  const repo = repoPaths();
  const activeRoot = realpathSync(repo.activeDir);
  let totalBytes = 0;
  const unique = [...new Set(paths)].sort();
  return unique.map((path) => {
    const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
    if (isAbsolute(path) || normalized.split('/').includes('..')) {
      throw new Error(`Confluence publication record must be project-relative: ${path}`);
    }
    if (!normalized.startsWith('.project-context/active/') || !normalized.endsWith('.md')) {
      throw new Error(`Confluence publication accepts only active Project Context Markdown records: ${path}`);
    }
    const absolute = resolve(repo.root, normalized);
    if (!existsSync(absolute)) throw new Error(`Confluence publication record does not exist: ${normalized}`);
    if (lstatSync(absolute).isSymbolicLink()) throw new Error(`Confluence publication record must not be a symbolic link: ${normalized}`);
    const real = realpathSync(absolute);
    if (real !== activeRoot && !real.startsWith(`${activeRoot}/`)) {
      throw new Error(`Confluence publication record escapes .project-context/active: ${normalized}`);
    }
    const content = readFileSync(real, 'utf8');
    const bytes = Buffer.byteLength(content);
    totalBytes += bytes;
    if (totalBytes > 512 * 1024) throw new Error('Confluence publication exceeds the 512 KiB record limit.');
    const secretHits = scanSecrets(normalized, content);
    if (secretHits.length > 0) {
      throw new Error(`Confluence publication record failed secret scanning: ${normalized}:${secretHits[0]!.line}`);
    }
    return {
      path: normalized,
      sha256: sha256(content),
      bytes,
      title: recordTitle(content, basename(normalized, '.md')),
    };
  });
}

function renderRecordsForConfluence(records: RecordSnapshot[]): string {
  const sections = records.map((record) => {
    const content = readFileSync(resolve(repoPaths().root, record.path), 'utf8');
    return [
      `<h2>${escapeXml(record.title)}</h2>`,
      `<p><small>Source: ${escapeXml(record.path)} · SHA-256: ${record.sha256}</small></p>`,
      `<pre>${escapeXml(content)}</pre>`,
    ].join('\n');
  });
  return [
    '<p><em>Managed by Vincenzo Project Context. Update through a confirmed publication plan.</em></p>',
    ...sections,
  ].join('\n');
}

function recordTitle(content: string, fallback: string): string {
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  return heading || fallback;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function planDirectory(): string {
  return resolve(repoPaths().draftsDir, 'confluence-publish');
}

function planPath(planDigest: string): string {
  return resolve(planDirectory(), `${planDigest}.json`);
}

function writePlan(plan: ConfluencePublishPlan): void {
  mkdirSync(planDirectory(), { recursive: true });
  const path = planPath(plan.planDigest);
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(plan, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(temporary, path);
}

function readPlan(planDigest: string): ConfluencePublishPlan {
  const path = planPath(planDigest);
  if (!existsSync(path)) throw new Error(`Confluence publish plan not found: ${planDigest}`);
  if (lstatSync(path).isSymbolicLink()) throw new Error('Confluence publish plan must not be a symbolic link.');
  return JSON.parse(readFileSync(path, 'utf8')) as ConfluencePublishPlan;
}

function unsignedPlan(plan: ConfluencePublishPlan) {
  return {
    schemaVersion: plan.schemaVersion,
    status: 'planned' as const,
    createdAt: plan.createdAt,
    baseUrl: plan.baseUrl,
    rootPageId: plan.rootPageId,
    includeRoot: plan.includeRoot,
    operation: plan.operation,
    targetPageId: plan.targetPageId,
    parentPageId: plan.parentPageId,
    title: plan.title,
    expectedVersion: plan.expectedVersion,
    expectedRemoteContentSha256: plan.expectedRemoteContentSha256,
    records: plan.records,
    proposedStorageSha256: plan.proposedStorageSha256,
    storageValue: plan.storageValue,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
