# SQLite index behavior

The local SQLite database is a disposable index of Markdown/YAML records and
discovered source capabilities. Original files remain authoritative. No separate
database service is required.

## Recovery and fallback

- A missing index is rebuilt before indexed search returns results, including
  when it disappears within the normal search freshness interval.
- SQLite corruption errors (`SQLITE_CORRUPT`, `SQLITE_NOTADB`, including extended
  codes) trigger a bounded recovery attempt. The database and its WAL/SHM files
  are removed only after the connection is closed, then rebuilt from files.
- Busy, readonly, permission and other I/O errors do not authorize deletion of
  the existing index. A failed rebuild also closes its connection, including a
  failure to begin the write transaction.
- When index storage remains unavailable, record search reads Markdown with the
  same module names/aliases, global-record inclusion, archive selection and
  duplicate-ID precedence as indexed search.
- Context packs can be assembled from Markdown during an index failure. They
  include a warning and report `cache.status: disabled`; degraded results are
  not written to the normal pack cache. Explicit file context and configured
  module paths remain available, but indexed symbol matches are omitted.
- Invalid source records or unreadable source files can still prevent recovery:
  this fallback addresses an unavailable derived index, not broken source data.

## Record selection and cache migration

Index schema version 5 adds a JSON metadata column to `search_index`. It stores
record fields and frontmatter; the body remains in its existing text column.
The previous schema is upgraded and rebuilt automatically. Pack-cache version 6
invalidates older entries and isolates the requested search engine.

A new context pack uses this metadata for module selection, candidate matching,
confirmation/type ranking and history filtering. It reads Markdown only for the
selected excerpts and explicit sources after checking index freshness. Explicit
task lookup also uses indexed metadata. This removes the unconditional second
read/parse of every Markdown record. Candidate selection remains complete before
ranking; it is not limited to the first page of ordinary search results.

Ordinary record search still scores lightweight text rows and reads Markdown for
its selected results. It does not deserialize all record metadata.

Context packs explicitly check freshness on every request, so additions, edits
and deletions are visible even within ordinary search's one-second freshness
interval. This adds file-stat work to cache hits. Regular search retains its
existing freshness interval. The metadata check uses file size and modification
time; it is not a filesystem snapshot or a guarantee of atomic reads across
concurrent source edits.

## Measured effects and incremental indexing decision

A local comparison used the previous and updated implementations against the
same synthetic fixture: 5,000 records with roughly 1.2 KB bodies, 500 TypeScript
files, and 5,000 extracted symbols. Node.js 22.23.2, a single process per version,
warm filesystem cache, no model/network/startup latency. Medians are illustrative
rather than performance guarantees.

| Operation | Previous, ms | Updated, ms |
| --- | ---: | ---: |
| New context pack, 9 samples | 279 | 140 |
| Cached context pack, 15 samples | 21 | 43 |
| Standalone record search, 15 samples | 11 | 12 |
| Full index rebuild, 5 samples | 181 | 241 |

Before each search/pack timing, the index was made fresh outside the timer. The
updated pack's own mandatory freshness check is included, reflecting its new
behavior. Pack-cache entries were removed before each new-pack sample. Selected
record IDs, file paths and ordinary search result IDs matched for the fixture
and a small project copy. This is a correctness check for the sampled queries,
not a general relevance evaluation. Database size increased from about 9.4 MB
to 12.9 MB due to stored metadata.

Full rebuilds remain in this change. Updating only changed files would reduce
write/parse work after a small edit, but requires persistent per-file state and
careful handling of deletions, moves, duplicate IDs, changed module configuration,
record file checksums, symbol/endpoint replacement and atomic publication. The
file-stat scan and pack dependency checks would still have a cost.

The next useful experiment is a record-only update path with differential tests
against a full rebuild. Before adopting it, measure real editing sessions and
compare end-to-end latency, write volume and equality of results after edits,
deletions, moves and configuration changes. The present measurements justify
investigating incremental refresh, but do not establish an acceptable complexity
tradeoff or an expected production speedup. A full rebuild should remain the
repair and schema-migration path.

