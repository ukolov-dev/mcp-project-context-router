---
id: BACKLOG-EVIDENCE-GATED-TASK-EXECUTION-LIFECYCLE
type: backlog
status: done
title: Evidence-gated task execution lifecycle
created_at: '2026-09-15T14:23:17+03:00'
updated_at: '2026-09-15T14:44:36+03:00'
retention: keep
modules:
  - router
files:
  - src/execution/runs.ts
deleted_files: []
tags:
  - task-execution
  - frontend
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
acceptance_criteria:
  - >-
    Enforce confirmed → implementing → verifying → reviewing → ready_to_merge or
    failed, with run-bound successful required checks and passing acceptance
    review; retry through a new attempt.
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
    evidence_id: VERIFY-20260915-144436-004
---
# Evidence-gated task execution lifecycle

Enforce confirmed → implementing → verifying → reviewing → ready_to_merge or failed, with run-bound successful required checks and passing acceptance review; retry through a new attempt.

## Acceptance Criteria

- Enforce confirmed → implementing → verifying → reviewing → ready_to_merge or failed, with run-bound successful required checks and passing acceptance review; retry through a new attempt.

## Checks

- npm run build
- npm test
- npm run package:check
- node bin/project-context doctor --json

## Review

Confirm with `confirm-backlog-item` after human review before treating this as active backlog.
