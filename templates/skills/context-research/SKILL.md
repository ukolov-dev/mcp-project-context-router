---
name: context-research
description: Develop and resume project ideas using Context Router research records, preserving discussion stages, decisions and open questions, then turn agreed conclusions into linked backlog drafts. Use for idea exploration before implementation.
---

# Project research

Use Context Router's `planning` MCP profile, which exposes research and backlog tools. The `analyst`, `admin` and `full` profiles also expose research; `planning` includes backlog confirmation. If the tools are unavailable, explain the profile setting `PROJECT_CONTEXT_TOOL_PROFILE=planning` and that the MCP connection must be restarted. CLI equivalents are available through `project-context --help`.

When continuing an idea, search `list_research` and read its complete history with `get_research` before adding another record. Start new ideas with `create_research`: state the question being investigated, known open questions and relevant sources. Research belongs under `.project-context/active/research/`, separate from tasks.

Capture useful milestones with `append_research_entry`: discussion alternatives and tradeoffs, findings with evidence, or decisions with their reasons. Save meaningful discussion outcomes, not invented transcripts or every conversational turn. Preserve uncertainty and distinguish the user's agreement from an agent suggestion. Include source/chat references when available; never invent a chat URL. If the user wants a verbatim excerpt, put the supplied excerpt in entry content and identify it as a quote.

Each mutation requires the current `expectedRevision` and a stable, descriptive `requestKey` such as `cache-comparison-1`. Reuse the exact key and payload when retrying the same operation. For new material, use a new key. After a revision conflict, reload the record and incorporate concurrent changes before retrying. `openQuestions`, when supplied, replaces the current list; omitted means unchanged, `[]` means resolved. Earlier lists remain in history.

Use `transition_research` to move from `idea` to `exploring`, to pause, close, or resume. Record the reason. A paused or completed idea must return to `exploring` before adding findings. Reopening clears the current conclusion but preserves prior conclusions and linked backlog work.

When the discussion reaches a supported conclusion, record the agreed direction, rejected alternatives, scope and limitations. Resolve questions or explicitly document accepted limitations; do not silently drop unanswered questions. Move to `ready` with the conclusion. Research content is exploratory context, not automatically an approved product contract.

For requested backlog handoff, use `research_to_backlog` with a focused item, acceptance criteria and checks. It previews by default. Set `dryRun: false` when the user has authorized creating the draft. Each separate backlog item gets its own request key; one research can produce several items. Inspect duplicate/related results instead of forcing duplicates. `handed_off` means backlog drafts were linked, not that implementation is complete. Use the linked backlog statuses to report implementation progress.

Existing `confirm_backlog_item` and `task_from_backlog` workflows handle approval and implementation preparation. Creating or discussing research does not authorize implementing it. Keep research history intact when a direction is abandoned; close it with the rationale so future discussions can reuse the findings.
