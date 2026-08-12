export const recordTypes = [
  'task',
  'bug',
  'decision',
  'refactor',
  'module',
  'run-summary',
  'pattern',
  'runbook',
  'backlog',
  'verification-evidence',
  'project',
  'integration',
  'data_entity',
  'api',
  'requirement',
  'open_question',
  'meeting_draft',
  'source',
  'source_chunk',
  'acceptance_check',
] as const;

export type RecordType = (typeof recordTypes)[number];

export const projectKnowledgeRecordTypes = [
  'project',
  'integration',
  'data_entity',
  'api',
  'decision',
  'requirement',
  'open_question',
  'meeting_draft',
  'source',
  'source_chunk',
  'acceptance_check',
] as const;

export type ProjectKnowledgeRecordType = (typeof projectKnowledgeRecordTypes)[number];

const recordTypeSegments: Record<string, string> = {
  task: 'tasks',
  bug: 'bugs',
  decision: 'decisions',
  refactor: 'refactors',
  module: 'modules',
  'run-summary': 'run-summaries',
  pattern: 'patterns',
  runbook: 'runbooks',
  backlog: 'backlog',
  'verification-evidence': 'verification',
  project: 'projects',
  integration: 'integrations',
  data_entity: 'data-entities',
  api: 'apis',
  requirement: 'requirements',
  open_question: 'open-questions',
  meeting_draft: 'meeting-drafts',
  source: 'sources',
  source_chunk: 'source-chunks',
  acceptance_check: 'acceptance-checks',
};

const recordTypeIdPrefixes: Record<ProjectKnowledgeRecordType, string> = {
  project: 'PROJECT',
  integration: 'INTEGRATION',
  data_entity: 'DATA-ENTITY',
  api: 'API',
  decision: 'DECISION',
  requirement: 'REQUIREMENT',
  open_question: 'OPEN-QUESTION',
  meeting_draft: 'MEETING-DRAFT',
  source: 'SOURCE',
  source_chunk: 'SOURCE-CHUNK',
  acceptance_check: 'ACCEPTANCE-CHECK',
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
