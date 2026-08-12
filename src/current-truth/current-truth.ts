import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { discoverRecordFiles, moveToArchive, readRecords } from '../storage/markdown.js';
import { loadProjectConfig, retentionNumber } from '../storage/config.js';
import { segmentForRecordType } from '../storage/record-types.js';
import { daysOld } from '../storage/time.js';
import type { ContextRecord } from '../storage/types.js';

export const currentTruthInputSchema = z.object({
  apply: z.boolean().default(false),
  approvedBy: z.string().optional(),
  archiveAttention: z.boolean().default(false),
  allAttention: z.boolean().default(false),
  recordIds: z.array(z.string()).default([]),
  attentionTypes: z.array(z.string()).default([]),
  attentionStatuses: z.array(z.string()).default([]),
  attentionMinAgeDays: z.number().int().nonnegative().optional(),
  doneTaskDays: z.number().int().nonnegative().optional(),
  historyDays: z.number().int().nonnegative().optional(),
  staleWorkDays: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(500).default(50),
});

type ParsedCurrentTruthInput = z.infer<typeof currentTruthInputSchema>;
type CurrentTruthInput = Omit<ParsedCurrentTruthInput, 'doneTaskDays' | 'historyDays' | 'staleWorkDays'> & {
  doneTaskDays: number;
  historyDays: number;
  staleWorkDays: number;
  verificationDays: number;
  refactorDays: number;
};

export type CurrentTruthCandidate = {
  id: string;
  type: string;
  status: string;
  title: string;
  path: string;
  ageDays: number;
  reason: string;
  layer: ContextLayer;
};

export type CurrentTruthResult = {
  status: 'DRY_RUN' | 'APPLIED';
  apply: boolean;
  policy: {
    doneTaskDays: number;
      historyDays: number;
      staleWorkDays: number;
      verificationDays: number;
      refactorDays: number;
    autoArchiveRules: string[];
    attentionRules: string[];
    protectedTypes: string[];
  };
  summary: {
    activeRecords: number;
    currentTruthRecords: number;
    workflowHistoryRecords: number;
    analystRecords: number;
    protectedRecords: number;
    safeArchiveCandidates: number;
    attentionCandidates: number;
    attentionArchiveCandidates: number;
    returnedCandidateLimit: number;
    archived: number;
    attentionArchived: number;
    referenceRewrites: number;
  };
  countsByLayer: Record<ContextLayer, number>;
  countsByTypeStatus: Record<string, number>;
  safeArchiveCandidates: CurrentTruthCandidate[];
  attentionCandidates: CurrentTruthCandidate[];
  selectedAttentionArchiveCandidates: CurrentTruthCandidate[];
  archived: string[];
  warnings: string[];
};

type ContextLayer = 'current_truth' | 'workflow_history' | 'analyst_workbench' | 'protected_reference';

const analystTypes = new Set([
  'source',
  'source_chunk',
  'requirement',
  'acceptance_check',
  'open_question',
]);

const protectedTypes = new Set([
  'api',
  'backlog',
  'data_entity',
  'decision',
  'integration',
  'module',
  'pattern',
  'project',
  'runbook',
]);

