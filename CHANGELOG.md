# Changelog

Notable changes to Project Context Router are recorded here. Versions before
1.0 are under active development. The package requires Node.js 22.13 or newer.

## Unreleased

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
