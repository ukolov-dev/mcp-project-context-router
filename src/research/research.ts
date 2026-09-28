import { createHash } from 'node:crypto';
import { z } from 'zod';
import { proposeBacklogItem } from '../backlog/backlog.js';
import { nextRecordId, readRecords } from '../storage/markdown.js';
import { nowIso } from '../storage/time.js';
import { readResearch, researchPath, saveResearch, withResearchLock } from './store.js';
import {
  appendResearchInputSchema, createResearchInputSchema, getResearchInputSchema,
  listResearchInputSchema, researchToBacklogInputSchema, transitionResearchInputSchema,
  type ResearchEntry, type ResearchRecord, type ResearchStatus,
} from './types.js';

function view(record: ResearchRecord) {
  const ids = new Set(record.entries.flatMap((entry) => entry.backlog_id ? [entry.backlog_id] : []));
  const backlog = readRecords(true).filter((item) => item.type === 'backlog' && ids.has(item.id));
  return {
    ...record,
    path: researchPath(record.id),
    linkedBacklog: [...ids].map((id) => {
      const item = backlog.find((candidate) => candidate.id === id && candidate.path.includes('/active/'))
        ?? backlog.find((candidate) => candidate.id === id && candidate.path.includes('/drafts/'))
        ?? backlog.find((candidate) => candidate.id === id);
      return { id, status: item?.status ?? 'missing', path: item?.path ?? null };
    }),
  };
}
export function getResearch(input: z.input<typeof getResearchInputSchema>) {
  return view(readResearch(getResearchInputSchema.parse(input).researchId));
}
export function listResearch(input: z.input<typeof listResearchInputSchema> = {}) {
  const parsed = listResearchInputSchema.parse(input);
  const query = parsed.query.toLowerCase().trim();
  const matches = readRecords(false)
    .filter((record) => record.type === 'research' && record.path.startsWith('.project-context/active/research/'))
    .map((record) => readResearch(record.id))
    .filter((record) => parsed.statuses.length ? parsed.statuses.includes(record.status) : parsed.includeClosed || record.status !== 'closed')
    .filter((record) => !parsed.modules.length || record.modules.some((module) => parsed.modules.includes(module)))
    .filter((record) => !query || JSON.stringify(record).toLowerCase().includes(query))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return {
    items: matches.slice(0, parsed.limit).map((record) => {
      const { entries, ...summary } = view(record);
      return { ...summary, entryCount: entries.length, lastEntry: entries.at(-1) };
    }),
    count: Math.min(matches.length, parsed.limit),
    total: matches.length,
  };
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function append(record: ResearchRecord, entry: Omit<ResearchEntry, 'at' | 'sequence'>): void {
  record.updated_at = nowIso();
  record.revision += 1;
  record.entries.push({ ...entry, at: record.updated_at, sequence: record.revision });
  record.source_refs = [...new Set([...record.source_refs, ...entry.source_refs])];
  saveResearch(record);
}
function replay(record: ResearchRecord, key: string, digest: string): boolean {
  const existing = record.entries.find((entry) => entry.request_key === key);
  if (!existing) return false;
  if (existing.request_hash !== digest) throw new Error('Request key already used with different content. Use a new requestKey.');
  return true;
}
function checkRevision(record: ResearchRecord, revision: number): void {
  if (record.revision !== revision) throw new Error(`Research revision conflict: expected ${revision}, current ${record.revision}. Reload research before editing.`);
}
export function createResearch(input: z.input<typeof createResearchInputSchema>) {
  const parsed = createResearchInputSchema.parse(input);
  return withResearchLock(() => {
    const at = nowIso();
    const record: ResearchRecord = {
      id: nextRecordId('RESEARCH'), type: 'research', title: parsed.title, question: parsed.question,
      status: 'idea', conclusion: '', open_questions: parsed.openQuestions, revision: 1,
      created_at: at, updated_at: at, modules: parsed.modules, files: [], tags: [...new Set([...parsed.tags, 'research'])],
      source_refs: parsed.sourceRefs, retention: 'keep',
      entries: [{ sequence: 1, at, kind: 'idea', content: parsed.question, source_refs: parsed.sourceRefs,
        request_key: 'created', request_hash: hash(parsed), to: 'idea', open_questions: parsed.openQuestions }],
    };
    saveResearch(record);
    return view(record);
  });
}
export function appendResearchEntry(input: z.input<typeof appendResearchInputSchema>) {
  const parsed = appendResearchInputSchema.parse(input);
  return withResearchLock(() => {
    const record = readResearch(parsed.researchId);
    const { expectedRevision, ...payload } = parsed;
    const digest = hash({ operation: 'append', ...payload });
    if (replay(record, parsed.requestKey, digest)) return view(record);
    checkRevision(record, expectedRevision);
    if (record.status !== 'idea' && record.status !== 'exploring') throw new Error('Resume research in exploring status before appending findings.');
    if (parsed.openQuestions !== undefined) record.open_questions = parsed.openQuestions;
    append(record, { kind: parsed.kind, content: parsed.content, source_refs: parsed.sourceRefs,
      request_key: parsed.requestKey, request_hash: digest,
      ...(parsed.openQuestions !== undefined ? { open_questions: parsed.openQuestions } : {}) });
    return view(record);
  });
}
const transitions: Record<ResearchStatus, readonly ResearchStatus[]> = {
  idea: ['exploring', 'paused', 'closed'],
  exploring: ['paused', 'ready', 'closed'],
  paused: ['exploring', 'closed'],
  ready: ['exploring', 'paused', 'closed'],
  handed_off: ['exploring', 'closed'],
  closed: ['exploring'],
};
export function transitionResearch(input: z.input<typeof transitionResearchInputSchema>) {
  const parsed = transitionResearchInputSchema.parse(input);
  return withResearchLock(() => {
    const record = readResearch(parsed.researchId);
    const { expectedRevision, ...payload } = parsed;
    const digest = hash({ operation: 'transition', ...payload });
    if (replay(record, parsed.requestKey, digest)) return view(record);
    checkRevision(record, expectedRevision);
    if (!transitions[record.status].includes(parsed.status)) throw new Error(`Invalid research transition: ${record.status} → ${parsed.status}`);
    if (parsed.status === 'ready' && (!parsed.conclusion || record.open_questions.length)) {
      throw new Error('Ready research requires a conclusion and resolved open questions. Record remaining limitations in the conclusion.');
    }
    const from = record.status;
    record.status = parsed.status;
    if (parsed.status === 'exploring') record.conclusion = '';
    else if (parsed.conclusion) record.conclusion = parsed.conclusion;
    append(record, { kind: 'status', content: parsed.reason, source_refs: [], request_key: parsed.requestKey,
      request_hash: digest, from, to: parsed.status, conclusion: record.conclusion });
    return view(record);
  });
}
export function researchToBacklog(input: z.input<typeof researchToBacklogInputSchema>) {
  const parsed = researchToBacklogInputSchema.parse(input);
  const action = () => {
    const record = readResearch(parsed.researchId);
    const digest = hash({ operation: 'handoff', researchId: parsed.researchId, item: parsed.item });
    if (replay(record, parsed.requestKey, digest)) {
      return { status: 'ALREADY_LINKED', backlogId: record.entries.find((entry) => entry.request_key === parsed.requestKey)!.backlog_id, research: view(record) };
    }
    checkRevision(record, parsed.expectedRevision);
    if (!['ready', 'handed_off'].includes(record.status) || !record.conclusion) throw new Error('Research must be ready with a conclusion before backlog handoff.');
    // Keep a stable source marker in the backlog write itself, so a retry can recover
    // even if the process stops before publishing the research history update.
    const marker = `research-handoff:${record.id}:${parsed.requestKey}`;
    const fingerprint = `${marker}:${digest}`;
    const recovered = readRecords(true).filter((item) => item.type === 'backlog'
      && Array.isArray(item.frontmatter.source_refs)
      && item.frontmatter.source_refs.some((ref) => typeof ref === 'string' && ref.startsWith(`${marker}:`)));
    if (recovered.some((item) => !(item.frontmatter.source_refs as string[]).includes(fingerprint))) {
      throw new Error('Handoff request key already used with different content.');
    }
    const proposal = recovered.length ? null : proposeBacklogItem({
      ...parsed.item, description: `${parsed.item.description}\n\nResearch conclusion (${record.id}):\n${record.conclusion}`.trim(),
      modules: parsed.item.modules ?? record.modules,
      sourceRefs: [...new Set([...parsed.item.sourceRefs, record.id, researchPath(record.id), fingerprint])],
      status: 'proposed', force: false, dryRun: parsed.dryRun,
    });
    if (parsed.dryRun || proposal?.status === 'DUPLICATE_OR_RELATED') {
      return { status: proposal?.status ?? 'DRY_RUN', proposal, research: view(record) };
    }
    const backlogId = recovered[0]?.id ?? proposal!.backlogId;
    const from = record.status;
    record.status = 'handed_off';
    append(record, { kind: 'handoff', content: `Proposed backlog item: ${parsed.item.title}`, source_refs: [],
      request_key: parsed.requestKey, request_hash: digest, from, to: 'handed_off', backlog_id: backlogId });
    return { status: 'PROPOSED', backlogId, proposal, research: view(record) };
  };
  return parsed.dryRun ? action() : withResearchLock(action);
}