Regression coverage lives in `test/index-freshness.test.ts` and
`test/context-pack-index.test.ts`. Tests use temporary repositories, exercise
real missing/corrupt/unavailable index files, inject SQLite busy/readonly and
data-page corruption errors, verify schema migration, and count record reads on
a warm cache miss with and without an explicit task.

## Optional FTS5 search mode

FTS5 needs a Node runtime compiled with SQLite `SQLITE_ENABLE_FTS5`. Official
Node.js 22.13.0 does not include it; the default mode remains supported and packs
report an uncached fallback. FTS5 is verified on Node.js 22.23.2. See the
[Node compile flags](https://github.com/nodejs/node/blob/v22.23.2/deps/sqlite/sqlite.gyp).

**Experimental in 0.8.0.** `current` remains the default for standalone search
and every local context-pack entry point. Select `fts5` for one request:

```sh
node bin/project-context search "quick_valid" --search-engine fts5 --limit 10
node bin/project-context pack "quick_valid" --search-engine fts5 --modules router --max-tokens 4000
```

CLI `build-project-context-pack` and MCP `build_context_pack`,
`build_project_context_pack`, and the local part of `retrieve_project_context`
also accept the mode (`searchEngine: "current" | "fts5"` for API/MCP requests).
The Portal retrieval mode is independent. Invalid engine names are rejected.

FTS5 uses `unicode61`, quoted OR terms and BM25 title/body/tag weights 10/2/6.
It returns at most five direct results, then at most five new proper partial
identifier matches, with a total bounded by the request's result limit. The
reserve recognizes camel/Pascal case and internal underscores, searches indexed
title/body/tags for a longer identifier containing the literal fragment, and
retains the direct FTS5 prefix. Lowercase-only fragments and metadata-only
matches do not activate this reserve. No related-record expansion is performed.

The disposable `record_fts` and `record_identifiers` projections are populated
lazily in a transaction from the authoritative plain index. Rebuilding that
index clears their readiness marker in the same transaction; the next FTS5
request repopulates them. An existing schema-5 index needs no record migration
to use this mode. Default search never creates or requires the FTS5 tables.
Availability depends on the SQLite build's [FTS5 support](https://www.sqlite.org/fts5.html#compiling_and_using_fts5).
Full projection builds add first-request latency; incremental updates are
deferred. Identifier lookup still scans its vocabulary for literal substrings.

Module aliases, global records and archive eligibility are filtered in SQL before
either result cap. Packs also filter drafts and hidden history there before
selection. Explicit task/specification records retain their existing priority;
other FTS records retain BM25 order, followed by identifier reserve order, rather
than the current engine's confirmation/type reranking and module-only candidates.
Existing authority metadata describes claims; it is not proof of correctness.

The real pack builder applies the same excerpts, secret redaction, files,
playbooks, provenance and budget trimming as the current mode. Standard packs can
contain five direct plus five reserve records; fast packs have a five-record cap
that can leave no room for reserve when all direct slots are occupied. Small
budgets may retain a record reference without its excerpt or remove it entirely.
The selected engine participates in the cache key. When FTS5 or index storage
is unavailable, packs use current retrieval with a warning and disable caching;
standalone search falls back to current retrieval. Healthy source records and
the plain index are preserved on setup/busy/readonly failures.

Direct matches, identifier candidates and selected indexed metadata are read in
one SQLite read transaction. A rebuild on another connection cannot mix their
database versions. If a rebuild invalidates the projection before that snapshot
is pinned, the request falls back to current retrieval. Markdown excerpts and
explicit files still use the normal file reads; the pack is not an atomic
filesystem snapshot during concurrent source edits.

Routing remains shared: unknown explicit module names can lead to configured
fallback modules, with a warning. This is broader than the retrieval evaluator's
literal unknown-module scope. Use reviewed configured module names/aliases when
requesting a pack. See the actual-pack evaluation for this distinction and the
default hidden-history policy.
