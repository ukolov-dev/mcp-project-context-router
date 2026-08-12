import { describe, expect, it } from 'vitest';
import { coreToolNames, resolveMcpToolProfile, toolsForProfile } from '../src/mcp/tool-profiles.js';

const allTools = [
  ...coreToolNames,
  'search_project_context',
  'find_requirements',
  'plan_confluence_publish',
  'apply_confluence_publish',
  'get_confluence_publish_plan',
  'accept_assigned_work',
  'submit_implementation_report',
  'get_backlog',
  'archive_records',
];

describe('MCP tool profiles', () => {
  it('uses a compact core profile by default', () => {
    expect(resolveMcpToolProfile(undefined)).toBe('core');
    expect(toolsForProfile('core', allTools)).toEqual([...coreToolNames]);
  });

  it('adds analyst tools without admin mutation tools', () => {
    const tools = toolsForProfile('analyst', allTools);

    expect(tools).toContain('search_project_context');
    expect(tools).toContain('find_requirements');
    expect(tools).toContain('plan_confluence_publish');
    expect(tools).toContain('apply_confluence_publish');
    expect(tools).not.toContain('archive_records');
  });

  it('adds admin tools without analyst search tools', () => {
    const tools = toolsForProfile('admin', allTools);

    expect(tools).toContain('get_backlog');
    expect(tools).toContain('archive_records');
    expect(tools).not.toContain('search_project_context');
  });

  it('adds only typed Portal writeback to the developer surface', () => {
    const tools = toolsForProfile('developer', allTools);

    expect(tools).toContain('get_shared_project_snapshot');
    expect(tools).toContain('get_assigned_work');
    expect(tools).toContain('accept_assigned_work');
    expect(tools).toContain('submit_implementation_report');
    expect(tools).not.toContain('apply_confluence_publish');
    expect(tools).not.toContain('archive_records');
  });

  it('keeps every registered tool in the full compatibility profile', () => {
    expect(toolsForProfile('full', allTools)).toEqual(allTools);
  });

  it('rejects unknown profile names', () => {
    expect(() => resolveMcpToolProfile('wide')).toThrow('Expected core, analyst, developer, admin, or full');
  });
});
