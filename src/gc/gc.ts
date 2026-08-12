import { mkdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';
import { moveToArchive, readRecords } from '../storage/markdown.js';
import { loadProjectConfig, retentionNumber } from '../storage/config.js';
import { gitIgnoredPaths, repoPaths, relPath } from '../storage/repo.js';
import { daysOld, durationToDays } from '../storage/time.js';
import { segmentForRecordType } from '../storage/record-types.js';
import { classifyFileReference } from '../storage/file-references.js';

export type GcCandidate = {
  id: string;
  path: string;
  action: 'archive' | 'trash';
  reason: string;
};

export type GcResult = { candidates: GcCandidate[]; critical: string[] };

export type GcReport = {
  candidateCount: number;
  candidates: GcCandidate[];
  truncated: boolean;
  critical: string[];
};

export function proposeCleanup(ci = false): GcResult {
  const records = readRecords(false);
  const referenceKinds = new Map(
    [...new Set(records.flatMap((record) => record.files))]
      .map((file) => [file, classifyFileReference(file).kind] as const),
  );
  const ignoredMissingReferences = gitIgnoredPaths(
    [...referenceKinds]
      .filter(([, kind]) => kind === 'missing')
      .map(([file]) => file),
  );
  const config = loadProjectConfig();
  const draftDays = retentionNumber(config, 'drafts', 'archive_after_days', 14);
  const completedTaskDays = retentionNumber(config, 'completed_tasks', 'archive_after_days', 180);
  const closedBugDays = retentionNumber(config, 'closed_bugs', 'archive_after_days', 180);
  const refactorDays = retentionNumber(config, 'refactors', 'archive_after_days', 180);
  const runSummaryDays = retentionNumber(config, 'run_summaries', 'archive_after_days', 30);
  const verificationDays = retentionNumber(config, 'verification_evidence', 'archive_after_days', 30);
  const critical: string[] = [];
  const candidates: GcCandidate[] = [];
  for (const record of records) {
    for (const file of record.files) {
      const kind = referenceKinds.get(file) ?? classifyFileReference(file).kind;
      if (isActionableFileReferenceIssue(kind, file, ignoredMissingReferences)) {
        const message = `${record.id} references missing file ${file}`;
        if (ci && (record.status === 'active' || record.path.includes('/active/'))) critical.push(message);
      }
    }
    if (record.type === 'task' && record.path.includes('/active/') && record.status !== 'confirmed' && record.status !== 'in_progress' && record.status !== 'done') {
      critical.push(`${record.id} active task is not confirmed`);
    }
    if (record.type === 'decision' && record.path.includes('/active/') && !record.frontmatter.source_task && record.id !== 'MODULE-BACKEND') {
      critical.push(`${record.id} active decision has no source_task`);
    }
    if (record.path.includes('/drafts/') && daysOld(record.createdAt) >= draftDays) {
      candidates.push({ id: record.id, path: record.path, action: 'archive', reason: `Draft is older than ${draftDays} days.` });
    }
    const completedThreshold = record.type === 'task'
      ? completedTaskDays
      : record.type === 'bug'
        ? closedBugDays
        : record.type === 'refactor'
          ? refactorDays
          : undefined;
    if (completedThreshold !== undefined && record.status === 'done' && daysOld(record.updatedAt ?? record.createdAt) >= completedThreshold) {
      candidates.push({ id: record.id, path: record.path, action: 'archive', reason: 'Completed record is older than retention threshold.' });
    }
    if (record.type === 'run-summary' && record.status === 'reviewed' && daysOld(record.updatedAt ?? record.createdAt) >= runSummaryDays) {
      candidates.push({ id: record.id, path: record.path, action: 'archive', reason: `Reviewed run summary is older than ${runSummaryDays} days.` });
    }
    if (record.type === 'verification-evidence' && record.status === 'passed' && daysOld(record.updatedAt ?? record.createdAt) >= verificationDays) {
      candidates.push({ id: record.id, path: record.path, action: 'archive', reason: `Passed verification evidence is older than ${verificationDays} days.` });
    }
    if (record.type === 'decision' && record.status === 'superseded') {
      candidates.push({ id: record.id, path: record.path, action: 'archive', reason: 'Decision is superseded; decisions are archived, never deleted.' });
    }
  }
  return { candidates, critical };
}

export function isActionableFileReferenceIssue(
  kind: ReturnType<typeof classifyFileReference>['kind'],
  file: string,
  ignoredMissingReferences: ReadonlySet<string>,
): boolean {
  return kind !== 'file' && !(kind === 'missing' && ignoredMissingReferences.has(file));
}

export function compactCleanupResult(result: GcResult, limit = 5, verbose = false): GcReport {
  const normalizedLimit = Math.max(0, Math.floor(limit));
  const candidates = verbose ? result.candidates : result.candidates.slice(0, normalizedLimit);
  return {
    candidateCount: result.candidates.length,
    candidates,
    truncated: candidates.length < result.candidates.length,
    critical: result.critical,
  };
}

export function applyCleanup(): { archived: string[] } {
  const { candidates } = proposeCleanup(false);
  const records = new Map(readRecords(false).map((record) => [record.id, record]));
  const archived: string[] = [];
  for (const candidate of candidates) {
    const record = records.get(candidate.id);
    if (record) archived.push(moveToArchive(record));
  }
  return { archived };
}

export function archiveStale(olderThan: string): { archived: string[] } {
  const threshold = durationToDays(olderThan);
  const archived: string[] = [];
  for (const record of readRecords(false)) {
    if (record.type !== 'decision' && daysOld(record.updatedAt ?? record.createdAt) >= threshold) {
      archived.push(moveToArchive(record));
    }
  }
  return { archived };
}

export function archiveRecords(ids: string[]): { archived: string[]; missing: string[] } {
  const records = readRecords(false);
  const archived: string[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const record = records.find((item) => item.id === id);
    if (!record) {
      missing.push(id);
      continue;
    }
    archived.push(moveToArchive(record));
  }
  return { archived, missing };
}

export function restore(recordId: string): { restoredPath: string } {
  const paths = repoPaths();
  const archived = readRecords(true).find((record) => record.id === recordId && record.archived);
  if (!archived) throw new Error(`Archived record not found: ${recordId}`);
  const segment = segmentForRecordType(archived.type);
  const target = resolve(paths.activeDir, segment, `${archived.id}.md`);
  const archivedReference = classifyFileReference(archived.path);
  if (archivedReference.kind !== 'file') throw new Error(`Archived record path is unsafe or missing: ${archived.path}`);
  mkdirSync(resolve(paths.activeDir, segment), { recursive: true });
  renameSync(archivedReference.absolutePath, target);
  return { restoredPath: relPath(paths.root, target) };
}
