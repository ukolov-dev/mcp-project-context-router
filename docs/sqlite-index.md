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
The previous schema is upgraded and rebuilt automatically. Old pack-cache
entries are invalidated by pack-cache version 5.

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
