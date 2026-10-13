import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { dump } from 'js-yaml';
import { ensureFreshIndex, identifierTerms, openDb, readSearchRecords, rebuildIndex, searchIndex } from '../src/indexer/sqlite.js';
import { parseRecord, writeMarkdown } from '../src/storage/markdown.js';
import { buildContextPack, estimateTokens, isDefaultHiddenHistory } from '../src/context-pack/pack.js';
import type { ContextRecord } from '../src/storage/types.js';
import { moduleSearchNames } from '../src/storage/inference.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relativePath = z.string().min(1).refine((value) =>
  !value.includes('\\') && !value.includes(':') && !value.startsWith('/') && !value.includes('\0')
  && value.split('/')[0] !== '.git'
  && !value.split('/').some((part) => ['..', '.', ''].includes(part)), 'Expected a repository-relative file path');
const querySchema = z.object({
  id: z.string().min(1), category: z.string().min(1), query: z.string().min(1),
  modules: z.array(z.string().min(1)).min(1), includeArchive: z.boolean().default(false),
  relevant: z.array(z.string()), files: z.array(relativePath), rationale: z.string().min(1),
});
const moduleName = z.enum(['router', 'security', 'delivery', 'docs']);
const fixtureSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().min(1),
  records: z.array(z.object({
    id: z.string().regex(/^[A-Z0-9-]+$/), type: z.string().min(1), status: z.string().default('active'),
    title: z.string().min(1), body: z.string().min(1), module: moduleName.optional(),
    area: z.enum(['active', 'drafts', 'archive']).default('active'), tags: z.array(z.string()),
    files: z.array(relativePath.refine((path) => !path.startsWith('.project-context/'), 'Synthetic targets must not overwrite context data')),
    related: z.array(z.string()).default([]), source_task: z.string().optional(),
  })).min(1),
  queries: z.array(querySchema).min(1),
});
export const snapshotSchema = z.object({
  kind: z.literal('project-snapshot'), version: z.number().int().positive(), description: z.string().min(1),
  capturedAt: z.string().datetime(), excludedRecordIds: z.array(z.string()),
  config: z.object({ modules: z.record(z.string(), z.object({
    path: z.union([relativePath, z.literal('.')]), aliases: z.array(z.string()),
  })) }),
  consumer: z.object({
    projectYaml: z.string().min(1),
    supportFiles: z.array(z.object({
      path: relativePath.refine((path) => !path.startsWith('.project-context/') && !path.startsWith('node_modules/'), 'Support files must not overwrite context or dependencies'),
      content: z.string(),
    })),
  }).optional(),
  documents: z.array(z.object({
    path: relativePath.refine((path) => /^\.project-context\/(active|drafts|archive)\/.+\.md$/.test(path) && !path.endsWith('/README.md'), 'Expected a context record path'),
    markdown: z.string().min(1),
  })).min(1),
  queries: z.array(querySchema).min(1),
}).refine((snapshot) => new Set(snapshot.documents.map((document) => document.path)).size === snapshot.documents.length, 'Duplicate document paths');
export type SearchFixture = z.infer<typeof fixtureSchema>;
export type ProjectSnapshot = z.infer<typeof snapshotSchema>;
type Query = z.infer<typeof querySchema>;
export const engines = ['current', 'fts5', 'current+relations', 'fts5+relations', 'hybrid', 'hybrid+support', 'fts5+identifiers', 'fts5+identifiers+support'] as const;
type Engine = typeof engines[number];
const limit = 5;

export function validateFixture(input: unknown): SearchFixture {
  const fixture = fixtureSchema.parse(input);
  const records = new Map(fixture.records.map((record) => [record.id, record]));
  if (records.size !== fixture.records.length) throw new Error('Duplicate record IDs');
  if (new Set(fixture.queries.map((query) => query.id)).size !== fixture.queries.length) throw new Error('Duplicate query IDs');
  for (const record of fixture.records) {
    for (const id of [...record.related, ...(record.source_task ? [record.source_task] : [])]) {
      if (!records.has(id)) throw new Error(`${record.id}: unknown relationship ${id}`);
    }
  }
  for (const query of fixture.queries) {
    if (new Set(query.relevant).size !== query.relevant.length || new Set(query.files).size !== query.files.length) {
      throw new Error(`${query.id}: duplicate relevance labels`);
    }
    const expectedFiles = new Set<string>();
    for (const id of query.relevant) {
      const record = records.get(id);
      if (!record) throw new Error(`${query.id}: unknown relevant record ${id}`);
      if ((record.area === 'archive' && !query.includeArchive)
        || (record.module && !query.modules.map((name) => name === 'engine' ? 'router' : name).includes(record.module))) {
        throw new Error(`${query.id}: relevant record outside query scope: ${id}`);
      }
      record.files.forEach((file) => expectedFiles.add(file));
    }
    if (query.files.some((file) => !expectedFiles.has(file))) throw new Error(`${query.id}: file label has no relevant record`);
  }
  return fixture;
}

