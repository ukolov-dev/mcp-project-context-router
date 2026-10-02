# Upgrade to 0.7.0

Download `mcp-project-context-router-0.7.0.tgz` and `SHA256SUMS` from the GitHub release. Verify the checksum, then install in the consumer repository:

```sh
shasum -a 256 -c SHA256SUMS
npm install --save-dev ./mcp-project-context-router-0.7.0.tgz
npx project-context index
npx project-context doctor --fix-dry-run --json
npx project-context lint --json
```

On Windows use `Get-FileHash .\mcp-project-context-router-0.7.0.tgz -Algorithm SHA256` and compare with SHA256SUMS. For a vendored copy, follow its existing vendor-update procedure and review local modifications; do not overlay the archive onto unrelated application code. This release does not migrate consumer records or client settings automatically. Publication is through GitHub assets, not the npm registry.

## Routing and coverage

`routing.default_modules` must name configured modules. There is no special `doc` module. An unmatched query uses those defaults, with a warning. Unknown/ambiguous explicit names and files without a module route are reported in `pack.routing` and warnings. No route can supply verification commands that have not been configured.

Use `modules.<name>.aliases` for query words in your team's languages and reviewed legacy record names. Exact module names win; a full alias must resolve uniquely for explicit module selection and legacy record matching. No automatic punctuation-based renaming occurs. `doctor --fix-dry-run` suggests potential aliases without editing records. For example, in a project that actually has these directories:

```yaml
routing:
  default_modules: [workspace_ui]
modules:
  workspace_ui:
    path: ui
    aliases: [workspace-ui, comments, комментарии]
    source_globs: ['ui/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}']
    playbooks: [AGENTS.md]
  delivery:
    path: deploy
    aliases: [deployment, деплой]
    source_globs: ['deploy/**/*.{yaml,yml}', '.ci/**/*.{yaml,yml}']
    playbooks: [AGENTS.md]
commands:
  ui_test:
    run: npm --prefix ui test
    required_for: [workspace_ui]
    context_pack: true
  deployment_check:
    run: docker compose -f deploy/local/compose.yaml config
    required_for: [delivery]
    context_pack: true
```

These names, languages and commands are examples, not installed defaults. Include test directories where appropriate. Coverage diagnostics inspect candidate source/config files and exclude dependency, build, vendor and archive trees; they do not expand your index automatically. Existing deliberate exclusions may warrant no action.

## Retrieval and diagnostics

Ordinary packs hide superseded, cancelled/canceled, retired and archived knowledge, as well as the existing completed-task/evidence history. Use `--include-history` for historical statuses and `--include-archive` to read archive storage too. Returned records carry `status`, `category`, `authority`, `as_of`, `superseded_by`, `source_refs` and `knowledge_status`. Explicitly requested tasks remain available with metadata. Confirmation is a declared provenance attribute, not evidence of implemented AS-IS behavior. Dates break relevance ties; the newest statement does not automatically become truth.

`lint` now returns `WARN` when warnings exist, with `categories.active`, `categories.historical` and `categories.draft` for lifecycle diagnostics. Both lint and doctor exit 0 for warnings and 1 for failures. Ordinary doctor warns about missing active references; `doctor --commit` fails on those same active references. Historical/draft missing paths are reported separately and do not block commit validation. Repository escapes and invalid schemas remain errors. Use `deleted_files` for intentional deletion, preserving the historical record.

Doctor also reports untracked durable Markdown, stale open tasks, contradictory draft markers and legacy incomplete evidence. Tracking locally does not prove a record has been pushed. Client config checks establish only a declaration; after updating, restart/reconnect the MCP client and verify `tools/list` and a real call in the client session. A separate stdio smoke test cannot establish attachment to a particular chat.

## Evidence and completion

`record-verification` / `record_verification_evidence` accept:

- `checks[].required`: defaults conservatively to required. A command required by the verification plan cannot be downgraded with `false`. Missing required commands are stored as `not_run`.
- `completion`: `complete`, `partial` or `blocked`. Explicit complete verification requires all required checks passed. Optional skips can coexist with passed evidence; any failure prevents success.
- `retriesEvidenceId`: links a new attempt to earlier evidence for the same target, retaining both. Use separate records for failed and passed attempts; duplicate commands in one record are rejected.
- `boundaries`: `codeState`, `runtime`, `environment`, and optional `limitations`. Legacy callers retain explicit `unspecified` boundaries; no environment validation is claimed.
- `runId` and `expectedCodeDigest`: route core evidence through existing execution snapshot validation. Execution-backed evidence uses its frozen contract rather than inferred global defaults.

A passed verification record is not acceptance of the task. `finalize-work` / `finalize_work` still create a reviewable summary by default, now marked partial. Explicit `completion: partial` keeps a confirmed task in progress; `blocked` records a blocker. Explicit `complete` requires `runId` for a fresh `ready_to_merge` execution with independent acceptance. It then marks the owning task done. Changed code, changed contracts, wrong-task evidence and incomplete acceptance are rejected. See [execution workflow](execution.md).

Review legacy evidence before recording a replacement or closing a task. The release neither rewrites historical claims nor infers acceptance from a passed test.

## Scoped refactor review

```sh
npx project-context refactor-review --task TASK-ID --json
npx project-context refactor-review --files src/a.ts,src/b.ts --base HEAD --json
```

Explicit files take precedence, then task contract files, then base/working-tree fallback. A task with an empty file list produces an empty scope with a warning. Windows separators are normalized. Scope includes relevant staged, unstaged and untracked changes. No refactor draft is created implicitly. This is a file-count/module heuristic; inspect the actual diff for semantic refactoring opportunities.
