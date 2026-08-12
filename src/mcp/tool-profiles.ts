export type McpToolProfile = 'core' | 'analyst' | 'developer' | 'admin' | 'full';

export const coreToolNames = [
  'get_project_brief',
  'get_shared_project_snapshot',
  'get_exact_shared_snapshot',
  'get_assigned_work',
  'get_handoff_bundle',
  'get_portal_sync_status',
  'validate_task',
  'confirm_task_contract',
  'build_context_pack',
  'retrieve_project_context',
  'pick_next_task',
  'get_verification_plan',
  'record_verification_evidence',
  'context_doctor',
  'get_project_snapshot',
  'find_existing_capability',
  'review_diff_for_refactor',
  'finalize_work',
] as const;

const developerToolNames = [
  'accept_assigned_work',
  'submit_implementation_report',
] as const;

const analystToolNames = [
  'search_project_context',
  'find_integrations',
  'find_data_entities',
  'get_decisions',
  'build_project_context_pack',
  'propose_context_update',
  'find_requirements',
  'find_source_chunks',
  'get_open_questions',
  'get_conflicts',
  'trace_requirement',
  'build_analyst_context_pack',
  'analyst_delta_to_backlog',
  'propose_analyst_source',
  'import_rp_database',
  'plan_confluence_publish',
  'apply_confluence_publish',
  'get_confluence_publish_plan',
] as const;

const adminToolNames = [
  'get_backlog',
  'get_backlog_dependency_graph',
  'task_from_backlog',
  'propose_backlog_item',
  'confirm_backlog_item',
  'transition_backlog_item',
  'spec_to_backlog',
  'list_verification_evidence',
  'promote_draft',
  'promote_drafts_batch',
  'current_truth',
  'find_existing_capabilities',
  'propose_cleanup',
  'archive_records',
  'record_decision',
] as const;

const profileTools: Record<Exclude<McpToolProfile, 'full'>, ReadonlySet<string>> = {
  core: new Set(coreToolNames),
  analyst: new Set([...coreToolNames, ...analystToolNames]),
  developer: new Set([...coreToolNames, ...developerToolNames]),
  admin: new Set([...coreToolNames, ...adminToolNames]),
};

export function resolveMcpToolProfile(
  value = process.env.PROJECT_CONTEXT_TOOL_PROFILE ?? process.env.PPM_CONTEXT_TOOL_PROFILE,
): McpToolProfile {
  const profile = value?.trim().toLowerCase() || 'core';
  if (profile === 'core' || profile === 'analyst' || profile === 'developer' || profile === 'admin' || profile === 'full') {
    return profile;
  }
  throw new Error(`Unsupported PROJECT_CONTEXT_TOOL_PROFILE: ${value}. Expected core, analyst, developer, admin, or full.`);
}

export function toolEnabledForProfile(profile: McpToolProfile, toolName: string): boolean {
  return profile === 'full' || profileTools[profile].has(toolName);
}

export function toolsForProfile(profile: McpToolProfile, allToolNames: Iterable<string>): string[] {
  return [...allToolNames].filter((name) => toolEnabledForProfile(profile, name));
}
