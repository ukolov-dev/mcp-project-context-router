import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateTask, confirmTaskContract, finalizeWork } from '../src/task-validation/task.js';
import { lintContext } from '../src/storage/lint.js';
import { nextRecordId } from '../src/storage/markdown.js';
import { nowCompactTimestamp, todayCompact } from '../src/storage/time.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: PPM Test
routing:
  default_modules: [frontend]
  documentation_modules: [doc]
context_router:
  cli_command: tools/ppm-context/bin/ppm-context
modules:
  backend:
    path: ppm-backend
    aliases: [backend, api, endpoint, liquibase, database, access]
    playbooks: []
  frontend:
    path: ppm-frontend
    aliases: [frontend, страниц, фильтр, access]
    playbooks: []
  doc:
    path: .project-context
    aliases: [doc, readme, context, workflow, документац]
    playbooks: []
  tools:
    path: tools/ppm-context
    aliases: [tools, context, workflow]
    playbooks: []
commands:
  context_lint:
    run: tools/ppm-context/bin/ppm-context lint
    context_pack: true
    required_for: [doc, tools]
    writes_to: []
  backend_tests:
    run: ./scripts/backend-test-java21.sh
    context_pack: true
    required_for: [backend]
    writes_to: []
  frontend_build:
    run: cd ppm-frontend && npm run build
    context_pack: true
    required_for: [frontend]
    writes_to: []
  frontend_tests:
    run: cd ppm-frontend && npm run test
    context_pack: true
    required_for: [frontend]
    writes_to: []
  tools_tests:
    run: npm --prefix tools/ppm-context run test
    context_pack: true
    required_for: [tools]
    writes_to: []
  full_verify:
    run: scripts/verify.sh
    required_for: [backend, frontend, doc, tools]
    writes_to: []
`, 'utf8');
});

afterEach(() => {
  vi.useRealTimers();
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('task validation flow', () => {
  it('creates a draft task and reports blocking filter questions', () => {
    const result = validateTask('Добавить фильтры списка проектов');

    expect(result.status).toBe('NEEDS_CLARIFICATION');
    expect(result.workflow).toBe('standard');
    expect(result.taskDraftId).toMatch(/^TASK-\d{8}-\d{6}-\d{3}$/);
    expect(result.blockingQuestions.length).toBeGreaterThan(0);
    expect(result.suggestedContract.acceptanceCriteria.length).toBeGreaterThan(0);
    expect(result.guidance.contextPack).toContain('standard');
    expect(existsSync(resolve(tempDir, '.project-context/drafts/tasks', `${result.taskDraftId}.md`))).toBe(true);
  });

  it('classifies local documentation work as fast with compact guidance', () => {
    const result = validateTask('Документационная правка README для context workflow');

    expect(result.status).toBe('READY');
    expect(result.workflow).toBe('fast');
    expect(result.guidance.contextPack).toContain('workflow=fast');
    expect(result.suggestedContract.scope).toContain('Use a compact context pack and the smallest check that proves the change.');
    expect(new Set(result.suggestedContract.modules)).toEqual(new Set(['tools', 'doc']));
    expect(result.suggestedContract.testExpectations).toContain('npm --prefix tools/ppm-context run test');
  });

  it('classifies frontend feature work as standard', () => {
    const result = validateTask('Добавить frontend страницу списка проектов');

    expect(result.workflow).toBe('standard');
    expect(result.suggestedContract.testExpectations).toContain('cd ppm-frontend && npm run build');
    expect(result.suggestedContract.testExpectations).toContain('cd ppm-frontend && npm run test');
  });

  it('classifies auth database and API contract work as strict', () => {
    const result = validateTask('Добавить API endpoint с Liquibase migration и role access policy');

    expect(result.workflow).toBe('strict');
    expect(result.guidance.contextPack).toContain('full context pack');
    expect(result.suggestedContract.scope).toContain('Confirm the API, data, persistence, authorization, or security contract before implementation.');
    expect(result.suggestedContract.testExpectations).toContain('./scripts/backend-test-java21.sh');
  });

  it('promotes a draft task to an active confirmed contract', () => {
    const draft = validateTask('Починить 500 на списке проектов', 'bug');
    const draftPath = resolve(tempDir, '.project-context/drafts/tasks', `${draft.taskDraftId}.md`);
    const result = confirmTaskContract({
      taskId: draft.taskDraftId,
      goal: 'Починить 500 на списке проектов',
      scope: ['Backend endpoint handling'],
      outOfScope: ['Frontend redesign'],
      acceptanceCriteria: ['Endpoint does not return 500'],
      risks: ['Unknown root cause'],
      testExpectations: ['cd ppm-backend && ./gradlew test'],
      modules: ['backend'],
    });

    expect(result.status).toBe('CONFIRMED');
    expect(result.path).toBe(`.project-context/active/tasks/${draft.taskDraftId}.md`);
    expect(existsSync(resolve(tempDir, result.path))).toBe(true);
    expect(existsSync(draftPath)).toBe(false);
    expect(existsSync(resolve(tempDir, '.project-context/trash', `${draft.taskDraftId}.draft.md`))).toBe(true);
  });

  it('allocates the next id after the highest existing sequence for the current second', () => {
    vi.setSystemTime(new Date('2026-06-09T10:11:12+03:00'));
    const timestamp = nowCompactTimestamp();
    mkdirSync(resolve(tempDir, '.project-context/active/tasks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, `.project-context/active/tasks/TASK-${timestamp}-020.md`),
      `---
