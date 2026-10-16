# Tools and records

Project Context Router is a local stdio MCP server and CLI. Markdown is durable memory; the SQLite index is disposable.

## Project files

| Path | Purpose |
| --- | --- |
| `.project-context/project.yaml` | Module routing, source globs, playbooks and verification commands |
| `.project-context/active/` | Durable project records |
| `.project-context/drafts/` | Local reviewable proposals |
| `.project-context/archive/` | Historical records |
| `.project-context/indexes/` | Rebuildable SQLite index and context-pack cache |
| `.agents/skills/` | Optional installed project skills |

Keep indexes, drafts, trash, credentials and private instructions out of published project memory. Review durable records before committing them.

## Ordinary task tools

| MCP tool | What it does |
| --- | --- |
| `get_project_brief` | Repository purpose and configuration |
| `validate_task`, `confirm_task_contract` | Draft and confirm task scope |
| `build_context_pack` | Local records, source files, instructions and commands for a task |
| `find_existing_capability` | Existing implementation candidates |
| `get_verification_plan` | Applicable checks and prior evidence |
| `record_verification_evidence` | Actual check results and environment boundaries |
| `review_diff_for_refactor` | File/module heuristic for the selected diff |
| `finalize_work` | Save the task's latest result |
| `context_doctor` | Local configuration and data diagnostics |

Use `npx project-context --help` and per-command help for CLI arguments. Profiles determine which tools are exposed; see [configuration](configuration.html).

## Choose the right tool

| Need | Tool | When the result is useful |
| --- | --- | --- |
| Prepare for a code change | `build_context_pack` | Scope is correct, warnings are understood, sources and instructions have been read. [Diagram and examples](context-pack.html). |
| Find a particular memory record | `search_project_context` | The record is found and its source, status and links are inspected. This is not a search of every code file. |
| Find an existing implementation | `find_existing_capability` | Candidates have been inspected in source; a matching name does not establish suitability. |
| Combine portal and local context | `retrieve_project_context` | The portal is configured and access, authority, revisions and returned-material limits have been checked. |
| Identify verification work | `get_verification_plan` | Read the plan; the agent then runs checks separately and records evidence. |

Ordinary local work does not need a portal connection. MCP returns material to the agent; its applicability and the implementation result are checked through the [agent workflow](workflow.html).

## The 13 record types

| Group | Types |
| --- | --- |
| Work and planning | `task`, `bug`, `backlog`, `research` |
| Project knowledge | `project`, `decision`, `requirement`, `open_question` |
| Sources | `source`, `source_chunk` |
| Verification and execution | `verification-evidence`, `agent-run`, `acceptance-review` |

Not every type has its own CRUD tool. Generic search can read records; `propose_context_update` offers six knowledge types: project, decision, requirement, open_question, source and source_chunk. Promotion requires review. Task acceptance criteria live in the Task Contract.

Requirement traces use exact record IDs or explicit `task_key` / `task_keys` metadata. A prose mention or prefix match is not a link. Portal work preserves optional source document, revision and task-code fields.

## Search and history

```bash
npx project-context search "CustomerService"
npx project-context pack "Update customer service" --modules app
npx project-context pack "Historical decision" --include-history --include-archive
```

Default packs hide completed workflow history and retired record types. `--include-history` permits history; `--include-archive` also reads archived storage.

The optional `--search-engine fts5` mode is experimental. It requires SQLite compiled with FTS5; it was verified with Node 22.23.2. Node 22.13.0 supports default search and falls back with a warning when FTS5 is unavailable. [Search evaluation](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/search-evaluation.md).

## Optional connections

Context Hub/portal and Confluence require explicit project configuration and credentials. They are separate from local project memory. A local task result does not automatically update portal acceptance. Use the configured profile and the integration's own plan/apply or assignment/report workflow.

Credentials belong in environment variables or supported native stores, not in exported records. Get current command syntax from `npx project-context portal --help` or `npx project-context confluence --help`.