export function currentTruthAudit(input: z.input<typeof currentTruthInputSchema> = {}): CurrentTruthResult {
  const parsed = resolveCurrentTruthInput(currentTruthInputSchema.parse(input));
  if (parsed.apply && !parsed.approvedBy?.trim()) {
    throw new Error('--approved-by is required when --apply is used.');
  }
  if (parsed.archiveAttention && !hasAttentionSelector(parsed)) {
    throw new Error('--archive-attention requires an explicit selector: --record-ids, --attention-types, --attention-statuses, --attention-min-age-days, or --all-attention.');
  }

  const activeRecords = readRecords(false).filter((record) => record.path.includes('/active/'));
  const incomingReferences = buildIncomingReferences(activeRecords);
  const countsByLayer = emptyLayerCounts();
  const countsByTypeStatus: Record<string, number> = {};
  const safeCandidates: CurrentTruthCandidate[] = [];
  const attentionCandidates: CurrentTruthCandidate[] = [];

  for (const record of activeRecords) {
    const layer = classifyLayer(record);
    countsByLayer[layer] += 1;
    const key = `${record.type}|${record.status}`;
    countsByTypeStatus[key] = (countsByTypeStatus[key] ?? 0) + 1;

    const safeReason = safeArchiveReason(record, parsed);
    if (safeReason) {
      const activeReferrers = (incomingReferences.get(record.path) ?? []).filter((id) => id !== record.id);
      if (activeReferrers.length > 0) {
        attentionCandidates.push(toCandidate(
          record,
          layer,
          `Safe archival skipped because active records still reference this path: ${activeReferrers.slice(0, 5).join(', ')}${activeReferrers.length > 5 ? ', ...' : ''}.`,
        ));
        continue;
      }
      safeCandidates.push(toCandidate(record, layer, safeReason));
      continue;
    }

    const attentionReason = attentionReasonFor(record, parsed);
    if (attentionReason) {
      attentionCandidates.push(toCandidate(record, layer, attentionReason));
    }
  }

  safeCandidates.sort(compareCandidates);
  attentionCandidates.sort(compareCandidates);
  const selectedAttentionCandidates = wantsAttentionSelection(parsed)
    ? selectAttentionArchiveCandidates(attentionCandidates, parsed)
    : [];

  const archived: string[] = [];
  const archivedPathMap = new Map<string, string>();
  let attentionArchived = 0;
  if (parsed.apply) {
    const recordsById = new Map(activeRecords.map((record) => [record.id, record]));
    const archivedIds = new Set<string>();
    const archiveCandidate = (candidate: CurrentTruthCandidate, source: 'safe' | 'attention'): void => {
      if (archivedIds.has(candidate.id)) return;
      const record = recordsById.get(candidate.id);
      if (record) {
        const archivedPath = moveToArchive(record);
        archived.push(archivedPath);
        archivedPathMap.set(record.path, archivedPath);
        archivedIds.add(candidate.id);
        if (source === 'attention') {
          attentionArchived += 1;
        }
      }
    };
    for (const candidate of safeCandidates) {
      archiveCandidate(candidate, 'safe');
    }
    if (parsed.archiveAttention) {
      for (const candidate of selectedAttentionCandidates) {
        archiveCandidate(candidate, 'attention');
      }
    }
  }
  const referenceRewrites = parsed.apply ? repairArchivedRecordReferences(archivedPathMap) : 0;

  return {
    status: parsed.apply ? 'APPLIED' : 'DRY_RUN',
    apply: parsed.apply,
    policy: {
      doneTaskDays: parsed.doneTaskDays,
      historyDays: parsed.historyDays,
      staleWorkDays: parsed.staleWorkDays,
      verificationDays: parsed.verificationDays,
      refactorDays: parsed.refactorDays,
      autoArchiveRules: [
        `task:done older than ${parsed.doneTaskDays} days`,
        `run-summary:reviewed older than ${parsed.historyDays} days`,
        `verification-evidence:passed older than ${parsed.verificationDays} days`,
      ],
      attentionRules: [
        `task:confirmed or task:in_progress older than ${parsed.staleWorkDays} days`,
        `verification-evidence:failed older than ${parsed.verificationDays} days`,
        `refactor:proposed older than ${parsed.refactorDays} days`,
      ],
      protectedTypes: [...analystTypes, ...protectedTypes].sort(),
    },
    summary: {
      activeRecords: activeRecords.length,
      currentTruthRecords: countsByLayer.current_truth,
      workflowHistoryRecords: countsByLayer.workflow_history,
      analystRecords: countsByLayer.analyst_workbench,
      protectedRecords: countsByLayer.protected_reference,
      safeArchiveCandidates: safeCandidates.length,
      attentionCandidates: attentionCandidates.length,
      attentionArchiveCandidates: selectedAttentionCandidates.length,
      returnedCandidateLimit: parsed.limit,
      archived: archived.length,
      attentionArchived,
      referenceRewrites,
    },
    countsByLayer,
    countsByTypeStatus: Object.fromEntries(Object.entries(countsByTypeStatus).sort(([left], [right]) => left.localeCompare(right))),
    safeArchiveCandidates: safeCandidates.slice(0, parsed.limit),
    attentionCandidates: attentionCandidates.slice(0, parsed.limit),
    selectedAttentionArchiveCandidates: selectedAttentionCandidates.slice(0, parsed.limit),
    archived: archived.slice(0, parsed.limit),
    warnings: resultWarnings(parsed, safeCandidates.length, attentionCandidates.length, selectedAttentionCandidates.length, archived.length),
  };
}

