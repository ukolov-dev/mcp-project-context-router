import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import matter from 'gray-matter';
import { renderMarkdown } from '../src/storage/markdown.js';
import { snapshotSchema, validateFixture } from './search-eval.js';
import type { ProjectSnapshot, SearchFixture } from './search-eval.js';

const templates = [
  { title: 'Museum specimen census', body: 'Amber pebbles and fossil specimens were counted in a fictional museum cabinet.' },
  { title: 'Fictional observatory vocabulary', body: 'A word exercise lists SQLite cache index Windows verification context research handoff release execution contract. It supplies no project policy, implementation or evidence.' },
  { title: 'Unrelated spelling glossary', body: 'Fragment spellings: ModuleName buildContext relPa quick_valid feature_req ISSUE_TEMPL bug_rep node_mod ready_to PROJECT_CONT retries_evid missing_ident. These exact glossary fragments supply no longer identifiers or project behavior.' },
];

// shortcut: authored negative templates model load, validate with a large independent real corpus before production decisions.
export function scaleCorpus(input: SearchFixture | ProjectSnapshot, total: number) {
  const snapshot = 'documents' in input;
  if (snapshot) snapshotSchema.parse(input); else validateFixture(input);
  const count = snapshot ? input.documents.length : input.records.length;
  z.number().int().min(count).max(20000).parse(total);
  const additions: SearchFixture['records'] = [];
  for (let i = 0; i < total - count; i++) {
    const id = `LOAD-${String(i).padStart(6, '0')}`;
    const template = templates[i % 10 < 8 ? 0 : i % 10 === 8 ? 1 : 2];
    const module = Math.floor(i / 10) % 20 === 0 ? 'security' : Math.floor(i / 10) % 20 === 1 ? 'docs' : 'router';
    const area = Math.floor(i / 100) % 10 === 0 ? 'archive' : 'active';
    const padding = ' Specimen amber pebble census. Образец минерала.';
    const body = `${template.body} Cabinet ${i}.${padding.repeat([4, 20, 80][i % 3])}`;
    additions.push({ id, type: 'source', status: 'active', title: `${template.title} ${i}`, body, module, area,
      tags: ['synthetic-load'], files: [], related: i > 0 ? [`LOAD-${String(i - 1).padStart(6, '0')}`] : [] });
  }
  const originalIds = new Set(snapshot ? input.documents.map((document) => matter(document.markdown).data.id) : input.records.map((record) => record.id));
  if (additions.some((record) => originalIds.has(record.id))) throw new Error('Synthetic load ID collision');
  if (!snapshot) return { ...input, records: [...input.records, ...additions] };
  const documents = additions.map((record) => ({
    path: `.project-context/${record.area}/synthetic-load/${record.id}.md`,
    markdown: renderMarkdown({ id: record.id, type: record.type, status: record.status, title: record.title, tags: record.tags,
      modules: [record.module], related: { records: record.related } }, record.body),
  }));
  // Router/docs are existing scopes; a separate module keeps unrelated security load out of those searches.
  return { ...input, config: { ...input.config, modules: { ...input.config.modules,
    ...(!input.config.modules.security ? { security: { path: 'synthetic-security', aliases: [] } } : {}) } },
    documents: [...input.documents, ...documents] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { fixture: { type: 'string' }, records: { type: 'string' }, output: { type: 'string' } } });
  if (!values.fixture || !values.output || !values.records) throw new Error('Required: --fixture, --records, --output');
  if (resolve(values.fixture) === resolve(values.output)) throw new Error('Output must not overwrite the base fixture');
  const bytes = readFileSync(resolve(values.fixture));
  const result = scaleCorpus(JSON.parse(bytes.toString('utf8')), Number(values.records));
  const output = `${JSON.stringify(result, null, 2)}\n`;
  mkdirSync(dirname(resolve(values.output)), { recursive: true });
  writeFileSync(resolve(values.output), output);
  process.stdout.write(`${JSON.stringify({ records: Number(values.records), baseSha256: createHash('sha256').update(bytes).digest('hex'),
    datasetSha256: createHash('sha256').update(output).digest('hex'), generatorSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
    generatedRecords: Number(values.records) - ('documents' in result ? JSON.parse(bytes.toString('utf8')).documents.length : JSON.parse(bytes.toString('utf8')).records.length),
    distribution: '80% neutral,10% vocabulary,10% exact identifier glossary; 90% router,5% docs,5% security;10% archive;three full-body sizes;load-only chain edges' })}\n`);
}
