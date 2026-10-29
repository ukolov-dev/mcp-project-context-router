import { retiredRecordTypes } from '../storage/record-types.js';
import { withFileOperation } from '../storage/operation.js';
import { extractSymbolGraph } from '../symbol-graph/extract.js';
import { moduleSearchNames, resolveModuleName } from '../storage/inference.js';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoPaths } from '../storage/repo.js';
import { checksumForFile, discoverRecordFiles, parseRecord, readRecords } from '../storage/markdown.js';
import type { ContextRecord } from '../storage/types.js';
import { classifyFileReference, collectFileReferenceIssues, type FileReferenceIssue } from '../storage/file-references.js';
import {
  capabilitySourceFiles,
  discoverCapabilities,
  discoverCapabilitySourceFingerprint,
  discoverCapabilitySourceStateFingerprint,
} from './capabilities.js';

const schemaVersion = '7';

export const searchEngines = ['current', 'fts5'] as const;
export type SearchEngine = typeof searchEngines[number];

export function parseSearchEngine(value: unknown): SearchEngine {
  if (value === undefined || value === 'current') return 'current';
  if (value === 'fts5') return 'fts5';
  throw new Error('searchEngine must be current or fts5');
}

export function identifierTerms(query: string): string[] {
  return [...new Set((query.match(/[\p{L}_][\p{L}\p{N}_]*/gu) ?? [])
    .filter((term) => /\p{Ll}\p{Lu}|[\p{L}\p{N}]_[\p{L}\p{N}]/u.test(term)))];
}

export function openDb(): DatabaseSync {
  const paths = repoPaths();
  mkdirSync(dirname(paths.sqlitePath), { recursive: true });
  for (let attempt = 0; ; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(paths.sqlitePath);
      if (hasLegacyFtsIndex(db)) {
        db.close();
        db = undefined;
        removeRebuildableIndex(paths.sqlitePath);
        indexFreshnessCheckedAt.delete(paths.root);
        db = new DatabaseSync(paths.sqlitePath);
      }
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      ensureSchema(db);
      return db;
    } catch (error) {
      db?.close();
      // Only corruption of this disposable index permits deletion. Busy, readonly,
      // permission and I/O errors must preserve the existing database.
      if (attempt > 0 || !isCorruptIndex(error)) throw error;
      removeRebuildableIndex(paths.sqlitePath);
      indexFreshnessCheckedAt.delete(paths.root);
    }
  }
}

function isCorruptIndex(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('errcode' in error) || typeof error.errcode !== 'number') return false;
  const primaryCode = error.errcode & 0xff;
  return primaryCode === 11 || primaryCode === 26; // SQLITE_CORRUPT, SQLITE_NOTADB
}

function hasLegacyFtsIndex(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'search_index'").get() as
    | { sql?: string }
    | undefined;
  return /\bVIRTUAL\s+TABLE\b[\s\S]*\bfts5\b/i.test(row?.sql ?? '');
}

function removeRebuildableIndex(sqlitePath: string): void {
  rmSync(sqlitePath, { force: true });
  rmSync(`${sqlitePath}-wal`, { force: true });
  rmSync(`${sqlitePath}-shm`, { force: true });
}

