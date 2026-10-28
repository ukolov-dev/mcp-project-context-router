# Changelog

Notable changes to Project Context Router are recorded here. Versions before
1.0 are under active development. The package requires Node.js 22.13 or newer.

## [0.11.0] - 2026-10-28

- Make Tree docs the primary navigation model: project map → document → section → implementation and checks.
- Add `docs tree`, `docs outline` and `docs read`, plus `get_document_tree`, `get_document_outline` and `read_document_section` in every MCP profile.
- Return bounded, paginated results, unique section IDs and source line ranges; preserve subsection boundaries and Unicode continuation.
- Enforce repository-relative paths and document-size limits, exclude symlinks and private/generated/ignored paths, and redact detected secrets before section selection while retaining source lines.
- Add a shared CLI/MCP implementation, conditional playbook, source map, documentation and installed-package regressions. Preserve existing 0.10.1 routing, hooks, client setup and website behavior.

## [0.10.1] - 2026-10-16

- Route context packs and task validation by exact task/backlog keys before module fallback; preserve explicit scope and recognize short aliases in hyphenated words.
- Prioritize exact keys and scoped files, then use task activity and update dates to break relevance ties. Show directly requested completed work with historical provenance while retaining normal history exclusions.
- Invalidate previous context-pack caches after the routing and ranking changes. Ignore malformed optional task keys instead of failing context retrieval.

## [0.10.0] - 2026-10-16

- Add explicit `init --client codex|zcode|deepseek-harness` MCP setup, keeping plain init unchanged. Install ZCode skills into `.zcode/skills`; DSH reuses `.agents/skills`. Preserve custom files and reject escaping destinations.
- Add optional DSH lifecycle hook delivery through its official Codex bridge and a manual ZCode user-hook template/Stop adapter; reject unsupported project-level ZCode hook installation explicitly.
- Add English/Russian client guides, website instructions, template handshake tests and clean installed-package checks. Live client/plugin-loader sessions and native Windows execution remain unverified.

## [0.9.0] - 2026-10-15

- Add optional `init --with-hooks` for repository-local Codex prompt/tool/Stop hooks, preserving custom configuration and supporting package installations and standalone exports.
- Track source-content fingerprints, including staged, untracked and deleted files, without invalidating verification on reads or generated memory updates. Guard hook state paths and expire inactive sessions after seven days.
- Preserve millisecond timestamps in verification evidence and finalization so real CLI results satisfy source-freshness checks.
- Require fresh task-scoped verification and finalization at Stop; keep blocking repeated incomplete attempts and permit honest partial/blocked results with per-check reasons. Hooks do not run checks or grant independent acceptance.
- Document lifecycle setup, client trust and verification boundaries in the README, Codex guide and English/Russian website. Verify installation and execution from a clean package consumer.


- Update runtime and development dependencies to latest stable npm releases verified on 2026-10-14, including MCP SDK 1.32.1, Commander 15.0.0, js-yaml 5.4.3, Zod 4.6.7, TypeScript 7.0.2, Vite 8.3.4 and Vitest 5.0.4; refresh compatible transitive dependencies and keep exact direct pins.
- Remove unused `simple-git` and redundant `@types/js-yaml` (js-yaml now bundles types). Preserve Node.js 22.13+ support.
- Preserve YAML merge keys, timestamps, YAML 1.2 scalar rules and empty configuration defaults after the js-yaml upgrade; continue rejecting multiple documents. Share the loader with configuration, playbooks, lint and hooks, with regression and installed-package checks.
- Latest `fast-glob` and `gray-matter` still bring unresolved transitive npm advisories; dependency updates do not claim a clean security audit.

- Publish a bilingual English/Russian project website and documentation on GitHub Pages, with topic-preserving language links, copyable commands and responsive navigation. Check generated links and translations in CI.

- Bundle a portable `project-context-workflow` skill for confirmed tasks, scoped context, verification and task finalization.
- Add opt-in `init --with-skills` to copy workflow and research skills into repository `.agents/skills`, preserving existing files and reporting skipped paths. Reject escaping destinations and use exclusive creation to preserve dangling symlinks/concurrent files.
- Verify skill delivery through package contents and the installed tarball CLI; document installation and manual update of project-owned copies.

