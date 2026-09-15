---
id: BACKLOG-EXECUTION-MANIFESTS-LINKED-TO-CONFIRMED-TASK-CONTRACTS
type: backlog
status: done
title: Execution manifests linked to confirmed task contracts
created_at: '2026-09-15T14:23:17+03:00'
updated_at: '2026-09-15T14:44:36+03:00'
retention: keep
modules:
  - router
files:
  - src/execution/types.ts
  - src/execution/store.ts
  - src/execution/runs.ts
deleted_files: []
tags:
  - task-execution
  - backlog
priority: P1
agent_size: medium
proposed_at: '2026-09-15T14:23:17+03:00'
source:
  kind: chat_prompt
source_refs:
  - TASK-20260915-142239-001
depends_on: []
acceptance_criteria:
  - >-
    Persist run identity, immutable task digest, base commit, branch/worktree
    identity, executor, attempt, timestamps and result; reject invalid
    repository paths and concurrent mutations.
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
    evidence_id: VERIFY-20260915-144436-002
---
# Execution manifests linked to confirmed task contracts

Persist run identity, immutable task digest, base commit, branch/worktree identity, executor, attempt, timestamps and result; reject invalid repository paths and concurrent mutations.

## Acceptance Criteria

- Persist run identity, immutable task digest, base commit, branch/worktree identity, executor, attempt, timestamps and result; reject invalid repository paths and concurrent mutations.

## Checks

- npm run build
- npm test
- npm run package:check
- node bin/project-context doctor --json

## Review

Confirm with `confirm-backlog-item` after human review before treating this as active backlog.
