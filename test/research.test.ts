import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { confirmBacklogItem, getBacklog } from '../src/backlog/backlog.js';
import { buildContextPack } from '../src/context-pack/pack.js';
import { rebuildIndex, searchIndex } from '../src/indexer/sqlite.js';
import { createResearch, getResearch, listResearch, appendResearchEntry, transitionResearch, researchToBacklog } from '../src/research/research.js';
import { initializeProjectContext } from '../src/scaffold/init.js';
import { lintContext } from '../src/storage/lint.js';
import { readRecords } from '../src/storage/markdown.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let cwd: string;
let root: string;
beforeEach(() => {
  cwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'research-test-'));
  process.chdir(root);
  initializeProjectContext({ name: 'Research Test' });
});
afterEach(() => { process.chdir(cwd); rmSync(root, { recursive: true, force: true }); });
const item = { title: 'Implement selected option', acceptanceCriteria: ['Selected option works'], checks: ['npm test'] };
function readyResearch() {
  let record = createResearch({ title: 'Compare delivery options', question: 'Which delivery option should we use?' });
  record = transitionResearch({ researchId: record.id, expectedRevision: 1, requestKey: 'start', status: 'exploring', reason: 'Compare options' });
  return transitionResearch({ researchId: record.id, expectedRevision: record.revision, requestKey: 'ready', status: 'ready', reason: 'Comparison complete', conclusion: 'Use option B with documented limitations.' });
}

