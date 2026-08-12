import { createHash } from 'node:crypto';
import { buildContextPack, type ContextPack } from './pack.js';
import { retrievePortalContext } from '../portal/bridge.js';
import type {
  PortalClient,
  PortalContextPack,
  PortalContextRetrievalInput,
} from '../portal/client.js';

export type UnifiedContextInput = PortalContextRetrievalInput & {
  taskId?: string;
  modules?: string[];
  files?: string[];
  changedFiles?: string[];
  includeLocal?: boolean;
};

export type UnifiedContextItem = {
  rank: number;
  authority: string;
  channel: 'portal-full-text' | 'portal-vector-exact' | 'portal-hybrid' | 'local-project-context';
  sourceId: string;
  revisionId?: string | null;
  contentDigest: string;
  excerpt: string;
  tokenCount: number;
  reason: string;
  mandatory: boolean;
  pinned: boolean;
  stale: boolean;
  truncated: boolean;
  conflictMarkers: string[];
};

type Dependencies = {
  client?: PortalClient;
  localBuilder?: (input: Parameters<typeof buildContextPack>[0]) => ContextPack;
};

export async function buildUnifiedContextPack(
  input: UnifiedContextInput,
  dependencies: Dependencies = {},
): Promise<{
  authority: 'unified';
  projectId: string;
  contextSessionId: string;
  digest: string;
  maximumTokens: number;
  actualTokens: number;
  truncated: boolean;
  items: UnifiedContextItem[];
  droppedItems: Array<{ sourceId: string; authority: string; reason: string }>;
  unknowns: string[];
  allocations: { portalTokens: number; localTokens: number };
}> {
  const maximumTokens = clamp(input.maximumTokens, 500, 128_000);
  const portalBudget = Math.max(64, Math.floor(maximumTokens * 0.7));
  const {
    taskId,
    modules,
    files,
    changedFiles,
    includeLocal,
    ...portalInput
  } = input;
  const portal = await retrievePortalContext({
    ...portalInput,
    maximumTokens: portalBudget,
  }, { client: dependencies.client });
  const portalPack = portal.contextPack;
  const shouldIncludeLocal = includeLocal ?? true;
  const localBudget = shouldIncludeLocal ? Math.max(0, maximumTokens - portalPack.actualTokens) : 0;
  const local = shouldIncludeLocal && localBudget > 0
    ? (dependencies.localBuilder ?? buildContextPack)({
        query: `${input.intent} ${input.query}`.trim(),
        taskId,
        maxTokens: Math.max(500, localBudget),
        modules,
        files,
        changedFiles,
        workflow: localBudget < 1_500 ? 'fast' : 'standard',
        explain: true,
      })
    : undefined;

  const items = portalItems(portalPack);
  const droppedItems = portalPack.droppedItems.map((value) => ({
    sourceId: value.chunkId,
    authority: 'PORTAL',
    reason: value.reason,
  }));
  let remaining = localBudget;
  let localTokens = 0;
  for (const candidate of localCandidates(local)) {
    if (remaining <= 0) {
      droppedItems.push({
        sourceId: candidate.sourceId,
        authority: 'LOCAL_PROJECT_CONTEXT',
        reason: 'shared token budget',
      });
      continue;
    }
    const fitted = fitExcerpt(candidate.excerpt, remaining);
    if (!fitted.excerpt) {
      droppedItems.push({
        sourceId: candidate.sourceId,
        authority: 'LOCAL_PROJECT_CONTEXT',
        reason: 'shared token budget',
      });
      continue;
    }
    items.push({
      ...candidate,
      excerpt: fitted.excerpt,
      tokenCount: fitted.tokens,
      truncated: fitted.truncated,
    });
    remaining -= fitted.tokens;
    localTokens += fitted.tokens;
    if (fitted.truncated) {
      droppedItems.push({
        sourceId: candidate.sourceId,
        authority: 'LOCAL_PROJECT_CONTEXT',
        reason: 'item truncated to shared token budget',
      });
    }
  }
  const ranked = items.map((value, index) => ({ ...value, rank: index + 1 }));
  const actualTokens = portalPack.actualTokens + localTokens;
  const unknowns = [
    ...portalPack.unknowns,
    ...(local?.warnings ?? []).map((value) => `Local context: ${value}`),
  ];
  const digest = createHash('sha256')
    .update(ranked.map((value) => (
      `${value.rank}:${value.authority}:${value.sourceId}:${value.revisionId ?? ''}:${value.contentDigest}:${value.tokenCount}\n`
    )).join(''))
    .digest('hex');
  return {
    authority: 'unified',
    projectId: portal.projectId,
    contextSessionId: portalPack.contextSessionId,
    digest,
    maximumTokens,
    actualTokens,
    truncated: portalPack.truncated || droppedItems.length > 0,
    items: ranked,
    droppedItems,
    unknowns,
    allocations: {
      portalTokens: portalPack.actualTokens,
      localTokens,
    },
  };
}

function portalItems(pack: PortalContextPack): UnifiedContextItem[] {
  return pack.items.map((value) => ({
    rank: value.rank,
    authority: value.authority,
    channel: (value.retrievalChannels ?? []).includes('vector-exact')
      ? (value.retrievalChannels ?? []).includes('full-text') ? 'portal-hybrid' : 'portal-vector-exact'
      : 'portal-full-text',
    sourceId: value.chunkId,
    revisionId: value.revisionId,
    contentDigest: value.contentDigest,
    excerpt: value.excerpt,
    tokenCount: value.tokenCount,
    reason: value.reason,
    mandatory: value.mandatory,
    pinned: value.pinned,
    stale: value.stale,
    truncated: value.truncated,
    conflictMarkers: value.conflictMarkers,
  }));
}

function localCandidates(pack: ContextPack | undefined): UnifiedContextItem[] {
  if (!pack) return [];
  return [
    ...pack.records.map((value) => localItem(value.id, value.path, value.reason, value.excerpt)),
    ...pack.files.map((value) => localItem(value.path, value.path, value.reason, value.excerpt)),
  ];
}

function localItem(sourceId: string, path: string, reason: string, excerpt = ''): UnifiedContextItem {
  return {
    rank: 0,
    authority: 'LOCAL_PROJECT_CONTEXT',
    channel: 'local-project-context',
    sourceId,
    revisionId: null,
    contentDigest: createHash('sha256').update(`${path}\n${excerpt}`).digest('hex'),
    excerpt,
    tokenCount: estimateTokens(excerpt),
    reason,
    mandatory: false,
    pinned: false,
    stale: false,
    truncated: false,
    conflictMarkers: [],
  };
}

function fitExcerpt(value: string, maximumTokens: number): {
  excerpt: string;
  tokens: number;
  truncated: boolean;
} {
  if (!value || maximumTokens <= 0) return { excerpt: '', tokens: 0, truncated: false };
  if (estimateTokens(value) <= maximumTokens) {
    return { excerpt: value, tokens: estimateTokens(value), truncated: false };
  }
  const maximumCharacters = Math.max(0, maximumTokens * 4 - 1);
  if (maximumCharacters < 1) return { excerpt: '', tokens: 0, truncated: true };
  const excerpt = `${value.slice(0, maximumCharacters).trimEnd()}…`;
  return { excerpt, tokens: estimateTokens(excerpt), truncated: true };
}

function estimateTokens(value: string): number {
  return value ? Math.max(1, Math.ceil(value.length / 4)) : 0;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