id: TASK-${timestamp}-020
type: task
status: confirmed
title: Existing high task id
confirmed_by_human: true
modules: []
files: []
tags: []
retention: normal
---

# Existing high task id
`,
      'utf8',
    );

    expect(nextRecordId('TASK')).toBe(`TASK-${timestamp}-021`);
  });

  it('keeps legacy date-only context ids valid while new records use timestamps', () => {
    const date = todayCompact();
    mkdirSync(resolve(tempDir, '.project-context/active/tasks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, `.project-context/active/tasks/TASK-${date}-020.md`),
      `---
id: TASK-${date}-020
type: task
status: confirmed
title: Existing legacy task id
confirmed_by_human: true
modules: []
files: []
tags: []
retention: normal
---

# Existing legacy task id
`,
      'utf8',
    );

    const result = lintContext(false);

    expect(result.errors).toEqual([]);
  });

  it('allows deleted_files to document intentionally removed paths without lint warnings', () => {
    mkdirSync(resolve(tempDir, '.project-context/active/tasks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-999.md'),
      `---
id: TASK-20260514-999
type: task
status: confirmed
title: Cleanup deleted docs
confirmed_by_human: true
modules:
  - doc
files:
  - doc/obsolete.md
deleted_files:
  - doc/obsolete.md
tags: []
retention: normal
---

# Cleanup deleted docs
`,
      'utf8',
    );

    const result = lintContext(false);

    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('records skipped verification checks with reasons in finalize drafts', () => {
    const result = finalizeWork({
      taskId: 'TASK-20260514-999',
      summary: 'Implemented context verification planning.',
      changedFiles: ['tools/ppm-context/src/task-validation/task.ts'],
      tests: [{ command: 'npm --prefix tools/ppm-context run test', status: 'passed' }],
      skippedChecks: [{ command: 'cd ppm-backend && ./gradlew test', reason: 'Backend code was not changed.' }],
    });

    expect(result.status).toBe('CREATED');
    if (result.status === 'SKIPPED') throw new Error(result.reason);
    const content = readFileSync(resolve(tempDir, result.draftPath), 'utf8');
    expect(content).toContain('## Skipped Checks');
    expect(content).toContain('Backend code was not changed.');
  });

  it('autofills finalize changed files from git without inventing tests', () => {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'ignore' });
    mkdirSync(resolve(tempDir, 'tools/ppm-context/src'), { recursive: true });
    writeFileSync(resolve(tempDir, 'tools/ppm-context/src/task-validation.ts'), 'export const before = true;\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(resolve(tempDir, 'tools/ppm-context/src/task-validation.ts'), 'export const after = true;\n', 'utf8');

    const result = finalizeWork({
      taskId: 'TASK-20260514-999',
      summary: 'Implemented safe finalize autofill.',
      autoFill: true,
    });

    expect(result.status).toBe('CREATED');
    if (result.status === 'SKIPPED') throw new Error(result.reason);
    const content = readFileSync(resolve(tempDir, result.draftPath), 'utf8');
    expect(content).toContain('tools/ppm-context/src/task-validation.ts');
    expect(content).toContain('## Tests');
    expect(content).toContain('Нет.');
  });

  it('skips taskless git-only finalization instead of creating an orphan draft', () => {
    const result = finalizeWork({
      summary: 'Pushed an already verified branch.',
      changedFiles: ['tools/ppm-context/README.md'],
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'SKIPPED',
      requiresHumanReview: false,
    }));
    expect(existsSync(resolve(tempDir, '.project-context/drafts/run-summaries'))).toBe(false);
  });

  it('reuses a finalize draft for the same task and commit', () => {
    execFileSync('git', ['init'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir, stdio: 'ignore' });
    writeFileSync(resolve(tempDir, 'README.md'), 'baseline\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tempDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: tempDir, stdio: 'ignore' });

    const first = finalizeWork({
      taskId: 'TASK-20260514-999',
      summary: 'First finalization.',
      changedFiles: ['README.md'],
    });
    const second = finalizeWork({
      taskId: 'TASK-20260514-999',
      summary: 'Repeated finalization.',
      changedFiles: ['README.md'],
    });

    expect(first.status).toBe('CREATED');
    expect(second.status).toBe('UPDATED');
    if (first.status === 'SKIPPED' || second.status === 'SKIPPED') throw new Error('Expected a task-linked draft.');
    expect(second.draftPath).toBe(first.draftPath);
  });
});