function safeArchiveReason(record: ContextRecord, input: CurrentTruthInput): string | null {
  if (record.retention === 'keep') return null;
  const age = recordAgeDays(record);
  if (record.type === 'task' && record.status === 'done' && age >= input.doneTaskDays) {
    return `Completed task is ${age} days old and no longer belongs in default active context.`;
  }
  if (record.type === 'run-summary' && record.status === 'reviewed' && age >= input.historyDays) {
    return `Reviewed run summary is ${age} days old; history remains available from archive.`;
  }
  if (record.type === 'verification-evidence' && record.status === 'passed' && age >= input.verificationDays) {
    return `Passed verification evidence is ${age} days old; history remains available from archive.`;
  }
  return null;
}

function attentionReasonFor(record: ContextRecord, input: CurrentTruthInput): string | null {
  const age = recordAgeDays(record);
  if (record.type === 'task' && (record.status === 'confirmed' || record.status === 'in_progress') && age >= input.staleWorkDays) {
    return `Active work contract is ${age} days old; confirm whether it is still current, done, or should be archived.`;
  }
  if (record.type === 'verification-evidence' && record.status === 'failed' && age >= input.verificationDays) {
    return `Failed verification evidence is ${age} days old; keep active only if it is still a current risk.`;
  }
  if (record.type === 'refactor' && record.status === 'proposed' && age >= input.refactorDays) {
    return `Proposed refactor is ${age} days old; convert to backlog/current work or archive after review.`;
  }
  return null;
}

function resolveCurrentTruthInput(input: ParsedCurrentTruthInput): CurrentTruthInput {
  const config = loadProjectConfig();
  const historyOverride = input.historyDays;
  return {
    ...input,
    doneTaskDays: input.doneTaskDays ?? retentionNumber(config, 'completed_tasks', 'archive_after_days', 180),
    historyDays: historyOverride ?? retentionNumber(config, 'run_summaries', 'archive_after_days', 30),
    staleWorkDays: input.staleWorkDays ?? retentionNumber(config, 'active_work', 'attention_after_days', 14),
    verificationDays: historyOverride ?? retentionNumber(config, 'verification_evidence', 'archive_after_days', 30),
    refactorDays: historyOverride ?? retentionNumber(config, 'refactors', 'archive_after_days', 180),
  };
}

function classifyLayer(record: ContextRecord): ContextLayer {
  if (analystTypes.has(record.type)) return 'analyst_workbench';
  if (protectedTypes.has(record.type)) return 'protected_reference';
  if (record.type === 'task' && record.status !== 'done') return 'current_truth';
  if (record.type === 'verification-evidence' || record.type === 'run-summary' || record.type === 'refactor') return 'workflow_history';
  if (record.type === 'task' && record.status === 'done') return 'workflow_history';
  return 'current_truth';
}

function toCandidate(record: ContextRecord, layer: ContextLayer, reason: string): CurrentTruthCandidate {
  return {
    id: record.id,
    type: record.type,
    status: record.status,
    title: record.title,
    path: record.path,
    ageDays: recordAgeDays(record),
    reason,
    layer,
  };
}

function recordAgeDays(record: ContextRecord): number {
  return daysOld(record.updatedAt ?? record.createdAt);
}

function compareCandidates(left: CurrentTruthCandidate, right: CurrentTruthCandidate): number {
  return right.ageDays - left.ageDays || left.type.localeCompare(right.type) || left.id.localeCompare(right.id);
}