export function scoreHits(records: ContextRecord[], query: Pick<Query, 'relevant' | 'files'>) {
  const hits = records.slice(0, limit);
  const ids = [...new Set(hits.map((record) => record.id))];
  const matched = ids.filter((id) => query.relevant.includes(id)).length;
  const first = hits.findIndex((record) => query.relevant.includes(record.id));
  const files = new Set(hits.flatMap((record) => record.files));
  return {
    hitAt5: Number(matched > 0), recallAt5: query.relevant.length ? matched / query.relevant.length : 0,
    precisionAt5: matched / limit, mrrAt5: first < 0 ? 0 : 1 / (first + 1),
    fileReferenceRecallAt5: query.files.length ? query.files.filter((file) => files.has(file)).length / query.files.length : null,
    negativeCorrect: query.relevant.length === 0 ? hits.length === 0 : null,
    returnedTextTokensEstimate: Math.ceil(hits.reduce((sum, record) => sum + record.title.length + record.body.length, 0) / 4),
  };
}

export function supportingRecords(seeds: ContextRecord[], eligible: ContextRecord[], includeEvidence = true): ContextRecord[] {
  const byId = new Map(eligible.map((record) => [record.id, record]));
  seeds = seeds.filter((record) => byId.has(record.id)).slice(0, limit);
  const neighbors = new Map<string, Set<string>>();
  for (const record of eligible) {
    const related = record.frontmatter.related;
    const targets = related && typeof related === 'object' ? Object.values(related).flat() : [];
    for (const target of [...targets, record.frontmatter.source_task,
      ...(includeEvidence ? [record.frontmatter.target_id, record.frontmatter.retries_evidence_id] : [])]) {
      if (typeof target !== 'string' || !byId.has(target) || target === record.id) continue;
      for (const [from, to] of [[record.id, target], [target, record.id]]) {
        if (!neighbors.has(from)) neighbors.set(from, new Set());
        neighbors.get(from)!.add(to);
      }
    }
  }
  const seedIds = new Set(seeds.map((seed) => seed.id));
  return [...new Set(seeds.flatMap((seed) => [...(neighbors.get(seed.id) ?? [])].sort()))]
    .filter((id) => !includeEvidence || !seedIds.has(id)).slice(0, limit).map((id) => byId.get(id)!);
}

export function expandRelations(seeds: ContextRecord[], eligible: ContextRecord[]): ContextRecord[] {
  const byId = new Map(eligible.map((record) => [record.id, record]));
  seeds = seeds.filter((record) => byId.has(record.id)).slice(0, limit);
  return fuseRankings(seeds, supportingRecords(seeds, eligible, false));
}

export function fuseRankings(first: ContextRecord[], second: ContextRecord[], outputLimit = limit): ContextRecord[] {
  const byId = new Map([...first, ...second].map((record) => [record.id, record]));
  const scores = new Map<string, number>();
  for (const stream of [first, second]) {
    stream.forEach((record, rank) => scores.set(record.id, (scores.get(record.id) ?? 0) + 1 / (60 + rank + 1)));
  }
  const lexicalRank = new Map(first.map((record, rank) => [record.id, rank]));
  return [...scores.keys()]
    .sort((left, right) => scores.get(right)! - scores.get(left)!
      || (lexicalRank.get(left) ?? Infinity) - (lexicalRank.get(right) ?? Infinity)
      || left.localeCompare(right))
    .slice(0, outputLimit).map((id) => byId.get(id)!);
}

export { identifierTerms };

export function applyIdentifierFallback<T extends { id: string }>(fullText: T[], candidates: T[]): T[] {
  const direct = fullText.slice(0, limit);
  const seen = new Set(direct.map((record) => record.id));
  const fallback = candidates.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  }).slice(0, limit);
  return [...direct, ...fallback];
}

