# Changelog

Notable changes to Project Context Router are recorded here. Versions before
1.0 are under active development. The package requires Node.js 22.13 or newer.

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
