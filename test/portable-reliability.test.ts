import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { contextDoctor } from '../src/doctor/doctor.js';
import { checkSourceCoverage } from '../src/doctor/coverage.js';
import { findExistingCapability } from '../src/reuse-scan/reuse.js';
import { reviewDiffForRefactor } from '../src/refactor-review/refactor.js';
import { inferModulesFromSignals } from '../src/storage/inference.js';
import { lintContext } from '../src/storage/lint.js';
import { parseRecord, writeMarkdown } from '../src/storage/markdown.js';
import { confirmTaskContract, confirmTaskInputSchema, finalizeWork, finalizeWorkInputSchema, validateTask } from '../src/task-validation/task.js';
import { getVerificationPlan, recordVerificationEvidence, verificationEvidenceInputSchema } from '../src/verification/verification.js';

let root: string;
let previous: string;
function put(file: string, text: string) { mkdirSync(dirname(resolve(root, file)), { recursive: true }); writeFileSync(resolve(root, file), text); }
function record(id: string, status = 'active', extra: Record<string, unknown> = {}, area = 'active') {
  const path = resolve(root, `.project-context/${area}/decisions/${id}.md`);
  writeMarkdown(path, { id, type: 'decision', status, title: 'Document comments policy', modules: ['workspace_ui'], retention: 'keep', ...extra }, '# Document comments policy\nComments and revision history.');
  return path;
}
function task() {
  const draft = validateTask('Add comments to workspace');
  confirmTaskContract(confirmTaskInputSchema.parse({ taskId: draft.taskDraftId, goal: 'Add comments', acceptanceCriteria: ['Comments work'], testExpectations: ['npm test'], modules: ['workspace_ui'], files: ['ui/comments.mjs'] }));
  return draft.taskDraftId;
}
beforeEach(() => {
  previous = process.cwd(); root = mkdtempSync(resolve(tmpdir(), 'router-reliability-')); process.chdir(root);
  execFileSync('git', ['init', '-q']);
  put('ui/comments.mjs', 'export function notifyAccessDenied() {}\n');
  put('ui/model.mts', 'export type Revision = string;\n');
  put('ui/test/comments.test.mts', 'export function checkComments() {}\n');
  put('deploy/local/compose.yaml', 'services: {}\n');
  put('AGENTS.md', '# Required instructions\nAlways verify changes.\n');
  put('.gitignore', '.project-context/indexes/\n.project-context/drafts/\n');
  put('.project-context/project.yaml', `project: { name: Synthetic workspace }
routing: { default_modules: [workspace_ui] }
modules:
  workspace_ui:
    path: ui
    aliases: [workspace-ui, comments, комментарии, портале]
    source_globs: ['ui/**/*.{mjs,mts}']
    playbooks: [AGENTS.md]
  delivery:
    path: deploy
    aliases: [deployment, деплой]
    source_globs: ['deploy/**/*.yaml']
    playbooks: [AGENTS.md]
commands:
  test: { run: npm test, required_for: [workspace_ui], context_pack: true }
  deployment: { run: docker compose config, required_for: [delivery], context_pack: true }
`);
  execFileSync('git', ['add', '.']);
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Fixture']);
});
afterEach(() => { process.chdir(previous); rmSync(root, { recursive: true, force: true }); });