function identifierSearch(terms: string[], seeds: ContextRecord[], eligibleIds: Set<string>) {
  if (!terms.length || !eligibleIds.size) return { records: [] as ContextRecord[], matches: 0 };
  ensureFreshIndex();
  const db = openDb();
  try {
    // shortcut: substring vocabulary scans and frozen scope IDs suit this benchmark; evaluate scope joins before production use.
    const scope = [...eligibleIds];
    const statement = db.prepare(`SELECT records.id, records.path, search_index.title, search_index.body, search_index.tags
      FROM search_index JOIN records ON records.id = search_index.record_id
      WHERE records.id IN (SELECT record_id FROM eval_identifiers WHERE identifier != ? AND instr(identifier, ?) > 0)
      AND records.id IN (${scope.map(() => '?').join(',')})`);
    const candidates = terms.flatMap((term) => {
      const lower = term.toLowerCase();
      const rows = statement.all(lower, lower, ...scope) as Array<{ id: string; path: string; title: string; body: string; tags: string }>;
      // The existing scorer receives one marked token: weighted field matches plus one squared matched term.
      return rows.map((row) => ({ ...row, score: Number(row.title.toLowerCase().includes(lower)) * 10
        + Number(row.tags.toLowerCase().includes(lower)) * 6 + Number(row.body.toLowerCase().includes(lower)) * 2 + 1 }))
        .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
        .map(({ id, path }) => ({ id, path }));
    });
    const selected = applyIdentifierFallback(seeds.map(({ id, path }) => ({ id, path })), candidates).slice(seeds.length);
    return { records: selected.map((row) => parseRecord(resolve(process.cwd(), row.path))), matches: candidates.length };
  } finally {
    db.close();
  }
}

function ftsSearch(query: Query, eligible: ContextRecord[], outputLimit = limit): ContextRecord[] {
  const terms = query.query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((term) => term.length > 1);
  if (!terms.length || !eligible.length) return [];
  ensureFreshIndex();
  const db = openDb();
  try {
    // shortcut: frozen ID lists suit this small corpus; use SQL scope joins before evaluating production-scale data.
    const rows = db.prepare(`SELECT records.path FROM eval_fts
      JOIN records ON records.id = eval_fts.record_id
      WHERE eval_fts MATCH ? AND records.id IN (${eligible.map(() => '?').join(',')})
      ORDER BY bm25(eval_fts, 0, 10, 2, 6), records.path LIMIT ?`)
      .all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR '), ...eligible.map((record) => record.id), outputLimit) as Array<{ path: string }>;
    return rows.map((row) => parseRecord(resolve(process.cwd(), row.path)));
  } finally {
    db.close();
  }
}

const budgetLimits = z.array(z.number().int().min(32).max(100000)).min(1).max(8)
  .refine((values) => new Set(values).size === values.length, 'Duplicate context budgets');

