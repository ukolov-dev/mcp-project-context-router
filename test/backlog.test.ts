import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { confirmBacklogItem, getBacklog, pickNextBacklogTask, proposeBacklogItem, transitionBacklogItem } from '../src/backlog/backlog.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  writeFileSync(
    resolve(tempDir, '.project-context/active/backlog/BACKLOG-FIRST.md'),
    `---
id: BACKLOG-FIRST
type: backlog
status: ready
priority: P0
agent_size: medium
title: First ready task
modules:
  - backend
tags:
  - resource-requests
source_refs: []
depends_on: []
acceptance_criteria:
  - Works
checks:
  - cd ppm-backend && ./gradlew test
---

# First ready task

Implement resource request API.
`,
  );
  writeFileSync(
    resolve(tempDir, '.project-context/active/backlog/BACKLOG-BLOCKED.md'),
    `---
id: BACKLOG-BLOCKED
type: backlog
status: blocked
priority: P0
agent_size: small
title: Blocked task
modules:
  - frontend
tags: []
depends_on:
  - BACKLOG-FIRST
checks: []
---

# Blocked task
`,
  );
  writeFileSync(
    resolve(tempDir, '.project-context/active/backlog/BACKLOG-READY-WITH-DEP.md'),
    `---
id: BACKLOG-READY-WITH-DEP
type: backlog
status: ready
priority: P0
agent_size: small
title: Ready-looking task with unresolved dependency
modules:
  - backend
tags: []
depends_on:
  - BACKLOG-BLOCKED
checks: []
---

# Ready-looking task with unresolved dependency
`,
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('backlog', () => {
  it('lists active backlog records and filters by status', () => {
    const result = getBacklog({ status: 'ready' });

    expect(result.items).toHaveLength(2);
    expect(result.items.find((item) => item.id === 'BACKLOG-FIRST')?.checks).toContain('cd ppm-backend && ./gradlew test');
    expect(result.items.find((item) => item.id === 'BACKLOG-READY-WITH-DEP')?.blockedBy).toEqual(['BACKLOG-BLOCKED']);
  });

  it('picks a ready task before blocked tasks', () => {
    const result = pickNextBacklogTask({ query: 'resource requests backend' });

    expect(result.selected?.id).toBe('BACKLOG-FIRST');
    expect(result.suggestedPrompt).toContain('BACKLOG-FIRST');
    expect(result.alternatives.some((item) => item.id === 'BACKLOG-READY-WITH-DEP')).toBe(false);
  });

  it('proposes a backlog item as a draft and confirms it into active backlog', () => {
    const proposal = proposeBacklogItem({
      title: 'Add backlog intake workflow',
      description: 'Allow agents to add reviewed backlog records from chat ideas.',
      priority: 'P1',
      agentSize: 'small',
      modules: ['doc'],
      tags: ['context-router'],
      sourceRefs: ['tools/ppm-context/README.md'],
      dependsOn: [],
      files: ['tools/ppm-context/src/backlog/backlog.ts'],
      acceptanceCriteria: ['Draft is created first', 'Human confirmation promotes active backlog'],
      checks: ['tools/ppm-context/bin/ppm-context lint'],
      status: 'proposed',
      force: false,
      dryRun: false,
    });

    expect(proposal.status).toBe('PROPOSED');
    expect(proposal.backlogId).toBe('BACKLOG-ADD-BACKLOG-INTAKE-WORKFLOW');
    expect(proposal.draftPath).toBe('.project-context/drafts/backlog/BACKLOG-ADD-BACKLOG-INTAKE-WORKFLOW.md');
    expect(existsSync(resolve(tempDir, proposal.draftPath ?? ''))).toBe(true);

    const dryRun = confirmBacklogItem({
      backlogId: proposal.backlogId,
      approvedBy: 'vitest',
      status: 'open',
      dryRun: true,
    });
    expect(dryRun.status).toBe('DRY_RUN');

    const confirmation = confirmBacklogItem({
      backlogId: proposal.backlogId,
      approvedBy: 'vitest',
      status: 'ready',
      dryRun: false,
    });
    expect(confirmation.status).toBe('CONFIRMED');
    expect(confirmation.targetPath).toBe('.project-context/active/backlog/BACKLOG-ADD-BACKLOG-INTAKE-WORKFLOW.md');
    const activeContent = readFileSync(resolve(tempDir, confirmation.targetPath), 'utf8');
    expect(activeContent).toContain('approved_by: vitest');
    expect(activeContent).toContain('status: ready');
  });

  it('prevents duplicate backlog proposals by generated id or title', () => {
    const first = proposeBacklogItem({
      title: 'First ready task',
      description: 'Duplicate of an existing active item.',
      priority: 'P2',
      agentSize: 'small',
      status: 'proposed',
      force: false,
      dryRun: false,
    });

    expect(first.status).toBe('DUPLICATE_OR_RELATED');
    expect(first.existingRecords).toContainEqual(expect.objectContaining({
      id: 'BACKLOG-FIRST',
      path: '.project-context/active/backlog/BACKLOG-FIRST.md',
      reason: 'same normalized title',
      blocking: true,
    }));
  });

  it('reports semantic related records for similar backlog proposals', () => {
    const result = proposeBacklogItem({
      title: 'Implement resource request API',
      description: 'Add backend API behavior for visible resource requests and filters.',
      priority: 'P2',
      agentSize: 'small',
      modules: ['backend'],
      tags: ['resource-requests'],
      status: 'proposed',
      force: false,
      dryRun: true,
    });

    expect(result.existingRecords.some((record) => record.id === 'BACKLOG-FIRST' && record.reason.includes('semantic overlap'))).toBe(true);
  });

  it('validates backlog lifecycle transitions', () => {
    expect(() => transitionBacklogItem({
      backlogId: 'BACKLOG-BLOCKED',
      status: 'ready',
      dryRun: true,
    })).toThrow(/ready backlog items require acceptance_criteria/);

    const result = transitionBacklogItem({
      backlogId: 'BACKLOG-FIRST',
      status: 'done',
      evidenceId: 'VERIFY-20260514-999',
      dryRun: true,
    });

    expect(result.status).toBe('DRY_RUN');
    expect(result.from).toBe('ready');
    expect(result.to).toBe('done');
  });
});