export function ensureSchema(db: DatabaseSync): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT,
  last_used_at TEXT,
  retention TEXT NOT NULL DEFAULT 'normal',
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS record_tags (
  record_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (record_id, tag)
);
CREATE TABLE IF NOT EXISTS record_modules (
  record_id TEXT NOT NULL,
  module TEXT NOT NULL,
  PRIMARY KEY (record_id, module)
);
CREATE TABLE IF NOT EXISTS record_files (
  record_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  commit_sha TEXT,
  checksum TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (record_id, file_path, line_start, line_end)
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  module TEXT,
  file_path TEXT NOT NULL,
  line_start INTEGER,
  line_end INTEGER,
  signature TEXT,
  exported INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS symbol_relations (
  source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation_type TEXT NOT NULL,
  file_path TEXT NOT NULL, line INTEGER NOT NULL,
  PRIMARY KEY (source_id, target_id, relation_type, file_path, line)
);
CREATE INDEX IF NOT EXISTS symbol_relations_target ON symbol_relations(target_id);
CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  module TEXT NOT NULL,
  controller_symbol_id TEXT,
  file_path TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS relations (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  PRIMARY KEY (source_id, target_id, relation_type)
);
CREATE TABLE IF NOT EXISTS index_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_index (
  record_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  tags TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}'
);
`);
  const symbolColumns = db.prepare('PRAGMA table_info(symbols)').all() as Array<{ name: string }>;
  if (!symbolColumns.some(column => column.name === 'graph_node')) db.exec('ALTER TABLE symbols ADD COLUMN graph_node INTEGER NOT NULL DEFAULT 0');
  const columns = db.prepare('PRAGMA table_info(search_index)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'metadata')) {
    db.exec("ALTER TABLE search_index ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'");
  }
}

export type IndexRebuildResult = {
  records: number;
  symbols: number;
  endpoints: number;
  fileReferenceIssues: FileReferenceIssue[];
  duplicateRecordIssues: DuplicateRecordIssue[];
};

export type IndexHealthResult = {
  fresh: boolean;
  fileReferenceIssues: FileReferenceIssue[];
  duplicateRecordIssues: DuplicateRecordIssue[];
};

export type DuplicateRecordIssue = {
  recordId: string;
  paths: string[];
};

export type IndexRefreshResult = {
  status: 'fresh' | 'rebuilt' | 'throttled';
  checkedAt: string;
  records?: number;
  symbols?: number;
  endpoints?: number;
};

const indexFreshnessCheckedAt = new Map<string, number>();
const defaultFreshnessTtlMs = 1_000;

export function rebuildIndex(): IndexRebuildResult {
  return withFileOperation(() => rebuildIndexInOperation());
}

function rebuildIndexInOperation(): IndexRebuildResult {
  const records = readRecords(true);
  const fileReferenceIssues = collectFileReferenceIssues(records);
  const { indexableRecords, duplicateRecordIssues } = selectIndexableRecords(records);
  const { capabilities, endpoints, sourceFingerprint } = discoverCapabilities();
  const graph = extractSymbolGraph(capabilitySourceFiles(), capabilities);
  const allSymbols = new Map([...capabilities, ...graph.nodes].map(node => [node.id, node]));
  const recordFingerprint = fingerprintRecords(indexableRecords);
  const recordSourceState = fingerprintFileState(discoverRecordFiles(true));
  const capabilitySourceState = discoverCapabilitySourceStateFingerprint();
  const db = openDb();
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec(`
DELETE FROM records;
DELETE FROM record_tags;
DELETE FROM record_modules;
DELETE FROM record_files;
DELETE FROM symbols;
DELETE FROM symbol_relations;
DELETE FROM endpoints;
DELETE FROM relations;
DELETE FROM index_metadata;
DELETE FROM search_index;
`);
    const insertRecord = db.prepare(`
INSERT INTO records (id, type, status, title, path, created_at, updated_at, retention, archived)
VALUES (@id, @type, @status, @title, @path, @createdAt, @updatedAt, @retention, @archived)
`);
    const insertTag = db.prepare('INSERT OR IGNORE INTO record_tags (record_id, tag) VALUES (?, ?)');
    const insertModule = db.prepare('INSERT OR IGNORE INTO record_modules (record_id, module) VALUES (?, ?)');
    const insertFile = db.prepare(`
INSERT OR REPLACE INTO record_files (record_id, file_path, line_start, line_end, checksum, stale)
VALUES (?, ?, NULL, NULL, ?, ?)
`);
    const insertSearch = db.prepare('INSERT INTO search_index (record_id, title, body, tags, metadata) VALUES (?, ?, ?, ?, ?)');
    for (const record of indexableRecords) {
      insertRecord.run({
        id: record.id,
        type: record.type,
        status: record.status,
        title: record.title,
        path: record.path,
        createdAt: record.createdAt ?? null,
        updatedAt: record.updatedAt ?? null,
        retention: record.retention,
        archived: record.archived ? 1 : 0,
      });
      for (const tag of record.tags) insertTag.run(record.id, tag);
      for (const module of record.modules) insertModule.run(record.id, module);
      for (const file of record.files) {
        const reference = classifyFileReference(file);
        const checksum = reference.kind === 'file' ? checksumForFile(reference.absolutePath) : null;
        insertFile.run(record.id, file, checksum, checksum ? 0 : 1);
      }
      const { body, ...metadata } = record;
      insertSearch.run(record.id, record.title, body, record.tags.join(' '), JSON.stringify(metadata));
    }
    const insertSymbol = db.prepare(`