describe('research lifecycle', () => {
  it('preserves stages, questions and conclusions when reopened', () => {
    let record = createResearch({ title: 'Explore cache', question: 'Which cache?', openQuestions: ['How fresh?'], sourceRefs: ['chat:one'] });
    expect(record.path).toMatch(/^\.project-context\/active\/research\//);
    expect(getBacklog().count).toBe(0);
    record = transitionResearch({ researchId: record.id, expectedRevision: 1, requestKey: 'start', status: 'exploring', reason: 'Investigate freshness' });
    expect(() => transitionResearch({ researchId: record.id, expectedRevision: 2, requestKey: 'too-soon', status: 'ready', reason: 'Done', conclusion: 'Cache A' })).toThrow('resolved open questions');
    record = appendResearchEntry({ researchId: record.id, expectedRevision: 2, requestKey: 'findings', kind: 'finding', content: 'Cache A meets freshness limits.', openQuestions: [], sourceRefs: ['chat:two'] });
    record = transitionResearch({ researchId: record.id, expectedRevision: 3, requestKey: 'ready', status: 'ready', reason: 'Compared A and B', conclusion: 'Choose A' });
    const history = structuredClone(record.entries);
    record = transitionResearch({ researchId: record.id, expectedRevision: 4, requestKey: 'reopen', status: 'exploring', reason: 'New constraint' });
    expect(record.conclusion).toBe('');
    expect(record.entries.slice(0, 4)).toEqual(history);
    expect(record.entries[3].conclusion).toBe('Choose A');
    expect(getResearch({ researchId: record.id })).toEqual(record);
    expect(readFileSync(resolve(root, record.path), 'utf8')).toContain('Cache A meets freshness limits.');
    expect(record.source_refs).toEqual(['chat:one', 'chat:two']);
  });

  it('rejects stale writes, invalid transitions and request-key reuse with different content', () => {
    const record = createResearch({ title: 'Idea', question: 'Should we build it?' });
    const request = { researchId: record.id, expectedRevision: 1, requestKey: 'discussion', content: 'Option one' };
    const updated = appendResearchEntry(request);
    expect(appendResearchEntry(request)).toEqual(updated);
    expect(() => appendResearchEntry({ ...request, content: 'Option two' })).toThrow('different content');
    expect(() => appendResearchEntry({ ...request, requestKey: 'other' })).toThrow('revision conflict');
    expect(() => transitionResearch({ researchId: record.id, expectedRevision: 2, requestKey: 'skip', status: 'ready', reason: 'Skip', conclusion: 'Yes' })).toThrow('Invalid research transition');
    const paused = transitionResearch({ researchId: record.id, expectedRevision: 2, requestKey: 'pause', status: 'paused', reason: 'Waiting for input' });
    expect(() => appendResearchEntry({ ...request, expectedRevision: paused.revision, requestKey: 'late' })).toThrow('Resume research');
    const closed = transitionResearch({ researchId: record.id, expectedRevision: paused.revision, requestKey: 'close', status: 'closed', reason: 'Not worth pursuing' });
    expect(listResearch().count).toBe(0);
    expect(listResearch({ statuses: ['closed'] }).items[0].id).toBe(closed.id);
  });

  it('previews handoff without writes and creates one linked draft on retries', () => {
    const record = readyResearch();
    const request = { researchId: record.id, expectedRevision: record.revision, requestKey: 'delivery-task', item };
    const before = readFileSync(resolve(root, record.path), 'utf8');
    expect(researchToBacklog(request).status).toBe('DRY_RUN');
    expect(readRecords().filter((record) => record.type === 'backlog')).toHaveLength(0);
    expect(readFileSync(resolve(root, record.path), 'utf8')).toBe(before);
    const result = researchToBacklog({ ...request, dryRun: false });
    expect(result.status).toBe('PROPOSED');
    expect(result.research.status).toBe('handed_off');
    expect(result.research.linkedBacklog[0].path).toContain('/drafts/backlog/');
    expect(getBacklog().count).toBe(0);
    expect(researchToBacklog({ ...request, dryRun: false }).status).toBe('ALREADY_LINKED');
    expect(readRecords().filter((record) => record.type === 'backlog')).toHaveLength(1);
    expect(() => researchToBacklog({ ...request, dryRun: false, item: { ...item, title: 'Different task' } })).toThrow('different content');
    const backlogId = result.research.linkedBacklog[0].id;
    confirmBacklogItem({ backlogId, approvedBy: 'test', status: 'ready', dryRun: false });
    expect(getResearch({ researchId: record.id }).linkedBacklog[0].status).toBe('ready');
    expect(getBacklog().items[0].sourceRefs).toContain(record.id);
    const next = researchToBacklog({ researchId: record.id, expectedRevision: result.research.revision,
      requestKey: 'observability-task', dryRun: false,
      item: { ...item, title: 'Instrument latency telemetry', description: 'Collect latency statistics' } });
    expect(next.research.linkedBacklog).toHaveLength(2);
    expect(next.research.entries.filter((entry) => entry.kind === 'handoff')).toHaveLength(2);
  });

  it('recovers an interrupted handoff without duplicating the backlog draft', () => {
    const record = readyResearch();
    const before = readFileSync(resolve(root, record.path), 'utf8');
    const request = { researchId: record.id, expectedRevision: record.revision, requestKey: 'recover', item, dryRun: false };
    researchToBacklog(request);
    // Simulate interruption after the backlog write but before the research write.
    writeFileSync(resolve(root, record.path), before);
    expect(researchToBacklog(request).research.linkedBacklog).toHaveLength(1);
    expect(readRecords().filter((record) => record.type === 'backlog')).toHaveLength(1);
  });

  it('requires a ready conclusion and leaves unrelated duplicate proposals unlinked', () => {
    const idea = createResearch({ title: 'Idea', question: 'Proceed?' });
    expect(() => researchToBacklog({ researchId: idea.id, expectedRevision: 1, requestKey: 'early', item, dryRun: false })).toThrow('must be ready');
    const first = readyResearch();
    researchToBacklog({ researchId: first.id, expectedRevision: first.revision, requestKey: 'first', item, dryRun: false });
    const second = readyResearch();
    const result = researchToBacklog({ researchId: second.id, expectedRevision: second.revision, requestKey: 'second', item, dryRun: false });
    expect(result.status).toBe('DUPLICATE_OR_RELATED');
    expect(result.research.linkedBacklog).toHaveLength(0);
    expect(result.research.status).toBe('ready');
  });

  it('indexes and lints research, and filters the list without returning full history', () => {
    const record = createResearch({ title: 'Quasar delivery', question: 'Which approach?', tags: ['quasar'] });
    rebuildIndex();
    expect(searchIndex('Quasar', 10, false).some((hit) => hit.id === record.id)).toBe(true);
    expect(lintContext().errors).toEqual([]);
    const result = listResearch({ query: 'Quasar' });
    expect(result.total).toBe(1);
    expect(result.items[0]).not.toHaveProperty('entries');
    expect(result.items[0].entryCount).toBe(1);
    transitionResearch({ researchId: record.id, expectedRevision: 1, requestKey: 'close', status: 'closed', reason: 'Deferred indefinitely' });
    rebuildIndex();
    expect(buildContextPack({ query: 'Quasar', includeHistory: false }).records.some((hit) => hit.id === record.id)).toBe(false);
    expect(buildContextPack({ query: 'Quasar', includeHistory: true }).records.some((hit) => hit.id === record.id)).toBe(true);
  });

  it('rejects traversal IDs, out-of-repository storage and overlapping writers', () => {
    expect(() => getResearch({ researchId: '../../secret' })).toThrow();
    writeFileSync(resolve(root, '.project-context/active/research/.research.lock'), 'busy');
    expect(() => createResearch({ title: 'Busy', question: 'Wait?' })).toThrow('busy');
    rmSync(resolve(root, '.project-context/active/research'), { recursive: true });
    const outside = mkdtempSync(resolve(tmpdir(), 'research-outside-'));
    try {
      symlinkSync(outside, resolve(root, '.project-context/active/research'), 'dir');
      expect(() => createResearch({ title: 'Outside', question: 'Escape?' })).toThrow('Invalid research storage');
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('exposes the workflow through a real planning MCP server and the CLI', async () => {
    const client = new Client({ name: 'research-test', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(packageRoot, 'bin/project-context-mcp')], cwd: root,
      env: { ...process.env, PROJECT_CONTEXT_TOOL_PROFILE: 'planning' } as Record<string, string> });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain('research_to_backlog');
      expect(tools.tools.map((tool) => tool.name)).toContain('confirm_backlog_item');
      expect(tools.tools.map((tool) => tool.name)).not.toContain('archive_records');
      const created = await client.callTool({ name: 'create_research', arguments: { title: 'MCP idea', question: 'Persist this?' } });
      expect(created.isError).not.toBe(true);
      const data = created.structuredContent as { id: string; revision: number };
      const appended = await client.callTool({ name: 'append_research_entry', arguments: { researchId: data.id, expectedRevision: data.revision, requestKey: 'mcp-stage', content: 'Discussed tradeoffs.' } });
      expect(appended.isError).not.toBe(true);
      const output = JSON.parse(execFileSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), 'get-research', data.id, '--json'], { cwd: root, encoding: 'utf8' }));
      expect(output.entries).toHaveLength(2);
      expect(output.entries[1].content).toBe('Discussed tradeoffs.');
      const transition = async (revision: number, status: string, key: string, conclusion?: string) => {
        const response = await client.callTool({ name: 'transition_research', arguments: {
          researchId: data.id, expectedRevision: revision, requestKey: key, status, reason: 'Agreed direction', ...(conclusion ? { conclusion } : {}),
        } });
        expect(response.isError).not.toBe(true);
      };
      await transition(2, 'exploring', 'start');
      await transition(3, 'ready', 'conclude', 'Use option B');
      const handoff = await client.callTool({ name: 'research_to_backlog', arguments: {
        researchId: data.id, expectedRevision: 4, requestKey: 'mcp-handoff', dryRun: false, item,
      } });
      expect(handoff.isError).not.toBe(true);
      expect(handoff.structuredContent).toMatchObject({ status: 'PROPOSED', research: { status: 'handed_off', revision: 5 } });
    } finally { await client.close(); }
  });
});