export function budgetContext(direct: ContextRecord[], supporting: ContextRecord[], continuation: ContextRecord[], maxTokens: number) {
  z.number().int().min(32).max(100000).parse(maxTokens);
  const unit = (record: ContextRecord) => ({ id: record.id, type: record.type, status: record.status, title: record.title, body: record.body });
  const payload = { direct: [] as ReturnType<typeof unit>[], supporting: [] as ReturnType<typeof unit>[], continuation: [] as ReturnType<typeof unit>[] };
  const seen = new Set<string>();
  const skippedIds: string[] = [];
  for (const [section, records] of [['direct', direct], ['continuation', continuation], ['supporting', supporting]] as const) {
    for (const record of records) {
      if (seen.has(record.id)) continue;
      seen.add(record.id);
      payload[section].push(unit(record));
      if (estimateTokens(payload) > maxTokens) {
        payload[section].pop();
        skippedIds.push(record.id);
      }
    }
  }
  return { payload, directIds: payload.direct.map((record) => record.id), supportingIds: payload.supporting.map((record) => record.id),
    continuationIds: payload.continuation.map((record) => record.id), skippedIds, estimatedTokens: estimateTokens(payload),
    contextSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

function scoreBudget(packed: ReturnType<typeof budgetContext>, query: Query) {
  const { payload: _payload, ...context } = packed;
  const ids = [...context.directIds, ...context.continuationIds, ...context.supportingIds];
  const relevant = ids.filter((id) => query.relevant.includes(id));
  const first = ids.findIndex((id) => query.relevant.includes(id));
  return { ...context, ids, hit: Number(relevant.length > 0), recall: query.relevant.length ? relevant.length / query.relevant.length : null,
    mrr: first < 0 ? 0 : 1 / (first + 1), negativeCorrect: query.relevant.length === 0 ? ids.length === 0 : null };
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

export function evaluateSearch(input: unknown, samples = 7, budgets = [500, 1000, 2000, 4000], selectedEngines: readonly Engine[] = engines, actualContextPacks = false) {
  z.array(z.enum(engines)).min(1).refine((values) => new Set(values).size === values.length, 'Duplicate engines').parse(selectedEngines);
  budgets = budgetLimits.parse(budgets);
  const snapshot = input && typeof input === 'object' && 'kind' in input ? snapshotSchema.parse(input) : undefined;
  const fixture = snapshot ?? validateFixture(input);
  if (new Set(fixture.queries.map((query) => query.id)).size !== fixture.queries.length) throw new Error('Duplicate query IDs');
  if (!Number.isInteger(samples) || samples < 1 || samples > 100) throw new Error('Samples must be an integer from 1 to 100');
  const originalCwd = process.cwd();
  const root = mkdtempSync(resolve(tmpdir(), 'context-search-eval-'));
  try {
    process.chdir(root);
    mkdirSync('.project-context', { recursive: true });
    writeFileSync('.project-context/project.yaml', snapshot
      ? snapshot.consumer?.projectYaml ?? dump({ project: { name: 'Frozen project-memory evaluation' }, ...snapshot.config, commands: {} })
      : `project:\n  name: Synthetic retrieval evaluation\nmodules:\n  router:\n    path: src/router\n    aliases: [engine]\n  security:\n    path: src/security\n  delivery:\n    path: src/delivery\n  docs:\n    path: docs\ncommands: {}\n`);
    if (snapshot) {
      const supportFiles = snapshot.consumer?.supportFiles ?? [];
      if (new Set(supportFiles.map((file) => file.path)).size !== supportFiles.length) throw new Error('Duplicate support file paths');
      for (const file of supportFiles) {
        const path = resolve(root, file.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, file.content);
      }
      for (const document of snapshot.documents) {
        const path = resolve(root, document.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, document.markdown);
      }
    } else for (const record of (fixture as SearchFixture).records) {
      writeMarkdown(resolve(root, `.project-context/${record.area}/records/${record.id}.md`), {
        id: record.id, type: record.type, title: record.title, status: record.status,
        tags: record.tags, modules: record.module ? [record.module] : [], files: record.files,
        related: { records: record.related }, ...(record.source_task ? { source_task: record.source_task } : {}),
      }, record.body);
      for (const file of record.files) {
        mkdirSync(dirname(resolve(root, file)), { recursive: true });
        writeFileSync(resolve(root, file), '// Synthetic reference target for retrieval evaluation.\n');
      }
    }
    rebuildIndex();
    const indexedRecords = readSearchRecords({ includeArchive: true }).records;
    if (snapshot && indexedRecords.some((record) => snapshot.excludedRecordIds.includes(record.id))) {
      throw new Error('An excluded record is present in the snapshot');
    }
    const identifierIndex = { entries: 0, buildMs: 0 };
    const db = openDb();
    try {
      db.exec(`CREATE VIRTUAL TABLE eval_fts USING fts5(record_id UNINDEXED, title, body, tags, tokenize='unicode61');
        INSERT INTO eval_fts SELECT record_id, title, body, tags FROM search_index;`);
      if (selectedEngines.some((engine) => engine.includes('+identifiers'))) {
        const start = performance.now();
        db.exec('CREATE TABLE eval_identifiers (record_id TEXT NOT NULL, identifier TEXT NOT NULL, PRIMARY KEY(record_id, identifier)); BEGIN;');
        const insert = db.prepare('INSERT OR IGNORE INTO eval_identifiers VALUES (?, ?)');
        const rows = db.prepare('SELECT record_id, title, body, tags FROM search_index').all() as Array<{ record_id: string; title: string; body: string; tags: string }>;
        for (const row of rows) {
          for (const word of identifierTerms(`${row.title} ${row.body} ${row.tags}`)) insert.run(row.record_id, word.toLowerCase());
        }
        db.exec('COMMIT;');
        identifierIndex.entries = (db.prepare('SELECT COUNT(*) AS count FROM eval_identifiers').get() as { count: number }).count;
        identifierIndex.buildMs = performance.now() - start;
      }
    } finally {
      db.close();
    }
    // Freeze identical eligibility before timing; no expected labels reach retrieval.
    const scopes = new Map<string, ContextRecord[]>();
    const eligible = fixture.queries.map((query) => {
      const key = JSON.stringify([query.modules, query.includeArchive]);
      if (!scopes.has(key)) scopes.set(key, readSearchRecords({ modules: query.modules, includeArchive: query.includeArchive }).records);
      return scopes.get(key)!;
    });
    for (const [index, query] of fixture.queries.entries()) {
      if (new Set(query.relevant).size !== query.relevant.length || new Set(query.files).size !== query.files.length) throw new Error(`${query.id}: duplicate relevance labels`);
      const byId = new Map(eligible[index].map((record) => [record.id, record]));
      for (const id of query.relevant) if (!byId.has(id)) throw new Error(`${query.id}: relevant record outside indexed query scope: ${id}`);
      const expectedFiles = new Set(query.relevant.flatMap((id) => byId.get(id)!.files));
      if (query.files.some((file) => !expectedFiles.has(file))) throw new Error(`${query.id}: file label has no relevant record`);
    }
    const retrieve = (engine: Engine, query: Query, records: ContextRecord[]) => {
      const lexicalPool = engine.startsWith('hybrid')
        ? fuseRankings(ftsSearch(query, records), searchIndex(query.query, limit, query.includeArchive, query.modules), 2 * limit)
        : engine.includes('+identifiers') ? ftsSearch(query, records, 2 * limit) : [];
      const seeds = engine.startsWith('hybrid') || engine.includes('+identifiers')
        ? lexicalPool.slice(0, limit)
        : engine.startsWith('fts5') ? ftsSearch(query, records)
        : searchIndex(query.query, limit, query.includeArchive, query.modules);
      const terms = engine.includes('+identifiers') ? identifierTerms(query.query) : [];
      const allowedIds = new Set(records.map((record) => record.id));
      const fallback = identifierSearch(terms, seeds, allowedIds);
      const fallbackCandidates = fallback.records;
      const substringCandidatesParsed = fallback.records.length;
      const augmented = engine.includes('+identifiers') ? applyIdentifierFallback(seeds, fallbackCandidates) : seeds;
      const direct = augmented.slice(0, limit);
      const identifiers = augmented.slice(limit);
      const hits = engine.endsWith('+relations') ? expandRelations(direct, records) : direct;
      return { hits, identifiers, lexicalPool, identifierTerms: terms, substringCandidatesParsed, identifierCandidateMatches: fallback.matches,
        fallbackIds: augmented.filter((record) => !seeds.some((seed) => seed.id === record.id) && engine.includes('+identifiers')).map((record) => record.id),
        supporting: engine.endsWith('+support') ? supportingRecords(hits, records).filter((record) => !identifiers.some((hit) => hit.id === record.id)) : [] };
    };
    const results = fixture.queries.map((query, index) => {
      const perEngine = Object.fromEntries(selectedEngines.map((engine) => {
        const { hits, identifiers, supporting, lexicalPool, identifierTerms, fallbackIds, substringCandidatesParsed, identifierCandidateMatches } = retrieve(engine, query, eligible[index]);
        const combined = [...hits, ...identifiers, ...supporting];
        const continuation = [...identifiers, ...lexicalPool.filter((record) => ![...hits, ...identifiers].some((hit) => hit.id === record.id)).slice(0, limit)];
        const bounded = budgets.map((maxTokens) => ({ maxTokens,
          ...scoreBudget(budgetContext(hits, supporting, identifiers, maxTokens), query),
          lexicalControl: engine.startsWith('hybrid') || engine.includes('+identifiers')
            ? scoreBudget(budgetContext(hits, [], continuation, maxTokens), query) : null,
        }));
        return [engine, { budgets: bounded, substringCandidatesParsed, identifierCandidateMatches, identifierIds: identifiers.map((record) => record.id),
          expandedRecall: query.relevant.length ? combined.filter((record) => query.relevant.includes(record.id)).length / query.relevant.length : null,
          expandedLimit: engine.includes('+identifiers') && engine.endsWith('+support') ? 15 : 10, identifierTerms, fallbackIds, lexicalPoolIds: lexicalPool.map((record) => record.id),
          lexicalPoolRecallAt10: (engine.startsWith('hybrid') || engine.includes('+identifiers')) && query.relevant.length
            ? lexicalPool.filter((record) => query.relevant.includes(record.id)).length / query.relevant.length : null,
          lexicalPoolTextTokensEstimate: engine.startsWith('hybrid') || engine.includes('+identifiers')
            ? Math.ceil(lexicalPool.reduce((sum, record) => sum + record.title.length + record.body.length, 0) / 4) : null,
          supportingIds: supporting.map((record) => record.id),
          evidenceRecallAt10: query.relevant.length ? combined.slice(0, 2 * limit).filter((record) => query.relevant.includes(record.id)).length / query.relevant.length : null,
          expandedTextTokensEstimate: Math.ceil(combined.reduce((sum, record) => sum + record.title.length + record.body.length, 0) / 4),
          ids: hits.map((record) => record.id), ...scoreHits(hits, query), latencyMs: [] as number[] }];
      }));
      return { id: query.id, category: query.category, query: query.query, modules: query.modules, includeArchive: query.includeArchive, eligibleRecords: eligible[index].length,
        rationale: query.rationale, relevant: query.relevant, expectedFiles: query.files, engines: perEngine };
    });
    // Rotate query and engine order to avoid always timing one variant first.
    for (let sample = 0; sample < samples; sample++) {
      for (let offset = 0; offset < fixture.queries.length; offset++) {
        const index = (offset + sample) % fixture.queries.length;
        for (let e = 0; e < selectedEngines.length; e++) {
          const engine = selectedEngines[(e + sample) % selectedEngines.length];
          const start = performance.now();
          const { hits, identifiers, supporting, lexicalPool, fallbackIds, substringCandidatesParsed, identifierCandidateMatches } = retrieve(engine, fixture.queries[index], eligible[index]);
          const elapsed = performance.now() - start;
          const result = results[index].engines[engine];
          if (hits.map((record) => record.id).join('\0') !== result.ids.join('\0')
            || supporting.map((record) => record.id).join('\0') !== result.supportingIds.join('\0')
            || lexicalPool.map((record) => record.id).join('\0') !== result.lexicalPoolIds.join('\0')
            || fallbackIds.join('\0') !== result.fallbackIds.join('\0')
            || identifiers.map((record) => record.id).join('\0') !== result.identifierIds.join('\0')
            || substringCandidatesParsed !== result.substringCandidatesParsed
            || identifierCandidateMatches !== result.identifierCandidateMatches) throw new Error(`Non-deterministic ${engine} result for ${fixture.queries[index].id}`);
          result.latencyMs.push(elapsed);
        }
      }
    }
    const summarize = (rows: typeof results) => Object.fromEntries(selectedEngines.map((engine) => {
      const positive = rows.filter((row) => row.relevant.length).map((row) => row.engines[engine]);
      const negatives = rows.filter((row) => !row.relevant.length).map((row) => row.engines[engine]);
      const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      const latency = rows.flatMap((row) => row.engines[engine].latencyMs);
      const bounded = budgets.map((maxTokens) => {
        const budgetRows = rows.map((row) => ({ positive: row.relevant.length > 0,
          context: row.engines[engine].budgets.find((item) => item.maxTokens === maxTokens)! }));
        const summarizeBudget = (items: Array<{ positive: boolean; context: ReturnType<typeof scoreBudget> }>) => ({
          recall: mean(items.filter((item) => item.positive).map((item) => item.context.recall!)),
          hit: mean(items.filter((item) => item.positive).map((item) => item.context.hit)),
          mrr: mean(items.filter((item) => item.positive).map((item) => item.context.mrr)),
          negativeAccuracy: mean(items.filter((item) => !item.positive).map((item) => Number(item.context.negativeCorrect))),
          tokensMean: mean(items.map((item) => item.context.estimatedTokens)),
          retainedRecordsMean: mean(items.map((item) => item.context.ids.length)),
          supportingRecordsMean: mean(items.map((item) => item.context.supportingIds.length)),
          skippedRecordsMean: mean(items.map((item) => item.context.skippedIds.length)),
        });
        return { maxTokens, ...summarizeBudget(budgetRows),
          lexicalControl: budgetRows.some((row) => row.context.lexicalControl !== null)
            ? summarizeBudget(budgetRows.map((row) => ({ positive: row.positive, context: row.context.lexicalControl! }))) : null };
      });
      return [engine, {
        budgets: bounded,
        fallbackQueries: rows.filter((row) => row.engines[engine].fallbackIds.length).length,
        expandedRecall: mean(positive.map((row) => row.expandedRecall!)),
        lexicalPoolTextTokensMean: mean(rows.flatMap((row) => row.engines[engine].lexicalPoolTextTokensEstimate === null ? [] : [row.engines[engine].lexicalPoolTextTokensEstimate!])),
        lexicalPoolRecallAt10: mean(positive.flatMap((row) => row.lexicalPoolRecallAt10 === null ? [] : [row.lexicalPoolRecallAt10])),
        evidenceRecallAt10: mean(positive.map((row) => row.evidenceRecallAt10!)),
        expandedTextTokensMean: mean(rows.map((row) => row.engines[engine].expandedTextTokensEstimate)),
        hitAt5: mean(positive.map((row) => row.hitAt5)), recallAt5: mean(positive.map((row) => row.recallAt5)),
        precisionAt5: mean(positive.map((row) => row.precisionAt5)), mrrAt5: mean(positive.map((row) => row.mrrAt5)),
        fileReferenceRecallAt5: mean(positive.flatMap((row) => row.fileReferenceRecallAt5 === null ? [] : [row.fileReferenceRecallAt5])),
        negativeAccuracy: mean(negatives.map((row) => Number(row.negativeCorrect))),
        latencyP50Ms: percentile(latency, 0.5), latencyP95Ms: percentile(latency, 0.95),
        returnedTextTokensMean: mean(rows.map((row) => row.engines[engine].returnedTextTokensEstimate)),
      }];
    }));
    return {
      datasetVersion: fixture.version, corpus: snapshot ? 'project-snapshot' : 'synthetic',
      records: indexedRecords.length, recordFiles: snapshot ? snapshot.documents.length : (fixture as SearchFixture).records.length,
      recordTypes: Object.fromEntries([...new Set(indexedRecords.map((record) => record.type))].map((type) =>
        [type, indexedRecords.filter((record) => record.type === type).length])),
      ...(snapshot ? { capturedAt: snapshot.capturedAt, excludedRecordIds: snapshot.excludedRecordIds } : {}),
      queries: fixture.queries.length,
      positiveQueries: fixture.queries.filter((query) => query.relevant.length).length,
      negativeQueries: fixture.queries.filter((query) => !query.relevant.length).length, samples, limit, engines: selectedEngines,
      identifierIndex,
      identifierFallbackPolicy: 'Preserve FTS5 top5, filter proper matches in the disposable identifier projection; score/deduplicate before reading up to5 new records; direct5 plus identifier overflow',
      budgetPolicy: { limits: budgets, estimator: 'estimateTokens: JSON UTF-8 bytes / 3, rounded up',
        packing: 'Complete record units, direct first, identifier/lexical continuation next, support last; skip non-fitting units in order',
        fields: ['id', 'type', 'status', 'title', 'body'], noTruncation: true },
      summary: summarize(results),
      ...(actualContextPacks ? { contextPacks: evaluateRuntimePacks(fixture.queries, indexedRecords, eligible, budgets) } : {}),
      categories: Object.fromEntries([...new Set(results.map((row) => row.category))].map((category) =>
        [category, summarize(results.filter((row) => row.category === category))])),
      results,
    };
  } finally {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
  }
}

function evaluateRuntimePacks(queries: Query[], allRecords: ContextRecord[], eligible: ContextRecord[][], budgets: number[]) {
  const results = queries.flatMap((query, index) => [false, true].flatMap((includeHistory) => budgets.flatMap((maxTokens) =>
    (['current', 'fts5'] as const).map((searchEngine) => {
      const input = { query: query.query, modules: query.modules, includeArchive: query.includeArchive,
        includeHistory, maxTokens, searchEngine, workflow: 'standard' as const };
      const start = performance.now();
      const { cache, ...pack } = buildContextPack(input);
      const latencyMs = performance.now() - start;
      if (searchEngine === 'fts5' && pack.warnings.some((warning) => warning.includes('FTS5 unavailable'))) throw new Error('Runtime FTS5 unexpectedly unavailable');
      const ids = pack.records.map((record) => record.id);
      const excerptIds = pack.records.filter((record) => Boolean(record.excerpt?.trim())).map((record) => record.id);
      const modules = moduleSearchNames(pack.routing?.modules ?? []);
      const visible = allRecords.filter((record) => (input.includeArchive || !record.archived)
        && (!modules.length || !record.modules.length || record.modules.some((module) => modules.includes(module)))
        && !record.path.includes('/drafts/') && !isDefaultHiddenHistory(record, input));
      if (ids.some((id) => !visible.some((record) => record.id === id))) throw new Error(`${query.id}: out-of-scope runtime pack record`);
      if (pack.budget.exceedsLimit !== (pack.budget.estimatedTokens > maxTokens)) throw new Error(`${query.id}: incorrect budget flag`);
      // Consumer required guidance can exceed the budget after all optional payload has been removed.
      if (pack.budget.exceedsLimit && (ids.length || pack.files.length || !pack.playbookDetails.some((book) => book.required)
        || pack.playbookDetails.some((book) => !book.required)
        || !pack.warnings.some((warning) => warning.startsWith('Required playbooks and payload exceed')))) {
        throw new Error(`${query.id}: unexpected runtime budget overflow`);
      }
      const recall = (hits: string[], relevant: string[]) => relevant.length ? hits.filter((id) => relevant.includes(id)).length / relevant.length : null;
      const visibleRelevant = query.relevant.filter((id) => visible.some((record) => record.id === id));
      return { id: query.id, category: query.category, relevant: query.relevant, includeHistory, maxTokens, searchEngine,
        policyHiddenRelevantIds: query.relevant.filter((id) => !visibleRelevant.includes(id)),
        routedModules: pack.routing?.modules, requestedScopeExtraIds: ids.filter((id) => !eligible[index].some((record) => record.id === id)),
        ids, excerptIds, sourceOnlyIds: ids.filter((id) => !excerptIds.includes(id)),
        identifierIds: pack.records.filter((record) => record.reason === 'Matched partial identifier reserve.').map((record) => record.id),
        recall: recall(ids, query.relevant), excerptRecall: recall(excerptIds, query.relevant), visibleRecall: recall(ids, visibleRelevant),
        negativeCorrect: query.relevant.length ? null : ids.length === 0,
        estimatedTokens: pack.budget.estimatedTokens, budget: pack.budget, files: pack.files.map((file) => file.path),
        cacheStatus: cache?.status, latencyMs, warnings: pack.warnings,
        contextSha256: createHash('sha256').update(JSON.stringify(pack)).digest('hex'), pack };
    }))));
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const summary = [false, true].flatMap((includeHistory) => budgets.flatMap((maxTokens) => (['current', 'fts5'] as const).map((searchEngine) => {
    const rows = results.filter((row) => row.includeHistory === includeHistory && row.maxTokens === maxTokens && row.searchEngine === searchEngine);
    return { includeHistory, maxTokens, searchEngine,
      recall: mean(rows.flatMap((row) => row.recall === null ? [] : [row.recall])),
      excerptRecall: mean(rows.flatMap((row) => row.excerptRecall === null ? [] : [row.excerptRecall])),
      visibleRecall: mean(rows.flatMap((row) => row.visibleRecall === null ? [] : [row.visibleRecall])),
      negativeAccuracy: mean(rows.flatMap((row) => row.negativeCorrect === null ? [] : [Number(row.negativeCorrect)])),
      budgetExceededPacks: rows.filter((row) => row.budget.exceedsLimit).length,
      estimatedTokensMean: mean(rows.map((row) => row.estimatedTokens)),
      sourceOnlyRecordsMean: mean(rows.map((row) => row.sourceOnlyIds.length)),
      latencyP50Ms: percentile(rows.map((row) => row.latencyMs), 0.5), latencyP95Ms: percentile(rows.map((row) => row.latencyMs), 0.95) };
  })));
  return { policy: 'Actual buildContextPack, standard workflow, unchanged excerpt/provenance/budget machinery; default history policy and explicit history control; no graph', summary, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { fixture: { type: 'string' }, output: { type: 'string' }, samples: { type: 'string', default: '7' }, budgets: { type: 'string', default: '500,1000,2000,4000' }, engines: { type: 'string' }, 'context-packs': { type: 'boolean', default: false } } });
  const datasetBytes = readFileSync(values.fixture ? resolve(values.fixture) : resolve(packageRoot, 'test/fixtures/search-eval.json'));
  const sourceFiles = ['scripts/search-eval.ts', 'src/indexer/sqlite.ts', 'src/indexer/capabilities.ts', 'src/storage/markdown.ts', 'src/storage/config.ts', 'src/storage/inference.ts', 'src/storage/repo.ts', 'src/context-pack/pack.ts'];
  const sourceHash = createHash('sha256');
  for (const file of sourceFiles) sourceHash.update(file).update('\0').update(readFileSync(resolve(packageRoot, file))).update('\0');
  const report = {
    provenance: {
      datasetSha256: createHash('sha256').update(datasetBytes).digest('hex'), sourceSha256: sourceHash.digest('hex'),
      sourceFiles, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' }).trim(),
      node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch,
      cpu: cpus()[0]?.model,
      generatedAt: new Date().toISOString(),
    },
    ...evaluateSearch(JSON.parse(datasetBytes.toString('utf8')), Number(values.samples), values.budgets!.split(',').map(Number),
      values.engines ? z.array(z.enum(engines)).parse(values.engines.split(',')) : engines, values['context-packs']),
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    const output = resolve(values.output);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, json);
    process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
  } else process.stdout.write(json);
}