INSERT OR REPLACE INTO symbols (id, name, kind, module, file_path, line_start, line_end, signature, exported)
VALUES (@id, @name, @kind, @module, @filePath, @lineStart, @lineEnd, @signature, @exported)
`);
    for (const capability of allSymbols.values()) {
      insertSymbol.run({
        id: capability.id,
        name: capability.name,
        kind: capability.kind,
        module: capability.module ?? null,
        filePath: capability.filePath,
        lineStart: capability.lineStart ?? null,
        lineEnd: capability.lineEnd ?? null,
        signature: capability.signature ?? null,
        exported: capability.exported ? 1 : 0,
      });
    }
    const insertEndpoint = db.prepare(`
INSERT OR REPLACE INTO endpoints (id, method, path, module, controller_symbol_id, file_path)
VALUES (@id, @method, @path, @module, @controllerSymbolId, @filePath)
`);
    for (const endpoint of endpoints) {
      insertEndpoint.run({
        id: endpoint.id,
        method: endpoint.method,
        path: endpoint.path,
        module: endpoint.module,
        controllerSymbolId: endpoint.controllerSymbolId ?? null,
        filePath: endpoint.filePath,
      });
    }
    const markGraphNode = db.prepare('UPDATE symbols SET graph_node = 1 WHERE id = ?');
    for (const node of graph.nodes) markGraphNode.run(node.id);
    const insertEdge = db.prepare('INSERT OR IGNORE INTO symbol_relations VALUES (?, ?, ?, ?, ?)');
    for (const edge of graph.edges) insertEdge.run(edge.source, edge.target, edge.relation, edge.file, edge.line);
    db.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?)').run('symbol_graph_coverage', JSON.stringify(graph.coverage));
    const insertMetadata = db.prepare('INSERT INTO index_metadata (key, value) VALUES (?, ?)');
    insertMetadata.run('record_fingerprint', recordFingerprint);
    insertMetadata.run('capability_source_fingerprint', sourceFingerprint);
    insertMetadata.run('record_source_state', recordSourceState);
    insertMetadata.run('capability_source_state', capabilitySourceState);
    insertMetadata.run('record_count', String(indexableRecords.length));
    insertMetadata.run('schema_version', schemaVersion);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // The statement that failed may already have ended the transaction.
    }
    db.close();
    throw error;
  }
  db.close();
  indexFreshnessCheckedAt.set(repoPaths().root, Date.now());
  return {
    records: indexableRecords.length,
    symbols: allSymbols.size,
    endpoints: endpoints.length,
    fileReferenceIssues,
    duplicateRecordIssues,
  };
}

export function ensureFreshIndex(options: { force?: boolean; ttlMs?: number } = {}): IndexRefreshResult {
  const root = repoPaths().root;
  const now = Date.now();
  const ttlMs = Math.max(0, options.ttlMs ?? defaultFreshnessTtlMs);
  const lastCheckedAt = indexFreshnessCheckedAt.get(root) ?? 0;
  if (!options.force && now - lastCheckedAt < ttlMs) {
    return { status: 'throttled', checkedAt: new Date(lastCheckedAt).toISOString() };
  }

  if (checkIndexFreshQuick()) {
    indexFreshnessCheckedAt.set(root, now);
    return { status: 'fresh', checkedAt: new Date(now).toISOString() };
  }

  const rebuilt = rebuildIndex();
  return {
    status: 'rebuilt',
    checkedAt: new Date().toISOString(),
    records: rebuilt.records,
    symbols: rebuilt.symbols,
    endpoints: rebuilt.endpoints,
  };
}

export function checkIndexFresh(): boolean {
  return checkIndexHealth().fresh;
}

export function checkIndexFreshQuick(): boolean {
  try {
    const db = openDb();
    let metadataRows: Array<{ key: string; value: string }>;
    try {
      metadataRows = db.prepare('SELECT key, value FROM index_metadata').all() as Array<{ key: string; value: string }>;
    } finally {
      db.close();
    }
    const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
    return metadata.get('schema_version') === schemaVersion
      && metadata.get('record_source_state') === fingerprintFileState(discoverRecordFiles(true))
      && metadata.get('capability_source_state') === discoverCapabilitySourceStateFingerprint();
  } catch {
    return false;
  }
}

export function checkIndexHealth(records = readRecords(true)): IndexHealthResult {
  const db = openDb();
  let count: { count: number };
  let metadataRows: Array<{ key: string; value: string }>;
  try {
    count = db.prepare('SELECT COUNT(*) AS count FROM records').get() as { count: number };
    metadataRows = db.prepare('SELECT key, value FROM index_metadata').all() as Array<{ key: string; value: string }>;
  } finally {
    db.close();
  }
  const { indexableRecords, duplicateRecordIssues } = selectIndexableRecords(records);
  const metadata = new Map(metadataRows.map((row) => [row.key, row.value]));
  return {
    fresh: count.count === indexableRecords.length
      && metadata.get('schema_version') === schemaVersion
      && metadata.get('record_fingerprint') === fingerprintRecords(indexableRecords)
      && metadata.get('capability_source_fingerprint') === discoverCapabilitySourceFingerprint(),
    fileReferenceIssues: collectFileReferenceIssues(records),
    duplicateRecordIssues,
  };
}

export function collectDuplicateRecordIssues(records: ContextRecord[]): DuplicateRecordIssue[] {
  return selectIndexableRecords(records).duplicateRecordIssues;
}

function selectIndexableRecords(records: ContextRecord[]): { indexableRecords: ContextRecord[]; duplicateRecordIssues: DuplicateRecordIssue[] } {
  const byId = new Map<string, ContextRecord>();
  const duplicates = new Map<string, Set<string>>();
  for (const record of [...records].sort(compareRecordsForIndex)) {
    const existing = byId.get(record.id);
    if (!existing) {
      byId.set(record.id, record);
      continue;
    }
    const paths = duplicates.get(record.id) ?? new Set<string>([existing.path]);
    paths.add(record.path);
    duplicates.set(record.id, paths);
  }
  return {
    indexableRecords: [...byId.values()],
    duplicateRecordIssues: [...duplicates.entries()]
      .map(([recordId, paths]) => ({ recordId, paths: [...paths].sort(compareRecordPathsForIndex) }))
      .sort((left, right) => left.recordId.localeCompare(right.recordId)),
  };
}

function compareRecordsForIndex(left: ContextRecord, right: ContextRecord): number {
  return compareRecordPathsForIndex(left.path, right.path);
}

function compareRecordPathsForIndex(left: string, right: string): number {
  return recordPathRank(left) - recordPathRank(right) || left.localeCompare(right);
}

function recordPathRank(path: string): number {
  if (path.startsWith('.project-context/active/')) return 0;
  if (path.startsWith('.project-context/drafts/')) return 1;
  if (path.startsWith('.project-context/archive/')) return 2;
  return 3;
}

function openFreshDb(): DatabaseSync {
  ensureFreshIndex();
  const db = openDb();
  try {
    const version = db.prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (version?.value === schemaVersion) return db;
  } catch (error) {
    db.close();
    throw error;
  }
  // openDb may have recovered a corrupt/missing index within the freshness TTL.
  // Populate that replacement before allowing callers to read it.
  db.close();
  rebuildIndex();
  return openDb();
}

function readFromIndex<T>(read: (db: DatabaseSync) => T): T {
  for (let attempt = 0; ; attempt += 1) {
    let db: DatabaseSync | undefined;
    try {
      db = openFreshDb();
      return read(db);
    } catch (error) {
      if (attempt > 0 || !isCorruptIndex(error)) throw error;
    } finally {
      db?.close();
    }
    // Corruption can also be encountered in data pages after opening the schema.
    const paths = repoPaths();
    removeRebuildableIndex(paths.sqlitePath);
    indexFreshnessCheckedAt.delete(paths.root);
  }
}

function indexedRecordRows<T>(projection: string, includeArchive: boolean, modules: string[], recordId?: string): T[] {
  const moduleFilter = recordModuleFilter(modules);
  return readFromIndex((db) => db.prepare(`