- Preserve optional portal work-item source document, revision and task-code fields, including older responses with missing fields.
- Trace requirement tasks only through exact record IDs or explicit `task_key`/`task_keys`; prefixes and prose mentions no longer create links.
- Retire ten unused memory types and remove their proposal/promotion/restore support, specialized integration/data-entity CLI and MCP searches, scaffold directories, refactor draft writer and standalone acceptance-check import.
- Save finalization results on the confirmed task as `last_result` instead of generating run-summary drafts. Retain independent acceptance gates and adapt the optional Stop hook.
- Keep old records readable/archivable; exclude retired types from default packs in both search engines and invalidate previous pack caches. See [migration](docs/record-model.md).

## [0.8.0] - 2026-10-13

- Validate Node 22.13.0 current/fallback compatibility and Node 22.23.2 FTS5 support separately; older official runtimes lack the compiled FTS5 module.
- Add experimental per-request `fts5` search with a partial-identifier reserve in CLI search, local context packs and MCP pack tools. `current` remains the default; related-record expansion is not enabled.
- Preserve the five direct BM25 results before appending up to five new identifier matches. Filter module/alias/archive and pack history/draft eligibility before result caps and candidate Markdown reads.
- Build disposable FTS5/identifier projections lazily and transactionally; invalidate them on plain-index rebuild and read direct/reserve results from one SQLite snapshot. Preserve 0.7.1 recovery, fallback and source-record behavior.
- Isolate search-mode caches (cache version 6). An unavailable FTS5 projection falls back to current pack retrieval with a warning and no degraded cache entry.
- Document fixed-query evaluations, independent consumer replay and limitations: lexical false positives, lost evidence passages, guidance-only budget overflow, first-use projection cost and ranking regressions remain. This release does not promote FTS5 to the stable/default engine.
- Add lifecycle/filter/cache/CLI/MCP/concurrency regressions and a clean tarball consumer installation smoke in CI. See [0.8 release notes](docs/release-0.8.md) for usage and validation boundaries.

## [0.7.1] - 2026-10-09

- Recover missing or corrupt disposable SQLite indexes before reading them, including corruption discovered in data pages. Preserve healthy indexes on busy, readonly and other I/O errors, and close failed rebuild connections.
- Apply the same module/alias filters, global-record inclusion, archive selection and duplicate precedence to indexed and fallback record search.
- Assemble uncached context packs from Markdown when index storage is unavailable, with a visible warning.
- Store record metadata in index schema version 5 so context packs can rank all candidates and read only selected Markdown excerpts. Preserve confirmation, history and explicit-task behavior; migrate older indexes and invalidate older pack caches automatically.
- Check freshness for each context-pack request to preserve immediate visibility of source changes. This adds file-stat overhead to cache hits; new-pack construction improves on larger fixtures. Full rebuilds remain in use.
- Prevent Markdown updates from mutating parser-cache metadata shared by identical content or later restores.
- Add 15 portable regression tests and document recovery, performance tradeoffs and the evaluation of incremental updates.

## [0.7.0] - 2026-10-02

- Replace undeclared `doc` fallbacks with configured modules; explain query/path routing, unknown modules and uncovered files. Resolve unique configured aliases in record and capability retrieval.
- Hide superseded, cancelled and retired knowledge from ordinary packs; expose lifecycle/provenance metadata and prioritize relevant decisions and explicit confirmation. Preserve history opt-in and required playbooks.
- Diagnose omitted source/config files without broadening configured globs; scaffold mjs/mts/cts coverage. Report untracked durable records and client configuration verification limits.
- Separate active, historical and draft diagnostics. Missing active links warn normally and fail commit validation; lint warnings now produce WARN. Flag stale tasks, incomplete legacy evidence and contradictory promotion markers.
- Add required/optional checks, explicit partial/blocked completion, evidence boundaries and retry links. Core evidence/finalization integrate existing execution snapshots and independent acceptance gates; no automatic closure from a passed check.
- Scope heuristic refactor review to explicit files, task contract or base commit, with visible fallback and no implicit refactor drafts.
- Add portable synthetic regressions and a safe migration guide; preserve consumer records and intentional exclusions.


## [0.6.0] - 2026-09-28

### Added

- Separate research records with discussion history, status transitions, open
  questions, conclusions, optimistic revision checks and retry-safe backlog handoff.
- Six research MCP tools, equivalent CLI commands, a research resource, and a
  `planning` profile combining core, research and backlog workflows.
- A portable Codex research skill and a Russian research workflow guide.

