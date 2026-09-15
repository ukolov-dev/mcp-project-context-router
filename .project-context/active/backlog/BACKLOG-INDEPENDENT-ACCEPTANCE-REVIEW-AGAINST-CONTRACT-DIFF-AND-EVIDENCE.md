---
id: BACKLOG-INDEPENDENT-ACCEPTANCE-REVIEW-AGAINST-CONTRACT-DIFF-AND-EVIDENCE
type: backlog
status: done
title: 'Independent acceptance review against contract, diff and evidence'
created_at: '2026-09-15T14:23:17+03:00'
updated_at: '2026-09-15T14:44:36+03:00'
retention: keep
modules:
  - router
files:
  - src/execution/acceptance.ts
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
acceptance_criteria:
  - >-
    Build a review bundle and record a structured criterion-by-criterion verdict
    tied to exact task and code digests; reject missing criteria, self-review
    and stale passing reports.
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
    evidence_id: VERIFY-20260915-144436-003
---
# Independent acceptance review against contract, diff and evidence

Build a review bundle and record a structured criterion-by-criterion verdict tied to exact task and code digests; reject missing criteria, self-review and stale passing reports.

## Acceptance Criteria

- Build a review bundle and record a structured criterion-by-criterion verdict tied to exact task and code digests; reject missing criteria, self-review and stale passing reports.

## Checks

- npm run build
- npm test
- npm run package:check
- node bin/project-context doctor --json

## Review

Confirm with `confirm-backlog-item` after human review before treating this as active backlog.