SELECT ${projection}
FROM search_index
JOIN records ON records.id = search_index.record_id
WHERE (? = 1 OR records.archived = 0)
${moduleFilter}
${recordId === undefined ? '' : 'AND records.id = ?'}
`).all(includeArchive ? 1 : 0, ...modules, ...(recordId === undefined ? [] : [recordId])) as T[]);
}

function recordModuleFilter(modules: string[]): string {
  return modules.length > 0
    ? `AND (NOT EXISTS (SELECT 1 FROM record_modules WHERE record_modules.record_id = records.id)
      OR EXISTS (SELECT 1 FROM record_modules WHERE record_modules.record_id = records.id AND record_modules.module IN (${modules.map(() => '?').join(',')})))`
    : '';
}

function ensureFtsProjection(db: DatabaseSync): void {
  const ready = () => (db.prepare("SELECT value FROM index_metadata WHERE key = 'fts_projection_version'").get() as { value: string } | undefined)?.value === '1'
    && (db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN ('record_fts', 'record_identifiers')").get() as { count: number }).count === 2;
  if (ready()) return;
  // Rebuild clears the marker atomically; current search never needs FTS5 support.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!ready()) {
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS record_fts USING fts5(record_id UNINDEXED, title, body, tags, tokenize='unicode61');
        CREATE TABLE IF NOT EXISTS record_identifiers (record_id TEXT NOT NULL, identifier TEXT NOT NULL, PRIMARY KEY(record_id, identifier));
        DELETE FROM record_fts;
        DELETE FROM record_identifiers;
        INSERT INTO record_fts SELECT record_id, title, body, tags FROM search_index;`);
      const insert = db.prepare('INSERT OR IGNORE INTO record_identifiers VALUES (?, ?)');
      const rows = db.prepare('SELECT record_id, title, body, tags FROM search_index').all() as Array<{ record_id: string; title: string; body: string; tags: string }>;
      for (const row of rows) {
        for (const word of identifierTerms(`${row.title} ${row.body} ${row.tags}`)) insert.run(row.record_id, word.toLowerCase());
      }
      db.prepare("INSERT OR REPLACE INTO index_metadata VALUES ('fts_projection_version', '1')").run();
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function searchFtsRecords(query: string, options: {
  modules?: string[];
  includeArchive?: boolean;
  excludeDrafts?: boolean;
  includeHistory?: boolean;
  limit?: number;
} = {}): { records: ContextRecord[]; identifierIds: string[]; available: boolean } {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1) throw new Error('FTS5 limit must be a positive integer');
  const terms = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
  if (!terms.length) return { records: [], identifierIds: [], available: true };
  const modules = moduleSearchNames(options.modules ?? []);
  const scope = `(? = 1 OR records.archived = 0) ${recordModuleFilter(modules)}
    ${options.excludeDrafts ? "AND instr(records.path, '/drafts/') = 0" : ''}
    ${options.includeHistory === false ? `AND records.status NOT IN ('superseded', 'cancelled', 'canceled', 'retired', 'archived')
      AND records.type NOT IN (${[...retiredRecordTypes, 'verification-evidence', 'agent-run', 'acceptance-review'].map((type) => `'${type}'`).join(', ')})
      AND NOT (records.type = 'research' AND records.status = 'closed')
      AND NOT (records.type IN ('task', 'backlog') AND records.status = 'done')` : ''}`;
  const bindings = [options.includeArchive ? 1 : 0, ...modules];
  try {
    return readFromIndex((db) => {
      ensureFtsProjection(db);
      db.exec('BEGIN');
      // Pin projection and plain records to one snapshot across all result reads.
      const ready = db.prepare("SELECT value FROM index_metadata WHERE key = 'fts_projection_version'").get() as { value: string } | undefined;
      if (ready?.value !== '1') throw new Error('FTS5 projection invalidated before reading');
      const rows = db.prepare(`SELECT search_index.body, search_index.metadata FROM record_fts
        JOIN records ON records.id = record_fts.record_id JOIN search_index ON search_index.record_id = records.id
        WHERE record_fts MATCH ? AND ${scope}
        ORDER BY bm25(record_fts, 0, 10, 2, 6), records.path LIMIT ?`)
        .all(terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR '), ...bindings, Math.min(5, limit)) as Array<{ body: string; metadata: string }>;
      const records = rows.map((row) => ({ ...JSON.parse(row.metadata) as Omit<ContextRecord, 'body'>, body: row.body }));
      const seen = new Set(records.map((record) => record.id));
      const identifierIds: string[] = [];
      const markedTerms = identifierTerms(query);
      if (markedTerms.length && records.length < limit) {
        // shortcut: literal substring lookup scans the vocabulary; upgrade after real workload measurements justify another index.
        const candidates = db.prepare(`SELECT records.id, records.path, search_index.title, search_index.body, search_index.tags
          FROM records JOIN search_index ON search_index.record_id = records.id
          WHERE ${scope} AND records.id IN (SELECT record_id FROM record_identifiers WHERE identifier != ? AND instr(identifier, ?) > 0)`);
        const selected: string[] = [];
        for (const term of markedTerms) {
          const lower = term.toLowerCase();
          const matches = candidates.all(...bindings, lower, lower) as Array<{ id: string; path: string; title: string; body: string; tags: string }>;
          matches.sort((a, b) => recordSearchScore(b, [lower]) - recordSearchScore(a, [lower]) || a.path.localeCompare(b.path));
          for (const row of matches) {
            if (seen.has(row.id)) continue;
            seen.add(row.id);
            selected.push(row.id);
            if (selected.length >= Math.min(5, limit - records.length)) break;
          }
          if (selected.length >= Math.min(5, limit - records.length)) break;
        }
        const read = db.prepare('SELECT body, metadata FROM search_index WHERE record_id = ?');
        for (const id of selected) {
          const row = read.get(id) as { body: string; metadata: string };
          records.push({ ...JSON.parse(row.metadata) as Omit<ContextRecord, 'body'>, body: row.body });
          identifierIds.push(id);
        }
      }
      db.exec('COMMIT');
      return { records, identifierIds, available: true };
    });
  } catch {
    return { records: [], identifierIds: [], available: false };
  }
}

