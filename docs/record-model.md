# Current source: smaller memory model

This change is available from Git `main`; existing release tags remain unchanged.
It changes the CLI/MCP API for unused record types and finalization.

## Supported records

`task`, `bug`, `decision`, `backlog`, `research`, `verification-evidence`,
`agent-run`, `acceptance-review`, `project`, `requirement`, `open_question`,
`source`, `source_chunk`.

The retired types are `integration`, `api`, `data_entity`, `meeting_draft`,
`acceptance_check`, `module`, `pattern`, `runbook`, `refactor`, and `run-summary`.
The router no longer offers them for new proposals, promotions or restores.
Initialization no longer creates their directories. Refactor review only returns
candidates. RP import keeps acceptance references inside requirements and no longer
creates standalone acceptance-check placeholders.

Task criteria and independent `acceptance-review` records still validate work.
Modules, source globs and playbooks in `project.yaml` still route project context.
Portal/Confluence connection configuration is separate from retired integration records.

## Existing files

Updating does not delete or rewrite consumer Markdown files. Generic searches
can still read old types, for example:

```bash
npx project-context search-project-context --types integration --include-drafts
npx project-context search-project-context --types run-summary --include-archive
```

Default context packs hide retired types. Explicit `--include-history` can retrieve
them; add `--include-archive` for archived storage. Both `current` and `fts5` obey
this rule. Old pack caches invalidate automatically.

Archive obsolete records by explicit IDs after reviewing them. Move useful content
into a supported decision, requirement, task, or existing project documentation.
A batch promotion containing retired records fails before writing any files.

## Removed tools

CLI `find-integrations` and `find-data-entities`, and MCP `find_integrations` and
`find_data_entities`, are removed. New `propose_context_update` types are limited
to `project`, `decision`, `requirement`, `open_question`, `source`, `source_chunk`.
`trace_requirement` no longer returns a separate `acceptanceChecks` collection.
Restart/reconnect the MCP client to refresh its tool list.

## Exact task links

Requirement `task_keys` link to an exact record ID or explicit task metadata:

```yaml
# On a task or backlog record whose internal id differs from the imported task code:
task_key: TASK-022
# Or multiple explicit keys:
task_keys: [TASK-022, DEV-123]
```

A title/body mention, or `TASK-0220`, does not establish a link to `TASK-022`.
Portal work items also retain optional/null `sourceDocumentId`, `sourceRevisionId`
and `sourceTaskCode`. Older server responses without these fields remain accepted.

## Finalization API

`finalize_work` / `finalize-work` update the existing confirmed task:

- `last_result`: source_commit, summary, result, changed_files, tests, skipped_checks, decisions;
- `finalized_at` and `updated_at`;
- explicit completion/status and optional execution_run.

The result is `FINALIZED` with `taskPath`, `completion`, `taskStatus`, and
`requiresHumanReview: false`. Consumers must stop expecting `CREATED`/`UPDATED`
and `draftPath`. Repeated finalization replaces `last_result`; evidence history
remains in verification records. The optional Stop hook checks the task timestamp.

No owner returns `SKIPPED`. Explicit `complete` still requires a fresh accepted
execution run. Without explicit completion the existing task status is preserved;
`partial` and `blocked` update it. These fields are declared workflow results;
they are not proof of live deployment.
