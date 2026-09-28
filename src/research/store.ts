import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyFileReference } from '../storage/file-references.js';
import { parseRecord, renderMarkdown } from '../storage/markdown.js';
import { researchIdSchema, researchRecordSchema, type ResearchRecord } from './types.js';

function checkedPath(relative: string): string {
  const ref = classifyFileReference(relative);
  if (ref.kind !== 'file' && ref.kind !== 'missing') throw new Error(`Invalid research storage path: ${relative}`);
  return ref.absolutePath;
}
export function researchPath(id: string): string {
  return `.project-context/active/research/${researchIdSchema.parse(id)}.md`;
}
export function readResearch(id: string): ResearchRecord {
  const path = checkedPath(researchPath(id));
  if (!existsSync(path)) throw new Error(`Research not found: ${id}`);
  const record = researchRecordSchema.parse(parseRecord(path).frontmatter);
  if (record.id !== id) throw new Error('Research identity mismatch.');
  if (record.entries.length !== record.revision || record.entries.some((entry, i) => entry.sequence !== i + 1)) {
    throw new Error('Research history/revision mismatch.');
  }
  return record;
}
export function withResearchLock<T>(action: () => T): T {
  const path = checkedPath('.project-context/active/research/.research.lock');
  mkdirSync(resolve(path, '..'), { recursive: true });
  let fd: number;
  try { fd = openSync(path, 'wx'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Research storage is busy; retry after the current writer finishes.');
    throw error;
  }
  try { return action(); }
  finally { closeSync(fd); unlinkSync(path); }
}
export function saveResearch(record: ResearchRecord): void {
  researchRecordSchema.parse(record);
  const path = checkedPath(researchPath(record.id));
  const temporary = checkedPath(`.project-context/active/research/.${record.id}.${randomUUID()}.tmp`);
  const list = (items: string[]) => items.length ? items.map((item) => `- ${item}`).join('\n') : 'None.';
  const history = record.entries.map((entry) =>
    `## ${entry.sequence}. ${entry.kind} — ${entry.at}\n\n${entry.content}`
    + (entry.to ? `\n\nStatus: ${entry.from ?? 'new'} → ${entry.to}` : '')
    + (entry.conclusion ? `\n\nConclusion: ${entry.conclusion}` : '')
    + (entry.open_questions ? `\n\nOpen questions:\n${list(entry.open_questions)}` : '')
    + (entry.backlog_id ? `\n\nBacklog: ${entry.backlog_id}` : '')
    + (entry.source_refs.length ? `\n\nSources:\n${list(entry.source_refs)}` : ''),
  ).join('\n\n');
  const body = `# ${record.title}\n\n${record.question}\n\n## Current conclusion\n\n${record.conclusion || 'Not decided.'}\n\n## Open questions\n\n${list(record.open_questions)}\n\n# History\n\n${history}`;
  try {
    writeFileSync(temporary, renderMarkdown(record, body), { flag: 'wx' });
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
