export const recordTypes = [
  'task',
  'bug',
  'decision',
  'backlog',
  'research',
  'verification-evidence',
  'agent-run',
  'acceptance-review',
  'project',
  'requirement',
  'open_question',
  'source',
  'source_chunk',
] as const;

export type RecordType = (typeof recordTypes)[number];

export const projectKnowledgeRecordTypes = [
  'project',
  'decision',
  'requirement',
  'open_question',
  'source',
  'source_chunk',
] as const;

export type ProjectKnowledgeRecordType = (typeof projectKnowledgeRecordTypes)[number];

const recordTypeSegments: Record<string, string> = {
  task: 'tasks',
  bug: 'bugs',
  decision: 'decisions',
  backlog: 'backlog',
  research: 'research',
  'verification-evidence': 'verification',
  'agent-run': 'agent-runs',
  'acceptance-review': 'acceptance-reviews',
  project: 'projects',
  requirement: 'requirements',
  open_question: 'open-questions',
  source: 'sources',
  source_chunk: 'source-chunks',
};

const recordTypeIdPrefixes: Record<ProjectKnowledgeRecordType, string> = {
  project: 'PROJECT',
  decision: 'DECISION',
  requirement: 'REQUIREMENT',
  open_question: 'OPEN-QUESTION',
  source: 'SOURCE',
  source_chunk: 'SOURCE-CHUNK',
};

export function isProjectKnowledgeRecordType(type: string): type is ProjectKnowledgeRecordType {
  return (projectKnowledgeRecordTypes as readonly string[]).includes(type);
}

export function segmentForRecordType(type: string): string {
  return recordTypeSegments[type] ?? 'records';
}

export function idPrefixForProjectKnowledgeType(type: ProjectKnowledgeRecordType): string {
  return recordTypeIdPrefixes[type];
}

export function generatedIdPattern(prefix: string): RegExp {
  return new RegExp(`^${escapeRegExp(prefix)}-\\d{8}(?:-\\d{6})?-\\d{3}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const retiredRecordTypes = [
  'integration',
  'api',
  'data_entity',
  'meeting_draft',
  'acceptance_check',
  'module',
  'pattern',
  'runbook',
  'refactor',
  'run-summary',
] as const;

export function isRetiredRecordType(type: string): boolean {
  return (retiredRecordTypes as readonly string[]).includes(type);
}
