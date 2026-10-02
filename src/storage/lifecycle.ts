import type { ContextRecord } from './types.js';

export function recordCategory(record: ContextRecord): 'active' | 'historical' | 'draft' {
  if (record.path.replaceAll('\\', '/').includes('/drafts/') || record.status === 'draft') return 'draft';
  if (record.archived || ['superseded', 'cancelled', 'canceled', 'retired', 'archived', 'done', 'closed'].includes(record.status)) return 'historical';
  return 'active';
}

export function recordProvenance(record: ContextRecord) {
  const data = record.frontmatter;
  return {
    status: record.status,
    category: recordCategory(record),
    authority: String(data.authority ?? (data.confirmed_by_human === true ? 'user-confirmed' : ['source', 'source_chunk'].includes(record.type) ? 'source-material' : 'unspecified')),
    as_of: data.as_of ?? data.confirmed_at ?? data.updated_at ?? data.created_at ?? null,
    superseded_by: data.superseded_by ?? null,
    source_refs: data.source_refs ?? [],
    knowledge_status: data.knowledge_status ?? null,
  };
}