it('routes configured RU/EN queries without doc, preserves budget and required instructions', () => {
  record('DECISION-20261001-120000-001');
  const en = buildContextPack({ query: 'comments revision history', maxTokens: 1800 });
  const ru = buildContextPack({ query: 'Добавить комментарии к документу в портале', maxTokens: 1800 });
  expect(ru.routing?.modules).toEqual(en.routing?.modules);
  expect(ru.records.map((item) => item.id)).toEqual(en.records.map((item) => item.id));
  expect(ru.commands).toEqual(['npm test']);
  expect(ru.playbooks).toContain('AGENTS.md');
  expect(ru.budget.estimatedTokens).toBeLessThanOrEqual(1800);
  expect(validateTask('unmatched request').suggestedContract.modules).toEqual(['workspace_ui']);
  expect(buildContextPack({ query: 'unmatched request' }).routing?.basis).toBe('configured fallback');
});
it('routes Windows deployment paths and explains unknown modules and missing coverage', () => {
  expect(inferModulesFromSignals({ files: ['deploy\\local\\compose.yaml'] })).toEqual(['delivery']);
  const pack = buildContextPack({ query: 'deployment', files: ['deploy/local/compose.yaml', 'automation/job.yml'], modules: ['missing'] });
  expect(pack.commands).toContain('docker compose config');
  expect(pack.routing?.unknownModules).toEqual(['missing']);
  expect(pack.routing?.unmappedFiles).toEqual(['automation/job.yml']);
});
it('finds mjs/mts capabilities and resolves reviewed record/module aliases', () => {
  record('DECISION-20261001-120000-001', 'active', { modules: ['workspace-ui'] });
  expect(findExistingCapability('notifyAccessDenied', ['workspace-ui']).matches[0]?.path).toBe('ui/comments.mjs');
  expect(findExistingCapability('Revision', ['workspace_ui']).matches.some((item) => item.path === 'ui/model.mts')).toBe(true);
  expect(buildContextPack({ query: 'comments', modules: ['workspace_ui'] }).records).toHaveLength(1);
});
it('reports omitted sources without indexing intentional exclusions or dependencies', () => {
  put('ui/omitted.ts', 'export function omittedCapability() {}');
  put('ui/node_modules/dependency/a.ts', 'export function dependency() {}');
  put('archive/old.ts', 'export function retired() {}');
  const result = checkSourceCoverage();
  expect(result.details).toEqual(['ui/omitted.ts: workspace_ui']);
  expect(findExistingCapability('omittedCapability', ['workspace_ui']).matches).toHaveLength(0);
});
it('hides superseded/cancelled/retired records and labels historical provenance on opt-in', () => {
  record('DECISION-20261001-120000-001', 'superseded', { superseded_by: 'DECISION-20261002-120000-001', authority: 'source-opinion' });
  record('DECISION-20261002-120000-001', 'active', { confirmed_by_human: true, confirmed_at: '2026-10-02T12:00:00Z' });
  record('DECISION-20261001-120000-002', 'retired');
  record('DECISION-20261001-120000-003', 'cancelled');
  const current = buildContextPack({ query: 'comments' });
  expect(current.records.map((item) => item.id)).toEqual(['DECISION-20261002-120000-001']);
  expect(current.records[0]).toMatchObject({ authority: 'user-confirmed', status: 'active', as_of: '2026-10-02T12:00:00Z' });
  const history = buildContextPack({ query: 'comments', includeHistory: true });
  expect(history.records.find((item) => item.status === 'superseded')).toMatchObject({ category: 'historical', authority: 'source-opinion', superseded_by: 'DECISION-20261002-120000-001' });
});
it('separates active missing references from historical/draft noise and honors deleted_files', () => {
  record('DECISION-20261001-120000-001', 'active', { files: ['missing.ts'] });
  record('DECISION-20261001-120000-002', 'retired', { files: ['retired.ts'] });
  record('DECISION-20261001-120000-003', 'draft', { files: ['draft.ts'] }, 'drafts');
  record('DECISION-20261001-120000-004', 'active', { files: ['deleted.ts'], deleted_files: ['deleted.ts'] });
  expect(contextDoctor().diagnostics.find((item) => item.id === 'context-file-references')?.status).toBe('warn');
  expect(contextDoctor({ commitValidation: true }).diagnostics.find((item) => item.id === 'context-file-references')?.status).toBe('fail');
  const lint = lintContext();
  expect(lint.categories.active).toHaveLength(1); expect(lint.categories.historical).toHaveLength(1); expect(lint.categories.draft).toHaveLength(1);
});
it('diagnoses untracked durable records without staging them', () => {
  record('DECISION-20261001-120000-001');
  const result = contextDoctor({ fixDryRun: true });
  expect(result.diagnostics.find((item) => item.id === 'durable-memory')).toMatchObject({ status: 'warn' });
  expect(result.fixes?.some((item) => item.id === 'review-durable-memory')).toBe(true);
  expect(execFileSync('git', ['diff', '--cached', '--name-only'], { encoding: 'utf8' })).toBe('');
});
it('records required omissions as partial and optional skips with boundaries and linked retries', () => {
  const id = task();
  const first = recordVerificationEvidence(verificationEvidenceInputSchema.parse({ targetId: id, summary: 'Partial verification', checks: [{ command: 'optional probe', status: 'passed', required: false }] }));
  expect(parseRecord(resolve(root, first.path)).status).toBe('partial');
  const second = recordVerificationEvidence(verificationEvidenceInputSchema.parse({ targetId: id, summary: 'Required checks passed', retriesEvidenceId: first.id, boundaries: { codeState: 'working tree', runtime: 'Node', environment: 'isolated fixture' }, checks: [...getVerificationPlan({ id }).required.map((check) => ({ command: check.command, status: 'passed' })), { command: 'optional probe', status: 'skipped', required: false, reason: 'No external service' }] }));
  const evidence = parseRecord(resolve(root, second.path));
  expect(evidence.status).toBe('passed'); expect(evidence.frontmatter.retries_evidence_id).toBe(first.id);
  expect(evidence.frontmatter.boundaries).toMatchObject({ environment: 'isolated fixture' });
});
it('cannot downgrade plan-required checks or claim complete while pending', () => {
  const id = task();
  expect(() => recordVerificationEvidence(verificationEvidenceInputSchema.parse({ targetId: id, summary: 'Incomplete', completion: 'complete', checks: [{ command: 'npm test', status: 'skipped', required: false }] }))).toThrow(/required/);
  expect(() => finalizeWork(finalizeWorkInputSchema.parse({ taskId: id, summary: 'One passed test', completion: 'complete', tests: [{ command: 'npm test', status: 'passed' }] }))).toThrow(/execution run/);
  const partial = finalizeWork(finalizeWorkInputSchema.parse({ taskId: id, summary: 'Migration pending', completion: 'blocked' }));
  expect(partial).toMatchObject({ completion: 'blocked', taskStatus: 'blocked' });
});
it('scopes heuristic refactor review to task files and explicit empty scope', () => {
  const id = task();
  put('ui/comments.mjs', 'export function notifyAccessDenied() { return false; }');
  put('deploy/local/compose.yaml', 'services: { changed: {} }');
  expect(reviewDiffForRefactor(id).files).toEqual(['ui/comments.mjs']);
  expect(reviewDiffForRefactor(undefined, { files: [] }).files).toEqual([]);
  expect(reviewDiffForRefactor(undefined, { files: ['ui\\comments.mjs'] }).files).toEqual(['ui/comments.mjs']);
  expect(reviewDiffForRefactor().warnings).toHaveLength(1);
});

it('does not make history-only missing references a commit blocker', () => {
  record('DECISION-20261001-120000-001', 'superseded', { files: ['removed.ts'] });
  expect(contextDoctor({ commitValidation: true }).diagnostics.find((item) => item.id === 'context-file-references')).toMatchObject({ status: 'ok' });
});
it('does not infer authority from active status or silently resolve ambiguous aliases', () => {
  record('DECISION-20261001-120000-001', 'active', { authority: 'source-opinion' });
  expect(buildContextPack({ query: 'comments' }).records[0].authority).toBe('source-opinion');
  const config = readFileSync('.project-context/project.yaml', 'utf8').replace('aliases: [deployment, деплой]', 'aliases: [deployment, деплой, workspace-ui]');
  put('.project-context/project.yaml', config);
  expect(buildContextPack({ query: 'unknown', modules: ['workspace-ui'] }).routing?.unknownModules).toEqual(['workspace-ui']);
});