function wantsAttentionSelection(input: CurrentTruthInput): boolean {
  return input.archiveAttention || hasAttentionSelector(input);
}

function hasAttentionSelector(input: CurrentTruthInput): boolean {
  return input.allAttention
    || input.recordIds.length > 0
    || input.attentionTypes.length > 0
    || input.attentionStatuses.length > 0
    || input.attentionMinAgeDays !== undefined;
}

function selectAttentionArchiveCandidates(
  candidates: CurrentTruthCandidate[],
  input: CurrentTruthInput,
): CurrentTruthCandidate[] {
  const ids = normalizedSet(input.recordIds);
  const types = normalizedSet(input.attentionTypes);
  const statuses = normalizedSet(input.attentionStatuses);
  return candidates.filter((candidate) => {
    if (ids.size > 0 && !ids.has(candidate.id.toLowerCase())) return false;
    if (types.size > 0 && !types.has(candidate.type.toLowerCase())) return false;
    if (statuses.size > 0 && !statuses.has(candidate.status.toLowerCase())) return false;
    if (input.attentionMinAgeDays !== undefined && candidate.ageDays < input.attentionMinAgeDays) return false;
    return input.allAttention || ids.size > 0 || types.size > 0 || statuses.size > 0 || input.attentionMinAgeDays !== undefined;
  });
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function buildIncomingReferences(records: ContextRecord[]): Map<string, string[]> {
  const incoming = new Map<string, string[]>();
  for (const record of records) {
    for (const file of record.files) {
      if (!file.startsWith('.project-context/active/')) continue;
      const existing = incoming.get(file) ?? [];
      existing.push(record.id);
      incoming.set(file, existing);
    }
  }
  return incoming;
}

function repairArchivedRecordReferences(additionalPathMap: Map<string, string>): number {
  const pathMap = new Map(additionalPathMap);
  for (const record of readRecords(true)) {
    if (!record.archived) continue;
    const activePath = `.project-context/active/${segmentForRecordType(record.type)}/${record.id}.md`;
    pathMap.set(activePath, record.path);
  }

  let rewrites = 0;
  for (const file of discoverRecordFiles(true)) {
    const raw = readFileSync(file, 'utf8');
    let updated = raw;
    for (const [oldPath, newPath] of pathMap) {
      if (!updated.includes(oldPath)) continue;
      const before = updated;
      updated = updated.split(oldPath).join(newPath);
      rewrites += countOccurrences(before, oldPath);
    }
    if (updated !== raw) {
      writeFileSync(file, updated, 'utf8');
    }
  }
  return rewrites;
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

function emptyLayerCounts(): Record<ContextLayer, number> {
  return {
    current_truth: 0,
    workflow_history: 0,
    analyst_workbench: 0,
    protected_reference: 0,
  };
}

function resultWarnings(
  input: CurrentTruthInput,
  safeCount: number,
  attentionCount: number,
  attentionArchiveCount: number,
  archivedCount: number,
): string[] {
  const warnings: string[] = [];
  if (!input.apply && safeCount > 0) {
    warnings.push('Dry-run only. Review safeArchiveCandidates, then rerun with --apply --approved-by <name> to archive them.');
  }
  if (attentionCount > 0) {
    warnings.push('Attention candidates are not archived by the safe policy. Use explicit attention selectors plus --archive-attention for reviewed cleanup.');
  }
  if (attentionArchiveCount > 0 && !input.apply) {
    warnings.push('Dry-run only. Review selectedAttentionArchiveCandidates, then rerun with --archive-attention --apply --approved-by <name> to archive that selection.');
  }
  if (input.apply && input.archiveAttention && attentionArchiveCount === 0) {
    warnings.push('No attention candidates matched the explicit attention archive selectors.');
  }
  if (input.apply && archivedCount > input.limit) {
    warnings.push('Returned archived paths are limited by --limit; archive operation still processed all selected candidates.');
  }
  return warnings;
}