export function readSearchRecords(options: {
  includeArchive?: boolean;
  modules?: string[];
  recordId?: string;
  useIndex?: boolean;
} = {}): { records: ContextRecord[]; source: 'index' | 'markdown' } {
  const { includeArchive = false, recordId, useIndex = true } = options;
  const modules = moduleSearchNames(options.modules ?? []);
  if (useIndex) {
    try {
      const rows = indexedRecordRows<{ body: string; metadata: string }>(
        'search_index.body, search_index.metadata', includeArchive, modules, recordId,
      );
      return {
        records: rows.map((row) => ({ ...JSON.parse(row.metadata) as Omit<ContextRecord, 'body'>, body: row.body })),
        source: 'index',
      };
    } catch {
      // The files remain authoritative when index storage cannot be used.
    }
  }
  const { indexableRecords } = selectIndexableRecords(readRecords(includeArchive));
  return {
    records: indexableRecords.filter((record) =>
      (recordId === undefined || record.id === recordId)
      && (modules.length === 0 || record.modules.length === 0 || record.modules.some((module) => modules.includes(module)))),
    source: 'markdown',
  };
}

export function searchIndex(query: string, limit = 10, includeArchive = false, modules: string[] = [], searchEngine: SearchEngine = 'current'): ContextRecord[] {
  if (parseSearchEngine(searchEngine) === 'fts5') {
    const result = searchFtsRecords(query, { limit, includeArchive, modules });
    if (result.available) return result.records;
  }
  const terms = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((term) => term.replace(/["']/g, ''))
    .filter((term) => term.length > 1);
  if (terms.length === 0) return [];
  let rows: Array<{ path: string; title: string; body: string; tags: string; record?: ContextRecord }>;
  try {
    // Plain search needs only text for scoring; parse full metadata for pack
    // ranking only, and Markdown only for the selected search results.
    rows = indexedRecordRows('records.path, search_index.title, search_index.body, search_index.tags', includeArchive, moduleSearchNames(modules));
  } catch {
    rows = readSearchRecords({ includeArchive, modules, useIndex: false }).records
      .map((record) => ({ ...record, tags: record.tags.join(' '), record }));
  }
  return rows
    .map((row) => ({ ...row, score: recordSearchScore(row, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, limit)
    .flatMap((row) => {
      if (row.record) return [row.record];
      try {
        const reference = classifyFileReference(row.path);
        return reference.kind === 'file' ? [parseRecord(reference.absolutePath)] : [];
      } catch {
        return [];
      }
    });
}

function recordSearchScore(
  record: { title: string; body: string; tags: string },
  terms: string[],
): number {
  const title = record.title.toLowerCase();
  const body = record.body.toLowerCase();
  const tags = record.tags.toLowerCase();
  let score = 0;
  let matches = 0;
  for (const term of terms) {
    let matched = false;
    if (title.includes(term)) {
      score += 10;
      matched = true;
    }
    if (tags.includes(term)) {
      score += 6;
      matched = true;
    }
    if (body.includes(term)) {
      score += 2;
      matched = true;
    }
    if (matched) matches += 1;
  }
  return score + matches * matches;
}

export type CapabilitySearchResult = {
  name: string;
  kind: string;
  path: string;
  signature?: string;
  module: string;
  exported: boolean;
  score: number;
};

export function searchCapabilities(query: string, modules: string[], limit = 12): CapabilitySearchResult[] {
  modules = [...new Set(modules.flatMap((name) => resolveModuleName(name) ?? []))];
  if (modules.length === 0) return [];
  const words = capabilityQueryWords(query);
  if (words.length === 0) return [];
  return readFromIndex((db) => {
    const rows = db.prepare(`
SELECT name, kind, file_path AS path, signature, module, exported
FROM symbols
WHERE kind != 'file' AND module IN (${modules.map(() => '?').join(',')})
  AND (${words.map(() => "lower(name || ' ' || kind || ' ' || file_path || ' ' || coalesce(signature, '')) LIKE ?").join(' OR ')})
LIMIT 500
`).all(...modules, ...words.map((word) => `%${word}%`)) as Array<{
      name: string;
      kind: string;
      path: string;
      signature?: string;
      module: string;
      exported: number;
    }>;
    return rows
      .map((row) => ({ ...row, exported: row.exported === 1, score: capabilityScore(row, words, query, modules[0]) }))
      .filter((row) => row.score > 0)
      .sort((left, right) => right.score - left.score
        || Number(right.exported) - Number(left.exported)
        || left.path.localeCompare(right.path)
        || left.name.localeCompare(right.name))
      .slice(0, limit);
  });
}

function fingerprintRecords(records: ContextRecord[]): string {
  const hash = createHash('sha256');
  for (const record of [...records].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(JSON.stringify({
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
      body: record.body,
      frontmatter: record.frontmatter,
    })).update('\0');
  }
  return hash.digest('hex');
}

function fingerprintFileState(files: string[]): string {
  const hash = createHash('sha256');
  for (const path of [...files].sort()) {
    try {
      const stat = statSync(path);
      hash.update(path).update('\0').update(`${stat.size}:${stat.mtimeMs}`).update('\0');
    } catch {
      hash.update(path).update('\0missing\0');
    }
  }
  return hash.digest('hex');
}

const genericCapabilityWords = new Set([
  'backend', 'frontend', 'context', 'контекст', 'исправить', 'добавить', 'сделать', 'классы', 'class', 'code', 'implementation',
]);

function capabilityQueryWords(query: string): string[] {
  const base = query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length >= 3);
  const expanded = new Set<string>();
  for (const word of base) {
    if (!genericCapabilityWords.has(word)) expanded.add(word);
    for (const alias of capabilityAliases(word)) expanded.add(alias);
  }
  return [...expanded].slice(0, 20);
}

function capabilityAliases(word: string): string[] {
  if (word === 'excel') return ['xlsx', 'workbook', 'sheet'];
  if (/^выгруз/.test(word)) return ['export'];
  if (/^бюджет/.test(word)) return ['budget', 'budgeting'];
  if (/^помесяч/.test(word)) return ['monthly', 'month'];
  if (/^ячей/.test(word)) return ['cell'];
  if (/^стил/.test(word)) return ['style', 'format', 'formatting'];
  if (/^ресурс/.test(word)) return ['resource'];
  if (/^доступ/.test(word)) return ['access', 'visibility', 'security'];
  if (/^резерв/.test(word)) return ['reserve'];
  if (/^отмен/.test(word)) return ['cancel'];
  return [];
}

function capabilityScore(
  row: { name: string; kind: string; path: string; signature?: string; module: string },
  words: string[],
  query: string,
  primaryModule?: string,
): number {
  const name = row.name.toLowerCase();
  const path = row.path.toLowerCase();
  const signature = (row.signature ?? '').toLowerCase();
  let score = 0;
  let matches = 0;
  for (const word of words) {
    let matched = false;
    if (name === word) {
      score += 30;
      matched = true;
    } else if (name.startsWith(word) || name.includes(word)) {
      score += 14;
      matched = true;
    }
    if (path.includes(word)) {
      score += 8;
      matched = true;
    }
    if (signature.includes(word)) {
      score += 3;
      matched = true;
    }
    if (matched) matches += 1;
  }
  score += matches * matches * 2;
  if (primaryModule && row.module === primaryModule) score += 20;
  if (!/test|тест/i.test(query) && /(?:^|\/)test|\.test\./.test(path)) score -= 8;
  return score;
}
