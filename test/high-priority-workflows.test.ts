import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getBacklogDependencyGraph, taskFromBacklog } from '../src/backlog/backlog.js';
import { buildContextPack } from '../src/context-pack/pack.js';
import { currentTruthAudit } from '../src/current-truth/current-truth.js';
import { contextDoctor } from '../src/doctor/doctor.js';
import { checkIndexFresh, rebuildIndex, searchIndex } from '../src/indexer/sqlite.js';
import { promoteDraft, promoteDraftsBatch } from '../src/promotion/promote.js';
import {
  analystDeltaToBacklog,
  buildAnalystContextPack,
  findRequirements,
  findSourceChunks,
  getConflicts,
  traceRequirement,
} from '../src/project-context/analytics.js';
import {
  buildProjectContextPack,
  findDataEntities,
  findIntegrations,
  getDecisions,
  proposeContextUpdate,
  searchProjectContext,
} from '../src/project-context/project-context.js';
import { importRpDatabase, proposeAnalystSource } from '../src/project-context/rp-import.js';
import { getProjectSnapshot } from '../src/project-snapshot/snapshot.js';
import { lintContext } from '../src/storage/lint.js';
import { specToBacklog } from '../src/spec-intake/spec-to-backlog.js';
import { getVerificationPlan, listVerificationEvidence, recordVerificationEvidence } from '../src/verification/verification.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-high-priority-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/decisions'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/integrations'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/data-entities'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/active/tasks'), { recursive: true });
  mkdirSync(resolve(tempDir, '.project-context/drafts/decisions'), { recursive: true });
  mkdirSync(resolve(tempDir, 'doc/specification'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: PPM
  purpose: Test project purpose
  roles: [Developer]
  flows: [Validate task, finalize work]
routing:
  default_modules: [frontend]
  documentation_modules: [doc]
context_router:
  package_path: tools/ppm-context
  cli_command: tools/ppm-context/bin/ppm-context
  install_command: npm install --prefix tools/ppm-context
  mcp_server_name: ppm_context
  resource_scheme: ppm-context
  codex_config_path: .codex/config.toml
  codex_hooks_path: .codex/hooks.json
  required_hook_events: [UserPromptSubmit, PostToolUse, Stop]
  git_hooks_path: .githooks
  git_hooks_install_command: scripts/install-git-hooks.sh
  cache_dependency_files: [tools/ppm-context/src/context-pack/pack.ts]
modules:
  backend:
    path: ppm-backend
    playbooks: [AGENTS.md, playbooks/java-backend.md, playbooks/testing.md]
    aliases: [backend, api, liquibase, keycloak, jwt, resource request]
    source_globs:
      - "ppm-backend/src/main/java/**/*.java"
      - "ppm-backend/src/test/java/**/*.java"
      - "ppm-backend/src/main/resources/db/changelog/changes/**/*.{xml,yaml,yml}"
  frontend:
    path: ppm-frontend
    playbooks: [AGENTS.md, ppm-frontend/AGENTS.md]
    aliases: [frontend, react, ui, resource request]
    source_globs: ["ppm-frontend/src/**/*.{ts,tsx}"]
  infra:
    path: infra
    playbooks: [AGENTS.md]
    aliases: [infra, svs, gitlab, helmwave, keycloak, browser]
    source_globs: ["infra/**/*.{yml,yaml,sh,sql,json}"]
  doc:
    path: .project-context
    playbooks: [AGENTS.md, tools/ppm-context/README.md, .project-context/README.md]
    aliases: [doc, docs, context, analyst, requirement, source chunk]
    source_globs: ["playbooks/*.md", "doc/**/*.md"]
  tools:
    path: tools/ppm-context
    playbooks: [AGENTS.md, tools/ppm-context/README.md, .project-context/README.md]
    aliases: [tools, context router, mcp, snapshot]
    source_globs: ["tools/ppm-context/src/**/*.ts"]
commands:
  context_lint:
    run: tools/ppm-context/bin/ppm-context lint
    context_pack: true
    required_for: [doc, tools]
    writes_to: []
  context_doctor:
    run: tools/ppm-context/bin/ppm-context doctor
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
  tools_build:
    run: npm --prefix tools/ppm-context run build
    context_pack: true
    required_for: [tools]
    writes_to: []
  tools_tests:
    run: npm --prefix tools/ppm-context run test
    context_pack: true
    required_for: [tools]
    writes_to: []
  full_verify:
    run: scripts/verify.sh
    required_for: [backend, frontend, infra, tools, doc]
    writes_to: []
specifications:
  current:
    include_in_context_pack: true
    modules: [backend, frontend]
    files: [doc/specification/mvp_specification_v2_0.md]
retention:
  completed_tasks:
    archive_after_days: 180
  run_summaries:
    archive_after_days: 30
  verification_evidence:
    archive_after_days: 30
  refactors:
    archive_after_days: 180
`, 'utf8');

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
source_refs:
  - doc/specification/mvp_specification_v2_0.md
depends_on: []
acceptance_criteria:
  - Backend behavior works
checks:
  - cd ppm-backend && ./gradlew test
retention: keep
---

# First ready task

Implement resource request API.
`,
    'utf8',
  );

  writeFileSync(
    resolve(tempDir, '.project-context/active/backlog/BACKLOG-BLOCKED.md'),
    `---
id: BACKLOG-BLOCKED
type: backlog
status: ready
priority: P1
agent_size: small
title: Blocked task
modules:
  - frontend
tags: []
depends_on:
  - BACKLOG-MISSING
acceptance_criteria: []
checks: []
retention: keep
---

# Blocked task
`,
    'utf8',
  );

  writeFileSync(
    resolve(tempDir, '.project-context/active/decisions/DECISION-20260514-998.md'),
    `---
id: DECISION-20260514-998
type: decision
status: active
title: Keep Project MCP records in Markdown
created_at: '2026-05-14T00:00:00+03:00'
modules:
  - doc
tags:
  - project-mcp
  - frontmatter
source_task: TASK-20260514-998
supersedes: []
superseded_by: null
retention: keep
---

# DECISION-20260514-998: Keep Project MCP records in Markdown

## Context

Project MCP answers must be traceable to reviewed records.

## Decision

Store project knowledge as Markdown with YAML frontmatter.
`,
    'utf8',
  );

  writeFileSync(
    resolve(tempDir, '.project-context/active/integrations/INTEGRATION-20260514-001.md'),
    `---
id: INTEGRATION-20260514-001
type: integration
status: active
title: SAP customer master integration
created_at: '2026-05-14T00:00:00+03:00'
modules:
  - backend
files: []
tags:
  - sap
  - customer
source_refs:
  - doc/specification/integrations.md
systems:
  - SAP
  - PPM
retention: normal
---

# INTEGRATION-20260514-001: SAP customer master integration

## Summary

PPM consumes customer master data from SAP.
`,
    'utf8',
  );

  writeFileSync(
    resolve(tempDir, '.project-context/active/data-entities/DATA-ENTITY-20260514-001.md'),
    `---
id: DATA-ENTITY-20260514-001
type: data_entity
status: active
title: Customer data entity
created_at: '2026-05-14T00:00:00+03:00'
modules:
  - backend
files: []
tags:
  - customer
source_refs:
  - doc/specification/data-model.md
entity_name: Customer
fields:
  - customerId
  - sapCode
retention: normal
---

# DATA-ENTITY-20260514-001: Customer data entity

## Summary

Customer records include customerId and sapCode fields.
`,
    'utf8',
  );

  writeFileSync(
    resolve(tempDir, '.project-context/drafts/decisions/DECISION-20260514-999.md'),
    `---
id: DECISION-20260514-999
type: decision
status: draft
title: Keep context drafts reviewable
modules:
  - doc
tags:
  - context-router
retention: keep
---

# DECISION-20260514-999: Keep context drafts reviewable

## Context

Drafts need human approval.

## Decision

Promote reviewed drafts explicitly.
`,
    'utf8',
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('high-priority context workflows', () => {
  it('searches Markdown project context with mandatory sources', () => {
    const result = searchProjectContext({
      query: 'SAP Customer',
      types: ['integration', 'data_entity'],
      limit: 5,
    });

    expect(result.records.map((record) => record.id)).toContain('INTEGRATION-20260514-001');
    expect(result.records.map((record) => record.id)).toContain('DATA-ENTITY-20260514-001');
    expect(result.sources).toContainEqual(expect.objectContaining({
      id: 'INTEGRATION-20260514-001',
      path: '.project-context/active/integrations/INTEGRATION-20260514-001.md',
      reason: 'Matched project context query and filters.',
    }));
    expect(result.records.every((record) => record.sources.length > 0)).toBe(true);
  });

  it('finds integration and data entity records from frontmatter fields', () => {
    const integrations = findIntegrations({ systems: ['SAP'] });
    const entities = findDataEntities({ fields: ['sapCode'] });

    expect(integrations.records[0]?.id).toBe('INTEGRATION-20260514-001');
    expect(integrations.sources[0]?.type).toBe('integration');
    expect(entities.records[0]?.id).toBe('DATA-ENTITY-20260514-001');
    expect(entities.sources[0]?.type).toBe('data_entity');
  });

  it('returns reviewed decisions with provenance by default', () => {
    const result = getDecisions({ query: 'Markdown frontmatter' });

    expect(result.records.map((record) => record.id)).toContain('DECISION-20260514-998');
    expect(result.records.map((record) => record.id)).not.toContain('DECISION-20260514-999');
    expect(result.sources[0]).toEqual(expect.objectContaining({
      id: 'DECISION-20260514-998',
      type: 'decision',
      status: 'active',
    }));
  });

  it('adds top-level sources to project context packs', () => {
    const result = buildProjectContextPack({ query: 'SAP customer integration', modules: ['backend'] });

    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources.every((source) => source.id && source.path && source.title)).toBe(true);
  });

  it('proposes context updates as draft Markdown with YAML frontmatter', () => {
    const result = proposeContextUpdate({
      type: 'integration',
      title: 'Kafka order status integration',
      summary: 'PPM publishes order status events to Kafka after review.',
      modules: ['backend'],
      tags: ['kafka', 'orders'],
      sourceRefs: ['meeting:2026-05-14'],
      frontmatter: {
        systems: ['PPM', 'Kafka'],
      },
    });

    expect(result.status).toBe('DRAFT_CREATED');
    expect(result.requiresHumanReview).toBe(true);
    expect(result.draftPath).toMatch(/^\.project-context\/drafts\/integrations\/INTEGRATION-\d{8}-\d{6}-\d{3}\.md$/);
    const content = readFileSync(resolve(tempDir, result.draftPath), 'utf8');
    expect(content).toContain('type: integration');
    expect(content).toContain('systems:');
    expect(content).toContain('## Source References');
    expect(result.sources[0]).toEqual(expect.objectContaining({
      id: result.record.id,
      path: result.draftPath,
      reason: 'Created reviewable Markdown draft with YAML frontmatter.',
    }));
    expect(lintContext(false).errors).toEqual([]);
  });

  it('imports curated RP database knowledge into draft analyst records', () => {
    mkdirSync(resolve(tempDir, 'RP/database/chunks'), { recursive: true });
    mkdirSync(resolve(tempDir, 'RP/RAW/transcripts/project_management'), { recursive: true });
    writeFileSync(resolve(tempDir, 'RP/RAW/transcripts/project_management/source.txt'), 'raw source placeholder', 'utf8');
    writeFileSync(
      resolve(tempDir, 'RP/database/00_source_register.md'),
      `# Реестр источников RAW

| ID | Файл RAW | Основное содержание | Статус обработки |
|---|---|---|---|
| \`SRC-48\` | \`RAW/transcripts/project_management/source.txt\` | Обсуждение ресурсного плана и бюджета. | Учтен в базе. |
`,
      'utf8',
    );
    writeFileSync(
      resolve(tempDir, 'RP/database/chunks/chunk_index.md'),
      `# Индекс смысловых чанков

| Chunk ID | Source ID | Источник | Дата | Тема | Область системы | Тип информации | Краткое содержание | Статус | Доменные файлы |
|---|---|---|---|---|---|---|---|---|---|
| \`CH-SRC-48-01\` | \`SRC-48\` | \`RAW/transcripts/project_management/source.txt\` | 30.06.2026 | Ресурсный план | Ресурсный план | Требование | Нужен черновик и версии ресурсного плана. | Учтено | \`05_resource_planning.md\` |
`,
      'utf8',
    );
    writeFileSync(resolve(tempDir, 'RP/database/chunks/SRC-48_chunks.md'), '# SRC-48 chunks\n', 'utf8');
    writeFileSync(
      resolve(tempDir, 'RP/database/13_requirement_traceability.md'),
      `# Сквозная трассировка

| Requirement ID | Требование / группа требований | Источники / чанки | Где раскрыто в базе и ТЗ | Связанные задачи | Критерии приемки |
|---|---|---|---|---|---|
| \`REQ-RPL-001\` | Ресурсный план имеет черновик и версии. | \`SRC-48\`, \`CH-SRC-48-01\` | \`database/05_resource_planning.md\` | \`TASK-022\` | \`AC-TASK-022\` |
`,
      'utf8',
    );
    writeFileSync(
      resolve(tempDir, 'RP/database/11_decisions_open_items_and_conflicts.md'),
      `# Решения, открытые вопросы и конфликты

## Зафиксированные решения

| Тема | Решение | Источники |
|---|---|---|
| Версионность ресурсного плана | Ресурсный план имеет черновик и версии. | \`SRC-48\` |

## Конфликты

### Версии бюджета

Нужно уточнить, как бюджет связывается с ресурсным планом. (\`SRC-48\`, \`CH-SRC-48-01\`)
`,
      'utf8',
    );

    const imported = importRpDatabase({ path: 'RP', apply: true });

    expect(imported.status).toBe('DRAFTS_CREATED');
    expect(imported.records.some((record) => record.type === 'source')).toBe(true);
    expect(imported.records.some((record) => record.type === 'source_chunk')).toBe(true);
    expect(imported.records.some((record) => record.type === 'requirement')).toBe(true);
    expect(imported.records.some((record) => record.type === 'acceptance_check')).toBe(true);
    expect(imported.records.some((record) => record.type === 'open_question')).toBe(true);
    expect(lintContext(false).errors).toEqual([]);

    const requirements = findRequirements({ requirementKeys: ['REQ-RPL-001'] });
    expect(requirements.records[0]?.title).toContain('REQ-RPL-001');
    expect(requirements.sources[0]?.path).toContain('.project-context/drafts/requirements/');

    const chunks = findSourceChunks({ chunkIds: ['CH-SRC-48-01'] });
    expect(chunks.records[0]?.title).toContain('CH-SRC-48-01');

    const trace = traceRequirement({ requirementKey: 'REQ-RPL-001' });
    expect(trace.traces[0]?.sources[0]?.title).toContain('SRC-48');
    expect(trace.traces[0]?.chunks[0]?.title).toContain('CH-SRC-48-01');
    expect(trace.traces[0]?.acceptanceChecks[0]?.title).toContain('AC-TASK-022');

    const conflicts = getConflicts({ query: 'бюджет' });
    expect(conflicts.records.some((record) => record.title.includes('Версии бюджета'))).toBe(true);

    const analystPack = buildAnalystContextPack({ query: 'ресурсный план' });
    expect(analystPack.requirements.length).toBeGreaterThan(0);
    expect(analystPack.sourceChunks.length).toBeGreaterThan(0);
    expect(analystPack.sources.length).toBeGreaterThan(0);

    const backlog = analystDeltaToBacklog({ query: 'ресурсный план', apply: false, limit: 1 });
    expect(backlog.status).toBe('DRY_RUN');
    expect(backlog.proposals[0]?.status).toBe('DRY_RUN');
  });

  it('previews analyst source drafts without writing by default', () => {
    const result = proposeAnalystSource({
      sourceId: 'SRC-NEW',
      title: 'New analyst transcript',
      summary: 'Transcript should be chunked before promotion.',
      sourceKind: 'transcript',
    });

    expect(result.status).toBe('DRY_RUN');
    expect(result.requiresHumanReview).toBe(true);
    expect(existsSync(resolve(tempDir, result.record.path))).toBe(false);
  });

  it('builds backlog dependency graph with missing blockers', () => {
    const graph = getBacklogDependencyGraph();

    expect(graph.ready).toContain('BACKLOG-FIRST');
    expect(graph.blocked).toContainEqual({ id: 'BACKLOG-BLOCKED', blockedBy: ['BACKLOG-MISSING'] });
    expect(graph.missingDependencies).toContainEqual({ id: 'BACKLOG-BLOCKED', missing: 'BACKLOG-MISSING' });
  });

  it('converts a backlog item into a confirmed task contract', () => {
    const result = taskFromBacklog({ backlogId: 'BACKLOG-FIRST', mode: 'confirm' });

    expect(result.status).toBe('CONFIRMED');
    expect(result.path).toMatch(/^\.project-context\/active\/tasks\/TASK-\d{8}-\d{6}-\d{3}\.md$/);
    const content = readFileSync(resolve(tempDir, result.path ?? ''), 'utf8');
    expect(content).toContain('Backend behavior works');
    expect(content).toContain('kind: backlog');
    expect(content).toContain('BACKLOG-FIRST');
  });

  it('builds verification plans from backlog checks and module defaults', () => {
    const plan = getVerificationPlan({ id: 'BACKLOG-FIRST' });

    expect(plan.required.map((check) => check.command)).toContain('cd ppm-backend && ./gradlew test');
    expect(plan.optional.map((check) => check.command)).toContain('scripts/verify.sh');
  });

  it('records and lists verification evidence', () => {
    const evidence = recordVerificationEvidence({
      targetId: 'BACKLOG-FIRST',
      targetType: 'backlog',
      summary: 'Backend tests passed for the backlog item.',
      checks: [{ command: 'cd ppm-backend && ./gradlew test', status: 'passed' }],
      changedFiles: ['ppm-backend/src/main/java/Example.java'],
      modules: ['backend'],
      recordedBy: 'vitest',
    });

    expect(evidence.id).toMatch(/^VERIFY-\d{8}-\d{6}-\d{3}$/);
    const listed = listVerificationEvidence({ targetId: 'BACKLOG-FIRST' });
    expect(listed.items).toHaveLength(1);
    expect(listed.items[0]?.checks[0]?.status).toBe('passed');
    expect(getVerificationPlan({ id: 'BACKLOG-FIRST' }).evidence[0]?.id).toBe(evidence.id);
  });

  it('extracts spec open points as dry-run backlog proposals', () => {
    writeFileSync(
      resolve(tempDir, 'doc/specification/open-points.md'),
      '# Spec\n\n- TODO: Add audit trail for approval decisions.\n',
      'utf8',
    );

    const result = specToBacklog({ paths: ['doc/specification/**/*.md'], limit: 5, apply: false });

    expect(result.status).toBe('DRY_RUN');
    expect(result.candidates.some((candidate) => candidate.title.includes('Add audit trail'))).toBe(true);
    expect(result.candidates[0]?.proposal.status).toBe('DRY_RUN');
  });

  it('adds excerpts to context packs', () => {
    const pack = buildContextPack({ query: 'resource request API backend' });

    expect(pack.records.some((record) => record.id === 'BACKLOG-FIRST' && record.excerpt?.includes('Implement resource request API'))).toBe(true);
  });

  it('reuses context pack cache and invalidates it when records change', () => {
    const first = buildContextPack({ query: 'resource request API backend', workflow: 'standard' });
    const second = buildContextPack({ query: 'resource request API backend', workflow: 'standard' });

    expect(first.cache?.status).toBe('miss');
    expect(second.cache?.status).toBe('hit');

    writeFileSync(
      resolve(tempDir, '.project-context/active/backlog/BACKLOG-FIRST.md'),
      readFileSync(resolve(tempDir, '.project-context/active/backlog/BACKLOG-FIRST.md'), 'utf8').replace(
        'Implement resource request API.',
        'Implement resource request API with audit fields.',
      ),
      'utf8',
    );

    const invalidated = buildContextPack({ query: 'resource request API backend', workflow: 'standard' });

    expect(invalidated.cache?.status).toBe('miss');
    expect(invalidated.records.some((record) => record.excerpt?.includes('audit fields'))).toBe(true);
  });

  it('reports when required playbook content exceeds the context-pack token budget', () => {
    mkdirSync(resolve(tempDir, 'playbooks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, 'playbooks/java-backend.md'),
      `---
kind: policy
modules: [backend]
routing: core
triggers: []
---
# Backend\n\n${'required backend guidance '.repeat(200)}\n`,
      'utf8',
    );
    rebuildIndex();

    const pack = buildContextPack({
      query: 'resource request API backend with implementation files and specification context',
      workflow: 'strict',
      maxTokens: 500,
      modules: ['backend'],
      files: Array.from({ length: 20 }, (_, index) => `ppm-backend/src/main/java/example/VeryLongExplicitImplementationFile${index}.java`),
    });

    expect(pack.budget.truncated).toBe(true);
    expect(pack.budget.exceedsLimit).toBe(true);
    expect(pack.budget.estimatedTokens).toBeGreaterThan(500);
    expect(pack.budget.playbookTokens).toBeGreaterThan(500);
    expect(pack.playbooks).toContain('playbooks/java-backend.md');
    expect(pack.playbookDetails).toContainEqual(expect.objectContaining({
      path: 'playbooks/java-backend.md',
      required: true,
    }));
    expect(pack.warnings.some((warning) => warning.includes('Required playbooks and payload exceed'))).toBe(true);
    expect(pack.commands).toContain('./scripts/backend-test-java21.sh');
  });

  it('routes conditional playbooks by task signals instead of loading every module playbook', () => {
    mkdirSync(resolve(tempDir, 'playbooks'), { recursive: true });
    const writePlaybook = (name: string, modules: string, routing: 'core' | 'conditional', triggers: string[]) => {
      writeFileSync(
        resolve(tempDir, `playbooks/${name}.md`),
        `---
kind: policy
modules: [${modules}]
routing: ${routing}
triggers: [${triggers.join(', ')}]
---
# ${name}\n`,
        'utf8',
      );
    };
    writePlaybook('java-backend', 'backend', 'core', []);
    writePlaybook('testing', 'backend', 'core', []);
    writePlaybook('backend-access-control', 'backend', 'conditional', ['access', 'доступ']);
    writePlaybook('liquibase-migrations', 'backend', 'conditional', ['liquibase', 'migration']);
    writePlaybook('keycloak-auth', 'backend, frontend, infra', 'conditional', ['keycloak', 'jwt']);
    writePlaybook('devops_svs', 'backend, frontend, infra', 'conditional', ['svs', 'helmwave']);
    writePlaybook('analyst-context', 'doc, tools', 'conditional', ['analyst', 'source chunk']);

    const regular = buildContextPack({ query: 'add backend endpoint', modules: ['backend'] });
    const database = buildContextPack({ query: 'add Liquibase migration', modules: ['backend'] });
    const auth = buildContextPack({ query: 'fix Keycloak JWT decoding', modules: ['backend'] });
    const svs = buildContextPack({ query: 'fix SVS GitLab Helmwave pipeline' });
    const analyst = buildContextPack({ query: 'import analyst requirements source chunks' });

    expect(regular.playbooks).toContain('playbooks/java-backend.md');
    expect(regular.playbooks).toContain('playbooks/testing.md');
    expect(regular.playbooks).not.toContain('playbooks/liquibase-migrations.md');
    expect(regular.playbooks).not.toContain('playbooks/backend-access-control.md');
    expect(database.summary).toContain('(backend)');
    expect(database.playbooks).toContain('playbooks/liquibase-migrations.md');
    expect(auth.playbooks).toContain('playbooks/keycloak-auth.md');
    expect(svs.summary).toContain('(infra)');
    expect(svs.playbooks).toContain('playbooks/devops_svs.md');
    expect(analyst.summary).toContain('(doc)');
    expect(analyst.playbooks).toContain('playbooks/analyst-context.md');
  });

  it('invalidates a cached context pack when selected playbook content changes', () => {
    mkdirSync(resolve(tempDir, 'playbooks'), { recursive: true });
    const path = resolve(tempDir, 'playbooks/java-backend.md');
    writeFileSync(path, `---
kind: policy
modules: [backend]
routing: core
triggers: []
---
# Backend v1\n`, 'utf8');

    const first = buildContextPack({ query: 'backend task', modules: ['backend'] });
    const second = buildContextPack({ query: 'backend task', modules: ['backend'] });
    writeFileSync(path, readFileSync(path, 'utf8').replace('Backend v1', 'Backend v2'), 'utf8');
    const invalidated = buildContextPack({ query: 'backend task', modules: ['backend'] });

    expect(first.cache?.status).toBe('miss');
    expect(second.cache?.status).toBe('hit');
    expect(invalidated.cache?.status).toBe('miss');
  });

  it('prioritizes changed files and omits product specification from tools work', () => {
    const pack = buildContextPack({
      query: 'improve context router cache behavior',
      modules: ['tools', 'doc'],
      changedFiles: ['tools/ppm-context/src/context-pack/pack.ts'],
      workflow: 'strict',
    });

    expect(pack.files[0]).toEqual(expect.objectContaining({
      path: 'tools/ppm-context/src/context-pack/pack.ts',
      reason: 'Changed file.',
    }));
    expect(pack.files.some((file) => file.path.startsWith('doc/specification/'))).toBe(false);
  });

  it('ranks domain export code above generic backend classes', () => {
    mkdirSync(resolve(tempDir, 'ppm-backend/src/main/java/example/exports'), { recursive: true });
    mkdirSync(resolve(tempDir, 'ppm-backend/src/main/java/example/config'), { recursive: true });
    writeFileSync(
      resolve(tempDir, 'ppm-backend/src/main/java/example/exports/BudgetExportSheetBuilder.java'),
      'package example.exports; public class BudgetExportSheetBuilder {}\n',
      'utf8',
    );
    writeFileSync(
      resolve(tempDir, 'ppm-backend/src/main/java/example/exports/XlsxExportWorkbookRenderer.java'),
      'package example.exports; public class XlsxExportWorkbookRenderer {}\n',
      'utf8',
    );
    writeFileSync(
      resolve(tempDir, 'ppm-backend/src/main/java/example/config/PpmBackendApplication.java'),
      'package example.config; public class PpmBackendApplication {}\n',
      'utf8',
    );
    rebuildIndex();

    const pack = buildContextPack({
      query: 'backend Excel выгрузка бюджета помесячные суммы и стили ячеек',
      modules: ['backend'],
    });

    expect(pack.files[0]?.path).toContain('/exports/');
    expect(pack.files.slice(0, 2).map((file) => file.path)).not.toContain('ppm-backend/src/main/java/example/config/PpmBackendApplication.java');
  });

  it('compacts context packs only for fast workflow', () => {
    const fastPack = buildContextPack({ query: 'resource request API backend', workflow: 'fast' });
    const strictPack = buildContextPack({ query: 'resource request API backend', workflow: 'strict' });

    expect(strictPack.profile).toBe('default');
    expect(strictPack.maxTokens).toBe(16_000);
    expect(fastPack.workflow).toBe('fast');
    expect(strictPack.workflow).toBe('strict');
    expect(fastPack.files.length).toBeLessThan(strictPack.files.length);
    expect(fastPack.files.some((file) => file.path === 'doc/specification/mvp_specification_v2_0.md')).toBe(false);
    expect(strictPack.files.some((file) => file.path === 'doc/specification/mvp_specification_v2_0.md')).toBe(true);
    expect(fastPack.playbooks).toContain('playbooks/java-backend.md');
    expect(fastPack.commands).toContain('./scripts/backend-test-java21.sh');
  });

  it('keeps standard workflow as the default context-pack profile behavior', () => {
    const pack = buildContextPack({ query: 'resource request API backend' });

    expect(pack.profile).toBe('default');
    expect(pack.workflow).toBe('standard');
    expect(pack.maxTokens).toBe(10_000);
    expect(pack.files.some((file) => file.path === 'doc/specification/mvp_specification_v2_0.md')).toBe(true);
  });

  it('uses compact fast defaults for local-model context packs', () => {
    const defaultPack = buildContextPack({ query: 'local model frontend docs context' });
    const localModelPack = buildContextPack({ query: 'local model frontend docs context', profile: 'local-model' });

    expect(localModelPack.profile).toBe('local-model');
    expect(localModelPack.workflow).toBe('fast');
    expect(localModelPack.maxTokens).toBe(4000);
    expect(localModelPack.records.length).toBeLessThanOrEqual(5);
    expect(localModelPack.files.length).toBeLessThan(defaultPack.files.length);
  });

  it('lets explicit workflow and maxTokens override local-model defaults', () => {
    const pack = buildContextPack({
      query: 'local model backend override context',
      modules: ['backend'],
      profile: 'local-model',
      workflow: 'standard',
      maxTokens: 9000,
    });

    expect(pack.profile).toBe('local-model');
    expect(pack.workflow).toBe('standard');
    expect(pack.maxTokens).toBe(9000);
    expect(pack.files.some((file) => file.path === 'doc/specification/mvp_specification_v2_0.md')).toBe(true);
  });

  it('does not reuse a default cache entry for local-model profile packs', () => {
    const query = 'cache profile local model separation';

    const defaultPack = buildContextPack({ query });
    const localModelPack = buildContextPack({ query, profile: 'local-model' });

    expect(defaultPack.profile).toBe('default');
    expect(defaultPack.workflow).toBe('standard');
    expect(defaultPack.cache?.status).toBe('miss');
    expect(localModelPack.profile).toBe('local-model');
    expect(localModelPack.workflow).toBe('fast');
    expect(localModelPack.cache?.status).toBe('miss');
  });

  it('uses explicit task modules when selecting playbooks', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-999.md'),
      `---
id: TASK-20260514-999
type: task
status: in_progress
title: Documentation cleanup
created_at: '2026-05-14T00:00:00+03:00'
updated_at: '2026-05-14T00:00:00+03:00'
confirmed_by_human: true
modules:
  - doc
files: []
tags:
  - context-router
retention: normal
---

# Documentation cleanup
`,
      'utf8',
    );

    const pack = buildContextPack({ query: 'cleanup playbooks', taskId: 'TASK-20260514-999' });

    expect(pack.playbooks).toContain('tools/ppm-context/README.md');
    expect(pack.playbooks).toContain('.project-context/README.md');
    expect(pack.playbooks).not.toContain(['doc', `context-router${'.md'}`].join('/'));
    expect(pack.playbooks).not.toContain(['doc', `codex-context-workflow${'.md'}`].join('/'));
  });

  it('uses explicit file hints when selecting context-pack modules', () => {
    const pack = buildContextPack({
      query: 'update generated snapshot',
      changedFiles: ['tools/ppm-context/src/project-snapshot/snapshot.ts'],
    });

    expect(pack.summary).toContain('tools');
    expect(pack.playbooks).toContain('tools/ppm-context/README.md');
    expect(pack.playbooks).toContain('.project-context/README.md');
    expect(pack.commands).toContain('npm --prefix tools/ppm-context run test');
  });

  it('uses explicit modules even when source files are doc task notes', () => {
    mkdirSync(resolve(tempDir, 'doc/tasks'), { recursive: true });
    writeFileSync(resolve(tempDir, 'doc/tasks/correction.md'), '# Correction\n\nReserve cancel behavior.\n', 'utf8');

    const pack = buildContextPack({
      query: 'резерв возвращается к 10 процентам при отмене',
      modules: ['frontend'],
      files: ['doc/tasks/correction.md'],
    });

    expect(pack.summary).toContain('(frontend, doc)');
    expect(pack.playbooks).toContain('ppm-frontend/AGENTS.md');
    expect(pack.commands).toContain('cd ppm-frontend && npm run build');
    expect(pack.commands).toContain('cd ppm-frontend && npm run test');
  });

  it('does not reuse a doc-only cache entry when explicit modules change', () => {
    mkdirSync(resolve(tempDir, 'doc/tasks'), { recursive: true });
    writeFileSync(resolve(tempDir, 'doc/tasks/correction.md'), '# Correction\n\nReserve cancel behavior.\n', 'utf8');
    const input = {
      query: 'резерв возвращается к 10 процентам при отмене',
      files: ['doc/tasks/correction.md'],
    };

    const docPack = buildContextPack(input);
    const frontendPack = buildContextPack({ ...input, modules: ['frontend'] });

    expect(docPack.summary).toContain('(doc)');
    expect(docPack.cache?.status).toBe('miss');
    expect(frontendPack.summary).toContain('(frontend, doc)');
    expect(frontendPack.cache?.status).toBe('miss');
    expect(frontendPack.playbooks).toContain('ppm-frontend/AGENTS.md');
  });

  it('keeps doc-only context packs doc scoped when no frontend signal exists', () => {
    mkdirSync(resolve(tempDir, 'doc/tasks'), { recursive: true });
    writeFileSync(resolve(tempDir, 'doc/tasks/documentation-note.md'), '# Documentation\n\nUpdate task note.\n', 'utf8');

    const pack = buildContextPack({
      query: 'документационная правка backlog note',
      files: ['doc/tasks/documentation-note.md'],
    });

    expect(pack.summary).toContain('(doc)');
    expect(pack.playbooks).toContain('tools/ppm-context/README.md');
    expect(pack.playbooks).toContain('.project-context/README.md');
    expect(pack.playbooks).not.toContain('ppm-frontend/AGENTS.md');
    expect(pack.commands).not.toContain('cd ppm-frontend && npm run build');
  });

  it('returns dry-run doctor fix proposals without mutating files', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-997.md'),
      `---
id: TASK-20260514-997
type: task
status: confirmed
title: Active duplicate
confirmed_by_human: true
modules: []
files: []
tags: []
retention: normal
---

# Active duplicate
`,
      'utf8',
    );
    mkdirSync(resolve(tempDir, '.project-context/drafts/tasks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/drafts/tasks/TASK-20260514-997.md'),
      `---
id: TASK-20260514-997
type: task
status: validating
title: Draft duplicate
confirmed_by_human: false
modules: []
files: []
tags: []
retention: normal
---

# Draft duplicate
`,
      'utf8',
    );

    const result = contextDoctor({ fixDryRun: true });

    expect(result.fixes?.some((fix) => fix.id === 'duplicate-id-TASK-20260514-997')).toBe(true);
    expect(result.fixes?.some((fix) => fix.id === 'install-git-hooks')).toBe(true);
    expect(existsSync(resolve(tempDir, '.project-context/drafts/tasks/TASK-20260514-997.md'))).toBe(true);
  });

  it('fails lint when frontmatter files points at a directory', () => {
    mkdirSync(resolve(tempDir, 'doc/context-directory'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-996.md'),
      `---
id: TASK-20260514-996
type: task
status: confirmed
title: Directory file reference
confirmed_by_human: true
modules:
  - doc
files:
  - doc/context-directory
tags: []
retention: normal
---

# Directory file reference
`,
      'utf8',
    );

    const result = lintContext(false);

    expect(result.errors).toContain(
      '.project-context/active/tasks/TASK-20260514-996.md: referenced file is a directory, expected concrete file: doc/context-directory',
    );
  });

  it('reports directory file references during indexing without throwing', () => {
    mkdirSync(resolve(tempDir, 'doc/context-directory'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-995.md'),
      `---
id: TASK-20260514-995
type: task
status: confirmed
title: Directory file reference
confirmed_by_human: true
modules:
  - doc
files:
  - doc/context-directory
tags: []
retention: normal
---

# Directory file reference
`,
      'utf8',
    );

    const result = rebuildIndex();

    expect(result.fileReferenceIssues).toContainEqual({
      recordId: 'TASK-20260514-995',
      recordPath: '.project-context/active/tasks/TASK-20260514-995.md',
      filePath: 'doc/context-directory',
      kind: 'directory',
    });
  });

  it('reports duplicate context ids during indexing without throwing', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-991.md'),
      `---
id: TASK-20260514-991
type: task
status: confirmed
title: Active duplicate
confirmed_by_human: true
modules: []
files: []
tags: []
retention: normal
---

# Active duplicate
`,
      'utf8',
    );
    mkdirSync(resolve(tempDir, '.project-context/drafts/tasks'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/drafts/tasks/TASK-20260514-991.md'),
      `---
id: TASK-20260514-991
type: task
status: validating
title: Draft duplicate
confirmed_by_human: false
modules: []
files: []
tags: []
retention: normal
---

# Draft duplicate
`,
      'utf8',
    );

    const result = rebuildIndex();

    expect(result.duplicateRecordIssues).toContainEqual({
      recordId: 'TASK-20260514-991',
      paths: [
        '.project-context/active/tasks/TASK-20260514-991.md',
        '.project-context/drafts/tasks/TASK-20260514-991.md',
      ],
    });
  });

  it('distinguishes stale index and directory-reference health in doctor diagnostics', () => {
    rebuildIndex();
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-994.md'),
      `---
id: TASK-20260514-994
type: task
status: confirmed
title: New stale-index task
confirmed_by_human: true
modules:
  - doc
files: []
tags: []
retention: normal
---

# New stale-index task
`,
      'utf8',
    );
    mkdirSync(resolve(tempDir, 'doc/context-directory'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-993.md'),
      `---
id: TASK-20260514-993
type: task
status: confirmed
title: Directory file reference
confirmed_by_human: true
modules:
  - doc
files:
  - doc/context-directory
tags: []
retention: normal
---

# Directory file reference
`,
      'utf8',
    );

    const result = contextDoctor();

    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      id: 'context-index',
      status: 'warn',
      message: 'Context SQLite index is stale; run tools/ppm-context/bin/ppm-context index.',
    }));
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      id: 'context-file-references',
      status: 'fail',
      message: '1 directory file reference(s) found in context records.',
    }));
  });

  it('keeps search healthy after indexing valid records', () => {
    writeFileSync(
      resolve(tempDir, '.project-context/active/tasks/TASK-20260514-992.md'),
      `---
id: TASK-20260514-992
type: task
status: confirmed
title: Frontend search probe
confirmed_by_human: true
modules:
  - frontend
files: []
tags:
  - frontend
retention: normal
---

# Frontend search probe

Search should find this frontend context record after indexing.
`,
      'utf8',
    );

    const indexed = rebuildIndex();
    const records = searchIndex('frontend search probe');

    expect(indexed.records).toBeGreaterThan(0);
    expect(checkIndexFresh()).toBe(true);
    expect(records.map((record) => record.id)).toContain('TASK-20260514-992');
  });

  it('marks the index stale when record content changes without changing record count', () => {
    rebuildIndex();
    const path = resolve(tempDir, '.project-context/active/backlog/BACKLOG-FIRST.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('Implement resource request API.', 'Implement resource request API with an audit trail.'), 'utf8');

    expect(checkIndexFresh()).toBe(false);
  });

  it('marks the index stale when indexed source content changes', () => {
    const path = resolve(tempDir, 'tools/ppm-context/src/example.ts');
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(path, 'export function firstCapability() { return 1; }\n', 'utf8');
    rebuildIndex();
    expect(checkIndexFresh()).toBe(true);

    writeFileSync(path, 'export function secondCapability() { return 2; }\n', 'utf8');

    expect(checkIndexFresh()).toBe(false);
  });

  it('builds a live project snapshot', () => {
    const snapshot = getProjectSnapshot({ includeDirty: false, includeBacklog: true });

    expect(snapshot.project.name).toBe('PPM');
    expect(snapshot.contextRouter.commands).toContain('tools/ppm-context/bin/ppm-context doctor');
    expect(snapshot.flows.some((flow) => flow.includes('finalize'))).toBe(true);
  });

  it('promotes reviewed drafts into active context with approval metadata', () => {
    const dryRun = promoteDraft({ recordId: 'DECISION-20260514-999', apply: false });
    expect(dryRun.status).toBe('DRY_RUN');

    const result = promoteDraft({ recordId: 'DECISION-20260514-999', apply: true, approvedBy: 'vitest' });
    expect(result.status).toBe('PROMOTED');
    expect(result.targetPath).toBe('.project-context/active/decisions/DECISION-20260514-999.md');
    expect(existsSync(resolve(tempDir, result.targetPath))).toBe(true);
    expect(readFileSync(resolve(tempDir, result.targetPath), 'utf8')).toContain('approved_by: vitest');
  });

  it('batch promotes selected analyst drafts only after approval', () => {
    mkdirSync(resolve(tempDir, '.project-context/drafts/sources'), { recursive: true });
    mkdirSync(resolve(tempDir, '.project-context/drafts/requirements'), { recursive: true });
    writeFileSync(
      resolve(tempDir, '.project-context/drafts/sources/SOURCE-BATCH-001.md'),
      `---
id: SOURCE-BATCH-001
type: source
status: draft
title: Batch source
modules:
  - doc
files: []
tags:
  - rp
source_id: SRC-BATCH-001
source_kind: document
retention: keep
---

# Batch source
`,
      'utf8',
    );
    writeFileSync(
      resolve(tempDir, '.project-context/drafts/requirements/REQUIREMENT-BATCH-001.md'),
      `---
id: REQUIREMENT-BATCH-001
type: requirement
status: draft
title: Batch requirement
modules:
  - doc
files: []
tags:
  - rp
requirement_key: REQ-BATCH-001
retention: normal
---

# Batch requirement
`,
      'utf8',
    );

    const dryRun = promoteDraftsBatch({
      types: ['source', 'requirement'],
      tags: ['rp'],
      apply: false,
    });
    expect(dryRun.status).toBe('DRY_RUN');
    expect(dryRun.totalMatched).toBe(2);
    expect(existsSync(resolve(tempDir, '.project-context/drafts/sources/SOURCE-BATCH-001.md'))).toBe(true);

    expect(() => promoteDraftsBatch({
      types: ['source'],
      tags: ['rp'],
      apply: true,
    })).toThrow(/--approved-by/);

    const promoted = promoteDraftsBatch({
      types: ['source', 'requirement'],
      tags: ['rp'],
      apply: true,
      approvedBy: 'vitest',
    });
    expect(promoted.status).toBe('PROMOTED');
    expect(promoted.count).toBe(2);
    expect(readFileSync(resolve(tempDir, '.project-context/active/sources/SOURCE-BATCH-001.md'), 'utf8')).toContain('status: active');
    expect(readFileSync(resolve(tempDir, '.project-context/active/requirements/REQUIREMENT-BATCH-001.md'), 'utf8')).toContain('status: proposed');
    expect(existsSync(resolve(tempDir, '.project-context/drafts/sources/SOURCE-BATCH-001.md'))).toBe(false);
  });

  it('refuses broad batch promotion without an explicit selector', () => {
    expect(() => promoteDraftsBatch({ apply: false })).toThrow(/Refusing broad batch promotion/);
  });

  it('audits and applies current-truth cleanup without touching analyst workbench records', () => {
    mkdirSync(resolve(tempDir, '.project-context/active/run-summaries'), { recursive: true });
    mkdirSync(resolve(tempDir, '.project-context/active/verification'), { recursive: true });
    mkdirSync(resolve(tempDir, '.project-context/active/requirements'), { recursive: true });
    writeContextRecord('.project-context/active/tasks/TASK-DONE-OLD.md', {
      id: 'TASK-DONE-OLD',
      type: 'task',
      status: 'done',
      title: 'Old completed task',
      updated_at: '2020-01-01T00:00:00+03:00',
      modules: ['doc'],
    });
    writeContextRecord('.project-context/active/tasks/TASK-STILL-ACTIVE.md', {
      id: 'TASK-STILL-ACTIVE',
      type: 'task',
      status: 'in_progress',
      title: 'Old in progress task',
      updated_at: '2020-01-01T00:00:00+03:00',
      modules: ['doc'],
    });
    writeContextRecord('.project-context/active/run-summaries/RUN-OLD-001.md', {
      id: 'RUN-OLD-001',
      type: 'run-summary',
      status: 'reviewed',
      title: 'Old reviewed run summary',
      updated_at: '2020-01-01T00:00:00+03:00',
      tags: ['run-summary'],
    });
    writeContextRecord('.project-context/active/verification/VERIFY-OLD-001.md', {
      id: 'VERIFY-OLD-001',
      type: 'verification-evidence',
      status: 'passed',
      title: 'Old passed verification',
      updated_at: '2020-01-01T00:00:00+03:00',
      modules: ['doc'],
    });
    writeContextRecord('.project-context/active/requirements/REQUIREMENT-STAYS-001.md', {
      id: 'REQUIREMENT-STAYS-001',
      type: 'requirement',
      status: 'proposed',
      title: 'Analyst requirement stays active',
      updated_at: '2020-01-01T00:00:00+03:00',
      tags: ['rp'],
    });

    const dryRun = currentTruthAudit({ doneTaskDays: 30, historyDays: 30, staleWorkDays: 14, limit: 20 });

    expect(dryRun.status).toBe('DRY_RUN');
    expect(dryRun.safeArchiveCandidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      'TASK-DONE-OLD',
      'RUN-OLD-001',
      'VERIFY-OLD-001',
    ]));
    expect(dryRun.safeArchiveCandidates.map((candidate) => candidate.id)).not.toContain('REQUIREMENT-STAYS-001');
    expect(dryRun.attentionCandidates.map((candidate) => candidate.id)).toContain('TASK-STILL-ACTIVE');
    expect(dryRun.summary.attentionArchiveCandidates).toBe(0);
    expect(() => currentTruthAudit({ apply: true })).toThrow(/--approved-by/);
    expect(() => currentTruthAudit({ archiveAttention: true })).toThrow(/--archive-attention requires an explicit selector/);

    const selectedAttentionDryRun = currentTruthAudit({
      archiveAttention: true,
      attentionStatuses: ['in_progress'],
      attentionMinAgeDays: 30,
      doneTaskDays: 30,
      historyDays: 30,
      staleWorkDays: 14,
      limit: 20,
    });
    expect(selectedAttentionDryRun.status).toBe('DRY_RUN');
    expect(selectedAttentionDryRun.selectedAttentionArchiveCandidates.map((candidate) => candidate.id)).toEqual(['TASK-STILL-ACTIVE']);

    const applied = currentTruthAudit({ apply: true, approvedBy: 'vitest', doneTaskDays: 30, historyDays: 30, staleWorkDays: 14, limit: 20 });

    expect(applied.status).toBe('APPLIED');
    expect(applied.summary.archived).toBe(3);
    expect(applied.summary.attentionArchived).toBe(0);
    expect(existsSync(resolve(tempDir, '.project-context/active/tasks/TASK-DONE-OLD.md'))).toBe(false);
    expect(existsSync(resolve(tempDir, '.project-context/active/tasks/TASK-STILL-ACTIVE.md'))).toBe(true);
    expect(existsSync(resolve(tempDir, '.project-context/active/requirements/REQUIREMENT-STAYS-001.md'))).toBe(true);
    expect(existsSync(resolve(tempDir, '.project-context/archive/2026/tasks/TASK-DONE-OLD.md'))).toBe(true);

    const attentionApplied = currentTruthAudit({
      apply: true,
      approvedBy: 'vitest',
      archiveAttention: true,
      attentionStatuses: ['in_progress'],
      attentionMinAgeDays: 30,
      doneTaskDays: 30,
      historyDays: 30,
      staleWorkDays: 14,
      limit: 20,
    });

    expect(attentionApplied.status).toBe('APPLIED');
    expect(attentionApplied.summary.attentionArchived).toBe(1);
    expect(existsSync(resolve(tempDir, '.project-context/active/tasks/TASK-STILL-ACTIVE.md'))).toBe(false);
    expect(existsSync(resolve(tempDir, '.project-context/archive/2026/tasks/TASK-STILL-ACTIVE.md'))).toBe(true);
    expect(existsSync(resolve(tempDir, '.project-context/active/requirements/REQUIREMENT-STAYS-001.md'))).toBe(true);
  });

  it('keeps workflow history out of default context packs unless requested', () => {
    mkdirSync(resolve(tempDir, '.project-context/active/run-summaries'), { recursive: true });
    writeContextRecord('.project-context/active/decisions/DECISION-CURRENT-TRUTH.md', {
      id: 'DECISION-CURRENT-TRUTH',
      type: 'decision',
      status: 'active',
      title: 'Current truth token decision',
      source_task: 'TASK-DECISION-CURRENT-TRUTH',
      tags: ['context-router'],
    });
    writeContextRecord('.project-context/active/run-summaries/RUN-CURRENT-TRUTH.md', {
      id: 'RUN-CURRENT-TRUTH',
      type: 'run-summary',
      status: 'reviewed',
      title: 'Current truth token run history',
      tags: ['run-summary'],
    });
    rebuildIndex();

    const defaultPack = buildContextPack({
      query: 'current truth token',
      workflow: 'standard',
      modules: ['doc'],
    });
    const historyPack = buildContextPack({
      query: 'current truth token',
      workflow: 'standard',
      modules: ['doc'],
      includeHistory: true,
    });

    expect(defaultPack.records.map((record) => record.id)).toContain('DECISION-CURRENT-TRUTH');
    expect(defaultPack.records.map((record) => record.id)).not.toContain('RUN-CURRENT-TRUTH');
    expect(historyPack.records.map((record) => record.id)).toContain('RUN-CURRENT-TRUTH');
  });
});

function writeContextRecord(relativePath: string, frontmatter: Record<string, unknown>): void {
  const yaml = Object.entries({
    created_at: '2020-01-01T00:00:00+03:00',
    retention: 'normal',
    files: [],
    ...frontmatter,
  }).map(([key, value]) => `${key}: ${formatYamlValue(value)}`).join('\n');
  writeFileSync(
    resolve(tempDir, relativePath),
    `---\n${yaml}\n---\n\n# ${frontmatter.title ?? frontmatter.id}\n\nTest context record.\n`,
    'utf8',
  );
}

function formatYamlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `\n${value.map((item) => `  - ${formatYamlValue(item)}`).join('\n')}`;
  }
  if (value === null) return 'null';
  return `'${String(value).replace(/'/g, "''")}'`;
}
