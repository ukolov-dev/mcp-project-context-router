# Agent workflow

Use the router to carry the agreed task scope from the request to a verified result.

## Agree on the task

For a new implementation request, use `validate_task` and `confirm_task_contract`. Store the goal, scope, acceptance criteria, risks and expected checks. Reuse an existing confirmed contract when continuing the same task. Resolve missing details from available context; ask about genuine blockers.

Exploring an idea does not authorize implementing it. Use `context-research` for findings, alternatives and conclusions; hand agreed work to a linked backlog draft.

## Gather scoped context

Call `build_context_pack` with the task and concrete module/file hints. Read its sources and applicable playbooks. Use `find_existing_capability` before adding reusable code.

```bash
npx project-context pack "Update customer service" --modules app --file src/customer.ts
npx project-context reuse-scan "CustomerService" --modules app
```

The native MCP server stays bound to its configured repository after a shell `cd`. If it points elsewhere, use the project-configured CLI from the correct root. A record's status or date is a claim about knowledge, not proof of live behavior.

## Implement and verify

Use `get_verification_plan` to identify checks. Run them, read the actual diff and use `review_diff_for_refactor` for its scoped heuristic. The heuristic is not a semantic review or permission for unrelated cleanup.

Save actual commands, outcomes, skipped-check reasons and environment boundaries using `record_verification_evidence`. Do not claim a test proves deployment or live integration when it only uses a local fixture.

## Save the result

`finalize_work` saves `last_result` on the confirmed task. It returns `FINALIZED`, `taskPath`, `completion` and `taskStatus`; no separate summary draft is created.

Explicit `partial` keeps work in progress and `blocked` records a blocker. Without explicit completion the task status is preserved. `complete` requires a fresh independently accepted `ready_to_merge` execution run. Successful tests alone are insufficient. Execution/review tools are available in `developer`, `admin` and `full`; CLI equivalents remain available.

```bash
npx project-context verify-task TASK-ID
npx project-context refactor-review --task TASK-ID
npx project-context finalize-work TASK-ID --input .project-context/drafts/result.json
```

Replace `TASK-ID` with the real ID. A minimal result input is:

```json
{
  "summary": "Implemented the agreed change",
  "changedFiles": ["src/customer.ts"],
  "completion": "partial",
  "tests": [{ "command": "npm test", "status": "passed" }]
}
```

For execution-run details, see the [execution guide](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/execution.md).

## Use bundled skills

```bash
npx project-context init --with-skills
```

`project-context-workflow` guides this process; `context-research` supports idea exploration. Existing copies are preserved and updates are manual. A skill guides the agent; MCP still enforces its own checks. Publishing, deployment and external messages require authorization for those actions.