## [0.5.1] - 2026-09-24

### Fixed

- Normalize repository-relative record paths to forward slashes on Windows.
  Backlog filtering now returns all active records instead of an empty list
  when native paths contain backslashes. Archive classification uses the same
  portable paths.
- Add Windows path regression coverage for eight active backlog records, mixed
  input separators, and draft/archive exclusion.

### Added

- `project-context hooks install` installs a managed, idempotent pre-commit hook
  and configures the local clone to run `doctor --commit` before commits.
- Commit validation now rejects unknown module mappings, missing module paths,
  and context records that reference missing or invalid repository files.

## [0.5.0] - 2026-09-15

This release adds task execution tracking, evidence-gated acceptance, and an
optional external CLI runner to the existing local project-context workflow.
It is the first tagged GitHub release; the previous source baseline was 0.4.0.

### Added

- Execution manifests linked to confirmed Task Contracts, with base commit,
  branch/worktree identity, executor, attempt number, timestamps, revisions,
  results and transition history.
- An explicit execution lifecycle: `confirmed` → `implementing` → `verifying`
  → `reviewing` → `ready_to_merge`, with a terminal `failed` outcome and new
  attempts for retries.
- Run-bound verification evidence. Progress to review requires every required
  check to pass for the exact task and code snapshot.
- Independent acceptance-review bundles containing the contract, criteria,
  diff, verification results and provenance. Passing reviews must cover every
  criterion, cite evidence, have no findings, and identify a different reviewer.
- Nine execution MCP tools in the `developer`, `admin`, and `full` profiles:
  manifest creation/read/list, snapshot capture, state transitions, verification
  recording, and acceptance bundle/record/read operations.
- The optional `project-context run TASK-ID --adapter adapter.json` CLI workflow.
  It previews the plan by default; `--execute` runs external implementation,
  verification and review processes with time and output limits.
- An execution guide, adapter configuration template, Russian OpenCode setup
  guide, and Russian task workflow/artifact guide.
- 56 execution regression and CLI/MCP integration tests.

### Reliability and safety

- Task, code and verification-plan changes invalidate evidence for later gates;
  evidence content is frozen when review begins.
- A newer review supersedes an earlier verdict. An earlier PASS cannot override
  a later FAIL for the same snapshot.
- Required verification commands retain their declared order, including
  prerequisite checks.
- Automatic review rejects diffs exceeding the complete 200,000-character
  review limit before launching the reviewer.
- Process failures, interruption, timeouts, malformed reviewer output and code
  changes during verification/review prevent a successful execution result.
- Execution records use atomic writes, short storage locks and path/symlink
  boundary checks. Git snapshotting disables external diff, text conversion,
  file-system monitor and configured clean/process/smudge filter programs.
- Generated execution history stays out of ordinary context packs by default;
  transient storage files are ignored by Git.

### Compatibility and limitations

- The default `core` MCP profile and existing Task Contract/verification APIs
  remain available. The new execution tools require `developer`, `admin`, or
  `full`.
- External execution is CLI-only. MCP does not launch implementation agents,
  verification commands or reviewer processes.
- The runner uses the current checkout or an existing worktree. It does not
  create worktrees, merge branches or deploy changes.
- The project supplies implementation/reviewer executables through the adapter.
  Reviewer identity is declared, and read-only permissions must be enforced by
  the external agent client; the runner is not an operating-system sandbox.
- Execution rejects Git submodules and source files marked `assume-unchanged`
  or `skip-worktree`, which could hide modifications from the reviewed diff.
  Attempt lookup and numbering use active execution records.
- Distribution is through GitHub and the attached npm-compatible tarball. This
  release does not publish the package to the npm registry or change its license.

## 0.4.0 - Previous untagged source baseline

- Local-first project memory in reviewable Markdown/YAML with a disposable
  SQLite search index and bounded context packs.
- CLI and MCP workflows for confirmed Task Contracts, capability reuse scans,
  backlog dependencies, verification evidence, refactor review and finalization.
- Scoped MCP profiles, optional Context Hub and Confluence integrations, and
  Codex/OpenCode installation templates.
- Standalone packaging, repository-boundary checks, secret redaction and
  GitHub Actions verification.

[0.5.0]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.5.0

[0.5.1]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.5.1

[0.6.0]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.6.0

[0.7.0]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.7.0

[0.7.1]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.7.1

[0.11.0]: https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.11.0
