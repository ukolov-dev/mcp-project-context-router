# 0.8: experimental opt-in FTS5 search

The default remains `current`. Select `fts5` for an individual CLI/API/MCP
request; it includes the partial-identifier reserve and no relation expansion.
There is no new global configuration setting.

```sh
project-context search "quick_valid" --search-engine fts5
project-context pack "quick_valid" --search-engine fts5 --modules app --max-tokens 4000
```

MCP `build_context_pack` and `build_project_context_pack` accept
`searchEngine: "fts5"`. `retrieve_project_context` uses it for local retrieval
only. Omitting the selector or selecting `current` keeps current behavior.

Existing consumer Markdown/YAML stays authoritative. The plain index schema
remains 5; disposable FTS/identifier tables are built on first use and refreshed
after an index rebuild. Pack-cache version 6 invalidates older cached packs.
Missing/corrupt index recovery and healthy-index preservation from 0.7.1 remain.
An unavailable FTS projection falls back to current pack retrieval with a warning
and disabled degraded caching. Official Node.js 22.13.0 lacks SQLite FTS5;
its default mode remains supported. FTS5 is verified with Node.js 22.23.2;
custom runtimes must include `SQLITE_ENABLE_FTS5`. No consumer source migration is required.

## Experimental limits

- OR matching can return unrelated records; absence of relevant evidence is not
  reliably detected. Ranking and delivered evidence can regress for some queries.
- Finding a record does not guarantee its decisive passage survives excerpt
  selection and budget trimming.
- Consumer mandatory guidance can exceed small budgets even after removing every
  result. The pack reports this in its budget/warnings; FTS does not fix it.
- First use builds full projections; identifier substrings scan the indexed
  vocabulary. No incremental projection maintenance or graph support is enabled.

See [SQLite behavior](sqlite-index.md#optional-fts5-search-mode) and the
[fixed-query evaluation](search-evaluation.md#independent-real-consumer-replay-2026-10-13)
for measured gains, losses and evaluation boundaries. Private snapshots and raw
consumer records are excluded from source changes and package artifacts.

## Candidate verification

From a source checkout:

```sh
npm ci
npm run build
npm test
npm run package:check
npm run package:consumer
node bin/project-context doctor --json
```

The consumer check packs built runtime files, creates a fresh temporary project
and empty npm cache, installs the tarball and its own dependencies, then checks
version, CLI initialization/search/pack and the installed stdio MCP pack tool.
It asserts current-default equivalence and, on an FTS5-capable runtime, lazy creation, preserved direct hits,
reserve provenance/evidence and a bounded pack with a deliberately small policy.
It does not substitute a minimal policy for the real-consumer quality findings.
Reports, the tarball and digests are written to ignored `artifacts/consumer-install`.
CI checks out the exact PR head commit and runs this check on Node 22.13.0/Linux (current and visible fallback)
and Node 22.23.2/Linux (FTS5 and reserve)
alongside the existing required checks. It saves the verified tarball, source
commit/dirtiness, package digest and installed dependency tree as an artifact.
No live service deployment or model-answer quality is implied by a passing install
check. Windows and concurrent throughput require separate validation.
