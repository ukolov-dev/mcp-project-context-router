---
name: project-context-workflow
description: Use Project Context Router task contracts, scoped context and verification when implementing features or fixing bugs in a configured repository. Use for implementation work; idea exploration belongs in context-research.
---

# Project Context workflow

Work from the repository that owns the request. Read `.project-context/project.yaml`
for module paths, playbooks and verification commands. A native MCP connection stays
bound to its configured repository even after a shell `cd`. If it points elsewhere,
use the configured `context_router.cli_command` from the correct root instead.
Use `project-context --help` or command help for CLI equivalents and input schemas.

The `core` MCP profile exposes the ordinary task workflow below. Use the actual
configured MCP server name and available tools. Scope client-configuration changes
to the user's request. A config file alone does not verify a working connection.

1. Reuse the confirmed Task Contract when continuing its work. For a new implementation
   request, use `validate_task` and `confirm_task_contract` to capture the user's agreed
   goal, scope and acceptance criteria. Resolve missing details from available context;
   ask only for unresolved information needed to implement correctly. Do not infer
   implementation permission from an exploratory discussion or unrelated backlog item.
2. Call `build_context_pack` with the task and concrete modules/files in this working
   copy. Read its selected sources and applicable playbooks. Keep the context scoped;
   use history/archive only when the request needs them. Use `find_existing_capability`
   before adding reusable code. Record statuses and source claims are not runtime proof.
3. Use `get_verification_plan`, implement within scope and run applicable checks.
   Review the actual diff alongside `review_diff_for_refactor`; its result is a heuristic,
   not a semantic review or permission for unrelated cleanup. Save actual commands,
   outcomes, skipped-check reasons and environment limits with `record_verification_evidence`.
4. Call `finalize_work` to save the result as `last_result` on the confirmed task.
   It returns `FINALIZED` and `taskPath`, not a summary draft. Report the delivered
   behavior, checks and material limits. Partial or blocked work must remain explicit.

`completion: complete` requires a fresh independently accepted `ready_to_merge`
execution run. The `developer`, `admin` and `full` profiles expose execution/review
records; CLI equivalents are also available. Preserve that gate when tools are
unavailable. Successful tests alone do not establish independent acceptance.

Keep private instructions, credentials and generated indexes out of durable records.
Publishing, deployment and external messages still require authorization for those
specific actions; a task contract or installed skill does not grant it.
