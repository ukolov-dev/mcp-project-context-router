import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { budgetContext, applyIdentifierFallback, identifierTerms, engines, evaluateSearch, expandRelations, fuseRankings, supportingRecords, scoreHits, validateFixture } from '../scripts/search-eval.js';
import type { ContextRecord } from '../src/storage/types.js';
import { estimateTokens } from '../src/context-pack/pack.js';
import { renderMarkdown } from '../src/storage/markdown.js';
import { scaleCorpus } from '../scripts/search-scale.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/search-eval.json', import.meta.url), 'utf8'));

function record(id: string, fields: Partial<ContextRecord> = {}): ContextRecord {
  return { id, type: 'decision', status: 'active', title: id, body: 'Evidence', path: `records/${id}.md`,
    retention: 'normal', archived: false, modules: ['router'], files: [], deletedFiles: [], tags: [], frontmatter: {}, ...fields };
}

describe('search relevance evaluation', () => {
  it('replays consumer routing and required guidance, recording honest budget overflow', () => {
    const snapshot = { kind: 'project-snapshot', version: 1, description: 'Consumer budget regression',
      capturedAt: '2026-10-13T00:00:00Z', excludedRecordIds: [],
      config: { modules: { product: { path: 'src', aliases: ['backend'] } } },
      consumer: { projectYaml: 'project:\n  name: Consumer\nmodules:\n  product:\n    path: src\n    aliases: [backend]\nrouting:\n  default_modules: [product]\ncommands: {}\n',
        supportFiles: [{ path: 'AGENTS.md', content: 'Required guidance. '.repeat(1200) }] },
      documents: [{ path: '.project-context/active/records/ANCHOR.md',
        markdown: renderMarkdown({ id: 'ANCHOR', type: 'decision', status: 'active', title: 'Needle', modules: ['product'] }, 'NeedleIdentifier evidence') }],
      queries: [{ id: 'CONSUMER', category: 'scope', query: 'Needle', modules: ['backend'], relevant: ['ANCHOR'], files: [], rationale: 'Alias and required guidance from real consumer configuration.' }] };
    const report = evaluateSearch(snapshot, 1, [500], ['current', 'fts5+identifiers'], true);
    expect(report.contextPacks!.results.every((row) => row.budget.exceedsLimit && !row.ids.length
      && row.pack.playbookDetails[0]?.required && row.routedModules?.includes('product'))).toBe(true);
    expect(report.contextPacks!.summary.every((row) => row.budgetExceededPacks === 1)).toBe(true);
    expect(() => evaluateSearch({ ...snapshot, consumer: { ...snapshot.consumer, supportFiles: [{ path: '../outside', content: '' }] } }, 1)).toThrow('repository-relative');
    expect(() => evaluateSearch({ ...snapshot, consumer: { ...snapshot.consumer, supportFiles: [{ path: '.project-context/project.yaml', content: '' }] } }, 1)).toThrow('overwrite context');
    expect(() => evaluateSearch({ ...snapshot, consumer: { ...snapshot.consumer, supportFiles: [...snapshot.consumer.supportFiles, ...snapshot.consumer.supportFiles] } }, 1)).toThrow('Duplicate support');
  });
  it('evaluates actual excerpt packs with explicit history controls and unchanged relevance labels', () => {
    const snapshot = { kind: 'project-snapshot', version: 1, description: 'Runtime pack policy control',
      capturedAt: '2026-10-13T00:00:00Z', excludedRecordIds: [],
      config: { modules: { router: { path: 'src', aliases: ['engine'] } } },
      documents: ['VISIBLE', 'HIDDEN', 'NEIGHBOR'].map((id) => ({ path: `.project-context/active/records/${id}.md`,
        markdown: renderMarkdown({ id, title: id, type: id === 'HIDDEN' ? 'task' : 'decision',
          status: id === 'HIDDEN' ? 'done' : 'active', modules: ['router'], related: { records: ['NEIGHBOR'] } },
        id === 'NEIGHBOR' ? 'unrelated neighbor' : 'NeedleIdentifierLonger evidence') })),
      queries: [{ id: 'PACK', category: 'policy', query: 'NeedleIdent', modules: ['router'], relevant: ['VISIBLE', 'HIDDEN'],
        files: [], rationale: 'History is hidden by default but labels stay fixed.' }] };
    const report = evaluateSearch(snapshot, 1, [500, 1000, 2000, 4000], ['current', 'fts5+identifiers'], true);
    const rows = report.contextPacks!.results.filter((row) => row.searchEngine === 'fts5' && row.maxTokens === 4000);
    expect(rows[0]).toMatchObject({ includeHistory: false, relevant: ['VISIBLE', 'HIDDEN'], ids: ['VISIBLE'],
      excerptIds: ['VISIBLE'], policyHiddenRelevantIds: ['HIDDEN'], recall: 0.5, visibleRecall: 1 });
    expect(rows[1].ids.sort()).toEqual(['HIDDEN', 'VISIBLE']);
    expect(rows.every((row) => !row.ids.includes('NEIGHBOR'))).toBe(true);
    expect(report.contextPacks!.results.every((row) => row.estimatedTokens <= row.maxTokens)).toBe(true);
  });
  it('adds deterministic scoped negative load without copying or relabeling the original corpus', () => {
    const base = validateFixture(fixture);
    const scaled = scaleCorpus(base, 240);
    expect(scaled).toEqual(scaleCorpus(base, 240));
    expect('records' in scaled).toBe(true);
    if (!('records' in scaled)) throw new Error('Expected synthetic records');
    expect(scaled.records).toHaveLength(240);
    expect(scaled.records.slice(0, 40)).toEqual(base.records);
    expect(scaled.queries).toEqual(base.queries);
    expect(base.records).toHaveLength(40);
    expect(scaled.records.slice(40).every((record) => !record.files.length && record.related.every((id) => id.startsWith('LOAD-')))).toBe(true);
    expect(scaled.records.slice(40).filter((record) => record.title.startsWith('Unrelated spelling glossary'))).toHaveLength(20);
    expect(() => scaleCorpus(base, 39)).toThrow();
    expect(() => scaleCorpus(base, 20001)).toThrow();
    expect(() => scaleCorpus({ ...base, records: [...base.records, { ...base.records[0], id: 'LOAD-000000' }] }, 240)).toThrow('collision');
  });

  it('preserves snapshot Markdown bytes and queries when adding load', () => {
    const snapshot = { kind: 'project-snapshot' as const, version: 1, description: 'Generic load replay',
      capturedAt: '2026-10-12T00:00:00Z', excludedRecordIds: [],
      config: { modules: { router: { path: 'src', aliases: ['engine'] }, docs: { path: 'docs', aliases: [] } } },
      documents: [{ path: '.project-context/active/records/A.md', markdown: renderMarkdown({ id: 'A', type: 'decision', status: 'active', title: 'Anchor', modules: ['router'] }, 'Original anchor') }],
      queries: [{ id: 'LOAD-QUERY', category: 'scope', query: 'anchor', modules: ['engine'], includeArchive: false,
        relevant: ['A'], files: [], rationale: 'Original source bytes preserved' }] };
    const scaled = scaleCorpus(snapshot, 220);
    if (!('documents' in scaled)) throw new Error('Expected snapshot');
    expect(scaled.documents).toHaveLength(220);
    expect(scaled.documents[0]).toEqual(snapshot.documents[0]);
    expect(scaled.queries).toEqual(snapshot.queries);
    expect(evaluateSearch(scaled, 1, [500], ['current', 'fts5', 'fts5+identifiers']).results[0].engines.fts5.ids).toEqual(['A']);
    expect(() => scaleCorpus({ ...snapshot, documents: [{ ...snapshot.documents[0], markdown: renderMarkdown({ id: 'LOAD-000000' }, 'Collision') }] }, 220)).toThrow('collision');
  });

  it('selects benchmark engines while preserving their default quality and budget outcomes', () => {
    const input = { ...fixture, queries: fixture.queries.slice(0, 2) };
    const all = evaluateSearch(input, 1);
    const subset = evaluateSearch(input, 1, [500, 1000, 2000, 4000], ['current', 'fts5', 'fts5+identifiers']);
    expect(Object.keys(subset.summary)).toEqual(['current', 'fts5', 'fts5+identifiers']);
    for (const row of subset.results) {
      const original = all.results.find((item) => item.id === row.id)!;
      for (const [engine, result] of Object.entries(row.engines)) {
        const { latencyMs: _latency, ...metrics } = result;
        const { latencyMs: _oldLatency, ...oldMetrics } = original.engines[engine];
        expect(metrics).toEqual(oldMetrics);
      }
    }
    expect(() => evaluateSearch(input, 1, [500], [])).toThrow();
    expect(() => evaluateSearch(input, 1, [500], ['fts5', 'fts5'])).toThrow('Duplicate engines');
  });
  it('preserves the original queries and adds hard cases with fixed resolvable judgments', () => {
    const parsed = validateFixture(fixture);
    expect(parsed.version).toBe(2);
    expect(parsed.queries).toHaveLength(60);
    expect(parsed.queries.slice(0, 40).map((query) => query.id)).toEqual(Array.from({ length: 40 }, (_, i) => `Q${String(i + 1).padStart(2, '0')}`));
    expect(parsed.queries.filter((query) => !query.relevant.length)).toHaveLength(9);
    expect(new Set(parsed.queries.map((query) => query.category)).size).toBe(9);
    expect(() => validateFixture({ ...fixture, queries: [{ ...fixture.queries[0], relevant: ['MISSING'] }] })).toThrow('unknown relevant');
    expect(() => validateFixture({ ...fixture, queries: [{ ...fixture.queries[0], modules: ['security'] }] })).toThrow('outside query scope');
    expect(() => validateFixture({ ...fixture, queries: [{ ...fixture.queries[0], files: ['src/not-labeled.ts'] }] })).toThrow('file label');
    expect(() => validateFixture({ ...fixture, records: [...fixture.records, fixture.records[0]] })).toThrow('Duplicate record');
    expect(() => validateFixture({ ...fixture, records: [{ ...fixture.records[0], files: ['../outside.ts'] }] })).toThrow('repository-relative');
    expect(() => evaluateSearch(fixture, 0)).toThrow('Samples');
  });

  it('calculates macro query metrics without counting negatives as relevance successes', () => {
    const hits = [record('NOISE'), record('A', { files: ['src/a.ts'] }), record('B', { files: ['src/b.ts'] })];
    expect(scoreHits(hits, { relevant: ['A', 'B'], files: ['src/a.ts', 'src/b.ts'] })).toMatchObject({
      hitAt5: 1, recallAt5: 1, precisionAt5: 0.4, mrrAt5: 0.5, fileReferenceRecallAt5: 1, negativeCorrect: null,
    });
    expect(scoreHits([], { relevant: [], files: [] })).toMatchObject({ hitAt5: 0, negativeCorrect: true, fileReferenceRecallAt5: null });
    expect(scoreHits(hits, { relevant: [], files: [] }).negativeCorrect).toBe(false);
    expect(scoreHits([...Array.from({ length: 5 }, (_, i) => record(`NOISE-${i}`)), record('A')], { relevant: ['A'], files: [] }).recallAt5).toBe(0);
  });

  it('walks related and source_task in either direction, one hop, inside eligible records only', () => {
    const a = record('A', { frontmatter: { related: { decisions: ['B', 'OUTSIDE', 'UNKNOWN'] } } });
    const b = record('B', { frontmatter: { related: { decisions: ['C'] } } });
    const c = record('C');
    const evidence = record('EVIDENCE', { frontmatter: { source_task: 'A' } });
    expect(expandRelations([a], [a, b, c, evidence]).map((hit) => hit.id)).toEqual(['A', 'B', 'EVIDENCE']);
    expect(expandRelations([b], [a, b, c]).map((hit) => hit.id)).toEqual(['B', 'A', 'C']);
    expect(expandRelations([record('OUTSIDE')], [a, b])).toEqual([]);
    expect(expandRelations([], [a, b, c])).toEqual([]);
  });

  it('fuses lexical rankings deterministically and appends scoped one-hop evidence without displacing direct hits', () => {
    const a = record('A');
    const b = record('B');
    const c = record('C');
    expect(fuseRankings([a, b], [c, b]).map((hit) => hit.id)).toEqual(['B', 'A', 'C']);
    expect(fuseRankings([], [c, b]).map((hit) => hit.id)).toEqual(['C', 'B']);
    expect(fuseRankings([a, b], [c, b], 1).map((hit) => hit.id)).toEqual(['B']);
    const direct = [a, b, c, record('D'), record('E')];
    const evidence = record('VERIFY', { frontmatter: { target_id: 'A', retries_evidence_id: 'OLD' } });
    const old = record('OLD');
    const outside = record('OUTSIDE', { frontmatter: { target_id: 'A' } });
    const eligible = [...direct, evidence, old];
    expect(supportingRecords(direct, eligible).map((hit) => hit.id)).toEqual(['VERIFY']);
    expect(supportingRecords([evidence], eligible).map((hit) => hit.id)).toEqual(['A', 'OLD']);
    expect(supportingRecords([outside], eligible)).toEqual([]);
    expect(supportingRecords([], eligible)).toEqual([]);
    expect(supportingRecords(direct, [...eligible, ...Array.from({ length: 8 }, (_, i) =>
      record(`V${i}`, { frontmatter: { target_id: 'A' } }))])).toHaveLength(5);
    expect(direct.map((hit) => hit.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('recognizes identifier fragments and appends deduplicated matches without displacing FTS results', () => {
    expect(identifierTerms('Find ModuleName buildContext snake_case and ModuleName in prose')).toEqual(['ModuleName', 'buildContext', 'snake_case']);
    expect(identifierTerms('Windows SQLite FTS5 v0.7.0 normal words 279 to 140')).toEqual([]);
    const direct = ['A', 'B', 'C', 'D', 'E'].map((id) => record(id));
    expect(applyIdentifierFallback(direct, [record('A'), record('F'), record('G')]).map((hit) => hit.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G']);
    expect(applyIdentifierFallback(direct, [record('E')])).toEqual(direct);
    expect(applyIdentifierFallback(direct, [])).toEqual(direct);
    expect(applyIdentifierFallback([], [record('F'), record('G')]).map((hit) => hit.id)).toEqual(['F', 'G']);
    expect(applyIdentifierFallback([record('A')], [record('F')]).map((hit) => hit.id)).toEqual(['A', 'F']);
    expect(applyIdentifierFallback(direct, ['F', 'F', 'G', 'H', 'I', 'J', 'K'].map((id) => record(id))).map((hit) => hit.id))
      .toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']);
    expect(direct.map((hit) => hit.id)).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('finds multiple proper identifiers beyond five exact glossary candidates and preserves the FTS prefix', () => {
    const partials = ['PARTIAL-A', 'PARTIAL-B', 'PARTIAL-C', 'PARTIAL-D'];
    const data = {
      version: 1, description: 'Generic candidate depth regression',
      records: [
        ...Array.from({ length: 7 }, (_, i) => ({ id: `EXACT-${i}`, type: 'source', module: 'router', title: 'buildContext',
          body: 'Exact glossary entry', tags: [], files: [] })),
        ...partials.map((id, i) => ({ id, type: 'pattern', module: 'router', title: 'Code identifier',
          body: `buildContextVariant${i}`, tags: [], files: [] })),
      ],
      queries: [{ id: 'DEPTH', category: 'identifier', query: 'buildContext', modules: ['router'], relevant: partials,
        files: [], rationale: 'All proper fragments rank below exact glossary entries in substring search' }],
    };
    const row = evaluateSearch(data, 1).results[0];
    expect(row.engines.fts5.ids).toHaveLength(5);
    expect(row.engines['fts5+identifiers'].ids).toEqual(row.engines.fts5.ids);
    expect(row.engines['fts5+identifiers'].identifierIds).toEqual(partials);
    expect(row.engines['fts5+identifiers'].expandedRecall).toBe(1);
    expect(row.engines['fts5+identifiers'].recallAt5).toBe(0);
    expect(row.engines['fts5+identifiers'].substringCandidatesParsed).toBe(4);
    expect(row.engines['fts5+identifiers'].identifierCandidateMatches).toBe(4);
  });

  it('filters indexed identifiers with Unicode case folding and preserves weighted ranking and term order before capped reads', () => {
    const fields = (id: string, title: string, body: string, tags: string[] = []) => ({ id, type: 'source', module: 'router', title, body, tags, files: [] });
    const ranked = ['Z', 'D', 'A', 'C', 'B', 'E', 'F'];
    const data = {
      version: 1, description: 'Generic indexed identifier ranking regression',
      records: [
        ...Array.from({ length: 7 }, (_, i) => fields(`GLOSS-${i}`, 'buildContext', 'Literal unrelated glossary', ['buildContext'])),
        fields('F', 'Other field', 'buildContextFactory'), fields('E', 'Other field', 'buildContextEngine'),
        fields('B', 'Other field', 'buildContextBridge'), fields('C', 'Other field', 'Evidence', ['buildContextCache']),
        fields('A', 'Other field', 'buildContextAdapter', ['buildContext']),
        fields('D', 'buildContextDriver', 'Evidence'), fields('Z', 'buildContext', 'buildContextZed', ['buildContext']),
        fields('U', 'Unicode code', 'prefixLÖADsuffix'), fields('V', 'Unicode code', 'prefixLÖADsuffix prefixLÖADsuffix'),
        fields('PLAIN', 'Unicode prose', 'prefixlöadsuffix'),
      ],
      queries: [
        { id: 'RANK', category: 'identifier', query: 'buildContext', modules: ['router'], relevant: ranked, files: [], rationale: 'Field weights including exact fields on proper matches' },
        { id: 'UNICODE', category: 'identifier', query: 'löaD', modules: ['router'], relevant: ['U', 'V'], files: [], rationale: 'Unicode lowercase folding before literal substring matching' },
        { id: 'TERMS', category: 'identifier', query: 'löaD buildContext', modules: ['router'], relevant: ['U', 'V', ...ranked], files: [], rationale: 'Query-term ordering before per-term weighted ranks' },
      ],
    };
    const report = evaluateSearch(data, 1);
    expect(report.identifierIndex.entries).toBeGreaterThan(0);
    for (const [index, row] of report.results.entries()) {
      const fullOrder = index === 0 ? ranked : index === 1 ? ['U', 'V'] : ['U', 'V', ...ranked];
      const expected = fullOrder.filter((id) => !row.engines.fts5.ids.includes(id)).slice(0, 5);
      for (const engine of ['fts5+identifiers', 'fts5+identifiers+support']) {
        expect(row.engines[engine].fallbackIds).toEqual(expected);
        expect(row.engines[engine].substringCandidatesParsed).toBe(expected.length);
        expect(row.engines[engine].identifierCandidateMatches).toBe(fullOrder.length);
        expect(row.engines[engine].ids).not.toContain('PLAIN');
      }
    }
  });

  it('limits fallback to longer code identifiers in eligible modules and archive scope', () => {
    const data = {
      version: 1, description: 'Generic fallback scope regression',
      records: [
        { id: 'EXACT', type: 'source', module: 'router', title: 'buildContext', body: 'Unrelated exact glossary', tags: [], files: [] },
        { id: 'PARTIAL', type: 'pattern', module: 'router', title: 'Code identifiers', body: 'buildContextPack load_record_cache', tags: [], files: [] },
        { id: 'OUTSIDE', type: 'pattern', module: 'security', title: 'buildContextSecret', body: 'buildContextSecret load_record_secret', tags: [], files: [] },
        { id: 'ARCHIVED', type: 'pattern', module: 'router', area: 'archive', title: 'Past buildContext', body: 'buildContextArchive archived_marker', tags: [], files: [] },
        { id: 'PLAIN', type: 'source', module: 'router', title: 'Ordinary word', body: 'buildcontextual is lowercase prose', tags: [], files: [] },
      ],
      queries: [
        { id: 'I1', category: 'identifier', query: 'How can buildContext work?', modules: ['engine'], relevant: ['PARTIAL'], files: [], rationale: 'Marked fragment within a prose query' },
        { id: 'I2', category: 'identifier', query: 'load_record', modules: ['router'], relevant: ['PARTIAL'], files: [], rationale: 'Snake identifier fragment' },
        { id: 'I3', category: 'identifier', query: 'archived_mark', modules: ['router'], relevant: [], files: [], rationale: 'Archive excluded from fallback' },
        { id: 'I4', category: 'identifier', query: 'archived_mark', modules: ['router'], includeArchive: true, relevant: ['ARCHIVED'], files: [], rationale: 'Archive explicitly eligible' },
        { id: 'I5', category: 'identifier', query: 'buildContext', modules: ['unknown'], relevant: [], files: [], rationale: 'Unknown module cannot produce fallback' },
      ],
    };
    const report = evaluateSearch(data, 1);
    for (const engine of ['fts5+identifiers', 'fts5+identifiers+support']) {
      expect(report.results[0].engines[engine].ids).toEqual(['EXACT', 'PARTIAL']);
      expect(report.results[1].engines[engine].ids).toEqual(['PARTIAL']);
      expect(report.results[2].engines[engine].ids).toEqual([]);
      expect(report.results[3].engines[engine].ids).toEqual(['ARCHIVED']);
      expect(report.results[4].engines[engine].ids).toEqual([]);
    }
  });

  it('packs complete records under a shared UTF-8 budget without letting support evict direct context', () => {
    const large = record('LARGE', { body: 'Oversized evidence '.repeat(500) });
    const direct = record('DIRECT', { body: 'Exact complete verification: before 0 of 8, after 8 of 8.' });
    const support = record('SUPPORT', { body: 'Повторная проверка завершена.' });
    const tail = record('TAIL', { body: 'Independent lexical continuation.' });
    const cap = 160;
    const baseline = budgetContext([large, direct], [], [], cap);
    const expanded = budgetContext([large, direct], [direct, support], [], cap);
    const lexical = budgetContext([large, direct], [], [tail], cap);
    for (const context of [baseline, expanded, lexical]) {
      expect(context.estimatedTokens).toBe(estimateTokens(context.payload));
      expect(context.estimatedTokens).toBeLessThanOrEqual(cap);
      expect(context.directIds).toEqual(['DIRECT']);
      expect(context.skippedIds).toContain('LARGE');
      expect(context.payload.direct[0].body).toBe(direct.body);
      expect(context.contextSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(expanded.supportingIds).toEqual(['SUPPORT']);
    expect(expanded.payload.supporting[0].body).toBe(support.body);
    expect(expanded.estimatedTokens).toBeGreaterThan(Math.ceil(JSON.stringify(expanded.payload).length / 3));
    expect(expanded.payload.direct).toEqual(baseline.payload.direct);
    expect(lexical.continuationIds).toEqual(['TAIL']);
    const both = budgetContext([direct], [support], [tail], lexical.estimatedTokens);
    expect(both.directIds).toEqual(['DIRECT']);
    expect(both.continuationIds).toEqual(['TAIL']);
    expect(both.supportingIds).toEqual([]);
    expect(both.skippedIds).toContain('SUPPORT');
    expect(budgetContext([large, direct], [support], [], cap)).toEqual(budgetContext([large, direct], [support], [], cap));
    expect(() => budgetContext([direct], [], [], 0)).toThrow();
    expect(() => evaluateSearch(fixture, 1, [500, 500])).toThrow('Duplicate context budgets');
    expect(() => evaluateSearch(fixture, 1, [NaN])).toThrow();
    expect(direct.body).toBe('Exact complete verification: before 0 of 8, after 8 of 8.');
  });

  it('restores cwd after a fixture materialization failure', () => {
    const cwd = process.cwd();
    const invalidFiles = {
      version: 1, description: 'Deliberate file/directory collision',
      records: [{ id: 'A', type: 'decision', title: 'A', body: 'A', tags: [], files: ['src/router', 'src/router/a.ts'] }],
      queries: [{ id: 'Q', category: 'failure', query: 'A', modules: ['router'], relevant: ['A'], files: [], rationale: 'Cleanup check' }],
    };
    expect(() => evaluateSearch(invalidFiles, 1)).toThrow();
    expect(process.cwd()).toBe(cwd);
  });

  it('compares all variants on real SQLite/Markdown with shared scope and restores cwd', () => {
    const cwd = process.cwd();
    const report = evaluateSearch(fixture, 1);
    expect(process.cwd()).toBe(cwd);
    expect(report).toMatchObject({ records: 40, queries: 60, positiveQueries: 51, negativeQueries: 9 });
    for (const engine of engines) {
      for (const id of ['Q33', 'Q35', 'Q36', 'Q37']) expect(report.results.find((query) => query.id === id)!.engines[engine].negativeCorrect).toBe(true);
      expect(report.summary[engine].latencyP50Ms).toBeGreaterThan(0);
      expect(report.results.find((query) => query.id === 'Q31')!.engines[engine].ids).toContain('PATTERN-MODULES');
      expect(report.results.find((query) => query.id === 'Q32')!.engines[engine].ids).toContain('GLOBAL-TRUTH');
      expect(report.results.find((query) => query.id === 'Q40')!.engines[engine].ids).toContain('DRAFT-VECTORS');
      for (const query of report.results) {
        expect(query.engines[engine].latencyMs).toHaveLength(1);
        if (query.id !== 'Q34') expect(query.engines[engine].ids).not.toContain('ARCHIVE-PORTER');
      }
    }
    const corruption = report.results.find((query) => query.id === 'Q25')!;
    expect(corruption.engines.current.ids).not.toContain('RUNBOOK-REBUILD');
    expect(corruption.engines['current+relations'].ids).toEqual(expect.arrayContaining(['DECISION-RECOVERY', 'PATTERN-PRESERVE', 'RUNBOOK-REBUILD']));
    const substring = report.results.find((query) => query.id === 'Q21')!;
    expect(substring.engines.current.ids).toContain('PATTERN-IDENTIFIERS');
    expect(substring.engines.fts5.ids).not.toContain('PATTERN-IDENTIFIERS');
    for (const id of ['Q21', 'Q22']) {
      const row = report.results.find((query) => query.id === id)!;
      expect(row.engines.hybrid.ids).toContain('PATTERN-IDENTIFIERS');
      expect(row.engines['fts5+identifiers'].ids).toContain('PATTERN-IDENTIFIERS');
      expect(row.engines['fts5+identifiers'].fallbackIds).toEqual(['PATTERN-IDENTIFIERS']);
    }
    for (const query of report.results) {
      const fallback = query.engines['fts5+identifiers'];
      const supporting = query.engines['fts5+identifiers+support'];
      expect(supporting.ids).toEqual(fallback.ids);
      for (const context of supporting.budgets) {
        const plain = fallback.budgets.find((item: { maxTokens: number }) => item.maxTokens === context.maxTokens)!;
        expect(context.estimatedTokens).toBeLessThanOrEqual(context.maxTokens);
        expect(context.directIds).toEqual(plain.directIds);
        expect(context.lexicalControl!.directIds).toEqual(plain.directIds);
        expect(context.continuationIds).toEqual(plain.continuationIds);
        expect(context.lexicalControl!.continuationIds.slice(0, plain.continuationIds.length)).toEqual(plain.continuationIds);
        const fts = query.engines.fts5.budgets.find((item) => item.maxTokens === context.maxTokens)!;
        expect(context.directIds).toEqual(expect.arrayContaining(fts.directIds));
        expect(context.lexicalControl!.estimatedTokens).toBeLessThanOrEqual(context.maxTokens);
        expect(context.supportingIds.some((id: string) => context.directIds.includes(id))).toBe(false);
      }
      expect(fallback.lexicalPoolIds.slice(0, 5)).toEqual(query.engines.fts5.ids);
      expect(supporting.lexicalPoolIds).toEqual(fallback.lexicalPoolIds);
      expect(supporting.mrrAt5).toBe(fallback.mrrAt5);
      expect(supporting.supportingIds.some((id: string) => [...fallback.ids, ...fallback.identifierIds].includes(id))).toBe(false);
      expect(supporting.supportingIds.length).toBeLessThanOrEqual(5);
      expect(fallback.fallbackIds.length).toBeLessThanOrEqual(5);
      expect(fallback.substringCandidatesParsed).toBe(fallback.fallbackIds.length);
      expect(supporting.substringCandidatesParsed).toBe(fallback.substringCandidatesParsed);
      expect(fallback.ids.slice(0, query.engines.fts5.ids.length)).toEqual(query.engines.fts5.ids);
      if (!identifierTerms(query.query).length) expect(fallback.ids).toEqual(query.engines.fts5.ids);
      const direct = query.engines.hybrid;
      const expanded = query.engines['hybrid+support'];
      expect(expanded.ids).toEqual(direct.ids);
      expect(expanded.lexicalPoolIds).toEqual(direct.lexicalPoolIds);
      expect(direct.lexicalPoolIds.slice(0, 5)).toEqual(direct.ids);
      expect(expanded.recallAt5).toBe(direct.recallAt5);
      expect(expanded.mrrAt5).toBe(direct.mrrAt5);
      expect(expanded.supportingIds.length).toBeLessThanOrEqual(5);
      expect(expanded.supportingIds.some((id: string) => direct.ids.includes(id))).toBe(false);
      if (query.relevant.length) expect(expanded.evidenceRecallAt10).toBeGreaterThanOrEqual(direct.recallAt5);
    }
  });

  it('replays original Markdown, aliases and duplicate/archive selection without touching the caller index', () => {
    const originalCwd = process.cwd();
    const caller = realpathSync(mkdtempSync(resolve(tmpdir(), 'search-eval-caller-')));
    const document = (id: string, area: string, fields: Record<string, unknown>, body: string) => ({
      path: `.project-context/${area}/records/${id}.md`,
      markdown: renderMarkdown({ id, type: 'task', status: 'confirmed', title: id, ...fields }, body),
    });
    const snapshot = {
      kind: 'project-snapshot', version: 1, description: 'Generic snapshot replay fixture',
      capturedAt: '2026-10-12T00:00:00Z', excludedRecordIds: [],
      config: { modules: { lib: { path: 'src', aliases: ['engine'] }, other: { path: 'other', aliases: [] } } },
      documents: [
        document('A', 'active', { modules: ['lib', 'other'], files: ['package.json'], related: { tasks: ['C', 'OUTSIDE'] } }, 'Original lexical anchor café'),
        document('A', 'drafts', { modules: ['lib'], title: 'lexical anchor lexical anchor' }, 'Duplicate draft must not replace active A'),
        document('B', 'drafts', { modules: ['lib'], source_task: 'A', files: ['README.md'] }, 'Linked supporting material'),
        document('C', 'archive', { modules: ['lib'] }, 'archivetoken'),
        document('OUTSIDE', 'active', { modules: ['other'] }, 'original lexical anchor'),
      ],
      queries: [
        { id: 'S1', category: 'snapshot', query: 'lexical anchor', modules: ['engine'], relevant: ['A', 'B'], files: ['package.json', 'README.md'], rationale: 'Direct evidence and incoming summary' },
        { id: 'S2', category: 'snapshot', query: 'archivetoken', modules: ['engine'], relevant: [], files: [], rationale: 'Archive excluded' },
        { id: 'S3', category: 'snapshot', query: 'archivetoken', modules: ['engine'], includeArchive: true, relevant: ['C'], files: [], rationale: 'Archive explicitly included' },
      ],
    };
    try {
      process.chdir(caller);
      mkdirSync('.project-context/indexes', { recursive: true });
      writeFileSync('.project-context/indexes/context.sqlite', 'caller database must remain untouched');
      const report = evaluateSearch(snapshot, 1);
      expect(report).toMatchObject({ corpus: 'project-snapshot', recordFiles: 5, records: 4, queries: 3 });
      for (const engine of engines) {
        const ids = report.results[0].engines[engine].ids;
        expect(ids).toContain('A');
        expect(ids).not.toContain('OUTSIDE');
        expect(ids).not.toContain('C');
        if (engine.endsWith('+relations')) expect(ids).toContain('B');
        expect(report.results[1].engines[engine].ids).toEqual([]);
        expect(report.results[2].engines[engine].ids).toEqual(engine.endsWith('+relations') ? ['C', 'A'] : ['C']);
      }
      expect(process.cwd()).toBe(caller);
      expect(readFileSync('.project-context/indexes/context.sqlite', 'utf8')).toBe('caller database must remain untouched');
      expect(() => evaluateSearch({ ...snapshot, documents: [{ ...snapshot.documents[0], path: '../escape.md' }] }, 1)).toThrow('repository-relative');
      expect(() => evaluateSearch({ ...snapshot, documents: [{ ...snapshot.documents[0], path: '.project-context/project.yaml' }] }, 1)).toThrow('context record');
      expect(() => evaluateSearch({ ...snapshot, documents: [snapshot.documents[0], snapshot.documents[0]] }, 1)).toThrow('Duplicate document paths');
      expect(() => evaluateSearch({ ...snapshot, excludedRecordIds: ['A'] }, 1)).toThrow('excluded record');
      expect(() => evaluateSearch({ ...snapshot, queries: [{ ...snapshot.queries[0], relevant: ['OUTSIDE'] }] }, 1)).toThrow('outside indexed query scope');
      expect(process.cwd()).toBe(caller);
    } finally {
      process.chdir(originalCwd);
      rmSync(caller, { recursive: true, force: true });
    }
  });
});
