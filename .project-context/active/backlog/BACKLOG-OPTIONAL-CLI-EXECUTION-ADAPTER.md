---
id: BACKLOG-OPTIONAL-CLI-EXECUTION-ADAPTER
type: backlog
status: done
title: Optional CLI execution adapter
created_at: '2026-09-15T14:23:17+03:00'
updated_at: '2026-09-15T14:44:36+03:00'
retention: keep
modules:
  - router
files:
  - src/execution/runner.ts
  - src/cli.ts
  - src/mcp/server.ts
  - docs/execution.md
deleted_files: []
tags:
  - task-execution
  - projects
  - backlog
priority: P1
agent_size: medium
proposed_at: '2026-09-15T14:23:17+03:00'
source:
  kind: chat_prompt
source_refs:
  - TASK-20260915-142239-001
depends_on:
  - BACKLOG-EXECUTION-MANIFESTS-LINKED-TO-CONFIRMED-TASK-CONTRACTS
  - BACKLOG-INDEPENDENT-ACCEPTANCE-REVIEW-AGAINST-CONTRACT-DIFF-AND-EVIDENCE
  - BACKLOG-EVIDENCE-GATED-TASK-EXECUTION-LIFECYCLE
acceptance_criteria:
  - >-
    Provide project-context run TASK with a reviewable dry-run plan and explicit
    execution using external implementation/review processes, bounded commands
    and recorded evidence; keep process orchestration outside MCP.
checks:
  - npm run build
  - npm test
  - 'npm run package:check'
  - node bin/project-context doctor --json
approved_by: user
confirmed_at: '2026-09-15T14:23:17+03:00'
lifecycle:
  - at: '2026-09-15T14:23:17+03:00'
    from: ready
    to: in_progress
    reason: User requested implementation with subagents and final verification.
    evidence_id: null
  - at: '2026-09-15T14:44:36+03:00'
    from: in_progress
    to: done
    reason: >-
      Implemented; all required checks and independent integration review
      passed.
    evidence_id: VERIFY-20260915-144436-005
---
# Optional CLI execution adapter

Provide project-context run TASK with a reviewable dry-run plan and explicit execution using external implementation/review processes, bounded commands and recorded evidence; keep process orchestration outside MCP.

## Acceptance Criteria

- Provide project-context run TASK with a reviewable dry-run plan and explicit execution using external implementation/review processes, bounded commands and recorded evidence; keep process orchestration outside MCP.

## Checks

- npm run build
- npm test
- npm run package:check
- node bin/project-context doctor --json

## Review

Confirm with `confirm-backlog-item` after human review before treating this as active backlog.
