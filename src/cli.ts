import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import {
  confirmBacklogItem,
  confirmBacklogItemInputSchema,
  getBacklog,
  getBacklogDependencyGraph,
  pickNextBacklogTask,
  proposeBacklogItem,
  proposeBacklogItemInputSchema,
  taskFromBacklog,
  taskFromBacklogInputSchema,
  transitionBacklogItem,
  transitionBacklogItemInputSchema,
} from './backlog/backlog.js';
import { contextDoctor } from './doctor/doctor.js';
import { currentTruthAudit, currentTruthInputSchema } from './current-truth/current-truth.js';
import { archiveStale, applyCleanup, compactCleanupResult, proposeCleanup, restore } from './gc/gc.js';
import { rebuildIndex, checkIndexHealth, searchIndex } from './indexer/sqlite.js';
import { promoteDraft, promoteDraftInputSchema, promoteDraftsBatch, promoteDraftsBatchInputSchema } from './promotion/promote.js';
import { reviewDiffForRefactor } from './refactor-review/refactor.js';
import { findExistingCapabilities, findExistingCapability } from './reuse-scan/reuse.js';
import { initializeProjectContext, parseModuleSeed } from './scaffold/init.js';
import { loadProjectConfig } from './storage/config.js';
import { classifyFileReference } from './storage/file-references.js';
import { lintContext } from './storage/lint.js';
import { specToBacklog, specToBacklogInputSchema } from './spec-intake/spec-to-backlog.js';
import {
  confirmTaskContract,
  confirmTaskInputSchema,
  finalizeWork,
  finalizeWorkInputSchema,
  recordDecision,
  decisionInputSchema,
  startWork,
  validateTask,
} from './task-validation/task.js';
import { buildContextPack } from './context-pack/pack.js';
import { getProjectSnapshot } from './project-snapshot/snapshot.js';
import { changedFilesInCommit, isIndexRelevantPath } from './indexer/changed.js';
import {
  analystDeltaToBacklog,
  analystDeltaToBacklogInputSchema,
  buildAnalystContextPack,
  buildAnalystContextPackInputSchema,
  findRequirements,
  findRequirementsInputSchema,
  findSourceChunks,
  findSourceChunksInputSchema,
  getConflicts,
  getOpenQuestions,
  getOpenQuestionsInputSchema,
  traceRequirement,
  traceRequirementInputSchema,
} from './project-context/analytics.js';
import {
  defaultRpArchivePath,
  importRpDatabase,
  importRpDatabaseInputSchema,
  proposeAnalystSource,
  proposeAnalystSourceInputSchema,
} from './project-context/rp-import.js';
import {
  buildProjectContextPack,
  buildProjectContextPackInputSchema,
  findDataEntities,
  findDataEntitiesInputSchema,
  findIntegrations,
  findIntegrationsInputSchema,
  getDecisions,
  getDecisionsInputSchema,
  proposeContextUpdate,
  proposeContextUpdateInputSchema,
  searchProjectContext,
  searchProjectContextInputSchema,
} from './project-context/project-context.js';
import {
  getVerificationPlan,
  listVerificationEvidence,
  listVerificationEvidenceInputSchema,
  recordVerificationEvidence,
  verificationEvidenceInputSchema,
  verificationPlanInputSchema,
} from './verification/verification.js';
import {
  authenticateConfluence,
  bindConfluenceRoot,
  confluenceDoctor,
  setupConfluence,
} from './confluence/setup.js';
import {
  authenticatePortal,
  portalDoctor,
  setupPortal,
} from './portal/setup.js';
import {
  getAssignedPortalWork,
  portalSyncStatus,
  syncPortalSnapshot,
} from './portal/bridge.js';

const program = new Command();
const startupConfig = loadProjectConfig();
const cliProjectName = startupConfig.project.name;
const cliName = startupConfig.contextRouter.cliCommand.split(/\s+/).at(-1)?.split(/[\\/]/).at(-1) || 'project-context';
const jsonRequested = process.argv.includes('--json');
if (jsonRequested) {
  process.argv = process.argv.filter((argument, index) => index < 2 || argument !== '--json');
}

program
  .name(cliName)
  .description(`Local project context router for ${cliProjectName}`)
  .option('--json', 'emit JSON output');

program
  .command('init')
  .description('Create a generic project-context scaffold without overwriting existing configuration')
  .option('--name <name>', 'project name; defaults to the repository directory name')
  .option('--module <name:path>', 'seed a project module; repeat for multiple modules', collectValues, [])
  .action((options) => emit(initializeProjectContext({
    name: options.name,
    modules: (options.module as string[]).map(parseModuleSeed),
  })));

program
  .command('lint')
  .description('Validate context records')
  .option('--staged', 'validate staged context records only')
  .action((options) => {
    const result = lintContext(Boolean(options.staged));
    emit({ status: result.errors.length > 0 ? 'FAILED' : 'OK', ...result }, result.errors.length > 0 ? 1 : 0);
  });

program
  .command('index')
  .description('Rebuild or check the disposable SQLite context index')
  .option('--check', 'check index freshness without rebuilding')
  .option('--changed', 'rebuild only when HEAD changes indexed inputs')
  .action((options) => {
    if (options.check) {
      const health = checkIndexHealth();
      if (hasIndexDiagnostics(health)) {
        emit({ status: 'WARN', ...health });
        return;
      }
      if (health.fresh) {
        emit({ status: 'OK', fresh: health.fresh });
        return;
      }
      const rebuilt = rebuildIndex();
      emit({ status: hasIndexDiagnostics(rebuilt) ? 'WARN' : 'OK', fresh: false, rebuilt });
      return;
    }
    if (options.changed) {
      const changedFiles = changedFilesInCommit();
      const relevantFiles = changedFiles.filter(isIndexRelevantPath);
      if (relevantFiles.length === 0) {
        emit({
          status: 'OK',
          skipped: true,
          reason: 'HEAD does not change indexed context or capability sources.',
          changedFiles,
        });
        return;
      }
      const result = rebuildIndex();
      emit({ status: hasIndexDiagnostics(result) ? 'WARN' : 'OK', skipped: false, relevantFiles, ...result });
      return;
    }
    const result = rebuildIndex();
    emit({ status: hasIndexDiagnostics(result) ? 'WARN' : 'OK', ...result });
  });

program
  .command('search')
  .argument('<query>')
  .description('Search active project context records')
  .option('--include-archive', 'include archived records')
  .option('--limit <number>', 'maximum result count', '10')
  .action((query, options) => {
    const records = searchIndex(query, Number(options.limit), Boolean(options.includeArchive)).map((record) => ({
      id: record.id,
      type: record.type,
      status: record.status,
      title: record.title,
      path: record.path,
    }));
    emit({ records });
  });

program
  .command('pack')
  .argument('<query>')
  .description('Build a compact context pack for a task')
  .option('--task <taskId>')
  .option('--profile <profile>', 'default|local-model')
  .option('--workflow <level>', 'fast|standard|strict')
  .option('--max-tokens <number>', 'token budget hint')
  .option('--include-archive')
  .option('--include-history', 'include workflow-history records such as done tasks, run summaries, verification, and refactors')
  .option('--explain')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--file <path>', 'explicit file path hint; can be repeated', collectValues, [])
  .option('--changed-file <path>', 'changed file path hint; can be repeated', collectValues, [])
  .action((query, options) => {
    const modules = options.modules ? String(options.modules).split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    emit(
      buildContextPack({
        query,
        taskId: options.task,
        profile: parseProfile(options.profile),
        workflow: parseWorkflow(options.workflow),
        maxTokens: options.maxTokens === undefined ? undefined : Number(options.maxTokens),
        includeArchive: Boolean(options.includeArchive),
        includeHistory: Boolean(options.includeHistory),
        explain: Boolean(options.explain),
        modules,
        files: options.file,
        changedFiles: options.changedFile,
      }),
    );
  });

program
  .command('search-project-context')
  .argument('[query]', 'query text', '')
  .description('Search Markdown project context records with mandatory sources')
  .option('--types <types>', 'comma-separated record types')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--tags <tags>', 'comma-separated tags')
  .option('--include-drafts')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '10')
  .action((query, options) => emit(searchProjectContext(searchProjectContextInputSchema.parse({
    query,
    types: splitCsv(options.types),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    tags: splitCsv(options.tags),
    includeDrafts: Boolean(options.includeDrafts),
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('find-integrations')
  .argument('[query]', 'query text')
  .description('Find integration records with mandatory sources')
  .option('--systems <systems>', 'comma-separated systems')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--include-drafts')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '10')
  .action((query, options) => emit(findIntegrations(findIntegrationsInputSchema.parse({
    query,
    systems: splitCsv(options.systems),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: Boolean(options.includeDrafts),
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('find-data-entities')
  .argument('[query]', 'query text')
  .description('Find data entity records with mandatory sources')
  .option('--entity-names <names>', 'comma-separated entity names')
  .option('--fields <fields>', 'comma-separated fields')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--include-drafts')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '10')
  .action((query, options) => emit(findDataEntities(findDataEntitiesInputSchema.parse({
    query,
    entityNames: splitCsv(options.entityNames),
    fields: splitCsv(options.fields),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: Boolean(options.includeDrafts),
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('get-decisions')
  .argument('[query]', 'query text')
  .description('Return decision records with mandatory sources')
  .option('--statuses <statuses>', 'comma-separated statuses', 'active')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--include-drafts')
  .option('--include-archive')
  .option('--include-superseded')
  .option('--limit <number>', 'maximum result count', '10')
  .action((query, options) => emit(getDecisions(getDecisionsInputSchema.parse({
    query,
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: Boolean(options.includeDrafts),
    includeArchive: Boolean(options.includeArchive),
    includeSuperseded: Boolean(options.includeSuperseded),
    limit: Number(options.limit),
  }))));

program
  .command('build-project-context-pack')
  .argument('<query>')
  .description('Build a context pack with mandatory top-level sources')
  .option('--task <taskId>')
  .option('--profile <profile>', 'default|local-model')
  .option('--workflow <level>', 'fast|standard|strict')
  .option('--max-tokens <number>', 'token budget hint')
  .option('--include-archive')
  .option('--explain')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--file <path>', 'explicit file path hint; can be repeated', collectValues, [])
  .option('--changed-file <path>', 'changed file path hint; can be repeated', collectValues, [])
  .action((query, options) => emit(buildProjectContextPack(buildProjectContextPackInputSchema.parse({
    query,
    taskId: options.task,
    profile: parseProfile(options.profile),
    workflow: parseWorkflow(options.workflow),
    maxTokens: options.maxTokens === undefined ? undefined : Number(options.maxTokens),
    includeArchive: Boolean(options.includeArchive),
    explain: Boolean(options.explain),
    modules: splitCsv(options.modules),
    files: options.file,
    changedFiles: options.changedFile,
  }))));

program
  .command('propose-context-update')
  .description('Create a reviewable draft Markdown project context record')
  .requiredOption('--input <jsonFile>', 'JSON payload')
  .action((options) => emit(proposeContextUpdate(proposeContextUpdateInputSchema.parse(readJsonInput(options.input)))));

program
  .command('find-requirements')
  .argument('[query]', 'query text')
  .description('Find analyst-facing requirement records with source links')
  .option('--requirement-keys <keys>', 'comma-separated requirement keys')
  .option('--areas <areas>', 'comma-separated requirement areas')
  .option('--source-ids <ids>', 'comma-separated source ids')
  .option('--chunk-ids <ids>', 'comma-separated chunk ids')
  .option('--task-ids <ids>', 'comma-separated task ids')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '20')
  .action((query, options) => emit(findRequirements(findRequirementsInputSchema.parse({
    query,
    requirementKeys: splitCsv(options.requirementKeys),
    areas: splitCsv(options.areas),
    sourceIds: splitCsv(options.sourceIds),
    chunkIds: splitCsv(options.chunkIds),
    taskIds: splitCsv(options.taskIds),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('find-source-chunks')
  .argument('[query]', 'query text')
  .description('Find analyst source chunks with source links')
  .option('--source-ids <ids>', 'comma-separated source ids')
  .option('--chunk-ids <ids>', 'comma-separated chunk ids')
  .option('--topics <topics>', 'comma-separated topics')
  .option('--system-areas <areas>', 'comma-separated system areas')
  .option('--information-types <types>', 'comma-separated information types')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '20')
  .action((query, options) => emit(findSourceChunks(findSourceChunksInputSchema.parse({
    query,
    sourceIds: splitCsv(options.sourceIds),
    chunkIds: splitCsv(options.chunkIds),
    topics: splitCsv(options.topics),
    systemAreas: splitCsv(options.systemAreas),
    informationTypes: splitCsv(options.informationTypes),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('get-open-questions')
  .argument('[query]', 'query text')
  .description('Find analyst open questions')
  .option('--question-kinds <kinds>', 'comma-separated question kinds')
  .option('--owners <owners>', 'comma-separated owners')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '20')
  .action((query, options) => emit(getOpenQuestions(getOpenQuestionsInputSchema.parse({
    query,
    questionKinds: splitCsv(options.questionKinds),
    owners: splitCsv(options.owners),
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('get-conflicts')
  .argument('[query]', 'query text')
  .description('Find analyst conflict records')
  .option('--statuses <statuses>', 'comma-separated statuses')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum result count', '20')
  .action((query, options) => emit(getConflicts(getOpenQuestionsInputSchema.parse({
    query,
    questionKinds: ['conflict'],
    statuses: splitCsv(options.statuses),
    modules: splitCsv(options.modules),
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('trace-requirement')
  .argument('[requirementKey]', 'requirement key such as REQ-RPL-001')
  .option('--query <query>', 'fallback free-form query')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum requirement count', '5')
  .description('Trace requirement to sources, chunks, tasks, and acceptance checks')
  .action((requirementKey, options) => emit(traceRequirement(traceRequirementInputSchema.parse({
    requirementKey,
    query: options.query,
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('analyst-pack')
  .argument('<query>')
  .description('Build an analyst context pack from requirements, chunks, decisions, and open questions')
  .option('--no-drafts', 'exclude draft records')
  .option('--include-archive')
  .option('--limit <number>', 'maximum records per section', '10')
  .action((query, options) => emit(buildAnalystContextPack(buildAnalystContextPackInputSchema.parse({
    query,
    includeDrafts: options.drafts !== false,
    includeArchive: Boolean(options.includeArchive),
    limit: Number(options.limit),
  }))));

program
  .command('analyst-delta-to-backlog')
  .argument('<query>')
  .description('Convert matched analyst requirement/question deltas into draft backlog proposals')
  .option('--apply', 'write draft backlog proposals')
  .option('--force', 'allow related proposals')
  .option('--limit <number>', 'maximum proposals', '5')
  .action((query, options) => emit(analystDeltaToBacklog(analystDeltaToBacklogInputSchema.parse({
    query,
    apply: Boolean(options.apply),
    force: Boolean(options.force),
    limit: Number(options.limit),
  }))));

program
  .command('propose-analyst-source')
  .description('Create or preview a draft analyst source record')
  .requiredOption('--input <jsonFile>', 'JSON payload')
  .action((options) => emit(proposeAnalystSource(proposeAnalystSourceInputSchema.parse(readJsonInput(options.input)))));

program
  .command('import-rp-database')
  .description('Import curated RP archive database knowledge into reviewable project-context drafts')
  .option('--path <path>', 'RP archive folder path', defaultRpArchivePath)
  .option('--apply', 'write draft records')
  .option('--limit <number>', 'maximum records to create or preview')
  .option('--no-sources')
  .option('--no-chunks')
  .option('--no-traceability')
  .option('--no-decisions')
  .action((options) => emit(importRpDatabase(importRpDatabaseInputSchema.parse({
    path: options.path,
    apply: Boolean(options.apply),
    limit: options.limit === undefined ? undefined : Number(options.limit),
    includeSources: options.sources !== false,
    includeChunks: options.chunks !== false,
    includeTraceability: options.traceability !== false,
    includeDecisions: options.decisions !== false,
  }))));

program
  .command('backlog')
  .description('List active backlog records')
  .option('--status <status>', 'comma-separated statuses such as ready,open,blocked')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--include-done')
  .option('--limit <number>', 'maximum result count', '50')
  .action((options) => {
    const modules = options.modules ? String(options.modules).split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    emit(getBacklog({
      status: options.status,
      modules,
      includeDone: Boolean(options.includeDone),
      limit: Number(options.limit),
    }));
  });

program
  .command('pick-task')
  .description('Pick the next ready/open backlog task for an agent')
  .argument('[query]')
  .option('--modules <modules>', 'comma-separated modules')
  .action((query, options) => {
    const modules = options.modules ? String(options.modules).split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    emit(pickNextBacklogTask({ query, modules }));
  });

program
  .command('backlog-graph')
  .description('Show active backlog dependencies, blockers, and cycles')
  .option('--modules <modules>', 'comma-separated modules')
  .option('--hide-done', 'exclude done/cancelled nodes')
  .action((options) => {
    const modules = options.modules ? String(options.modules).split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    emit(getBacklogDependencyGraph({ modules, includeDone: !Boolean(options.hideDone) }));
  });

program
  .command('task-from-backlog')
  .argument('<backlogId>')
  .description('Convert a backlog record into a task contract preview, draft, or confirmed task')
  .option('--create-draft', 'create a draft task record')
  .option('--confirm', 'create and confirm an active task contract')
  .action((backlogId, options) => {
    const mode = options.confirm ? 'confirm' : options.createDraft ? 'draft' : 'preview';
    emit(taskFromBacklog(taskFromBacklogInputSchema.parse({ backlogId, mode })));
  });

program
  .command('propose-backlog-item')
  .argument('[title]')
  .description('Create a reviewable draft backlog item from a chat/task idea')
  .option('--input <jsonFile>', 'JSON payload with rich backlog fields')
  .option('--dry-run', 'preview without writing a draft')
  .option('--force', 'allow a separate proposal when related backlog records exist')
  .action((title, options) => {
    const input = readJsonInput(options.input);
    emit(proposeBacklogItem(proposeBacklogItemInputSchema.parse({
      ...input,
      title: typeof input.title === 'string' ? input.title : title,
      dryRun: Boolean(options.dryRun) || input.dryRun === true,
      force: Boolean(options.force) || input.force === true,
    })));
  });

program
  .command('confirm-backlog-item')
  .argument('<backlogId>')
  .description('Promote a reviewed draft backlog item into active backlog')
  .requiredOption('--approved-by <name>', 'reviewer approving this backlog item')
  .option('--status <status>', 'open|ready|blocked', 'open')
  .option('--dry-run', 'preview target without moving the draft')
  .action((backlogId, options) => emit(confirmBacklogItem(confirmBacklogItemInputSchema.parse({
    backlogId,
    approvedBy: options.approvedBy,
    status: options.status,
    dryRun: Boolean(options.dryRun),
  }))));

program
  .command('transition-backlog-item')
  .argument('<backlogId>')
  .requiredOption('--status <status>', 'open|ready|blocked|in_progress|done|cancelled')
  .option('--reason <reason>', 'transition reason')
  .option('--blocked-by <ids>', 'comma-separated dependency ids for blocked status')
  .option('--evidence <id>', 'verification evidence id for done status')
  .option('--dry-run', 'preview without updating the backlog record')
  .description('Apply a validated lifecycle transition to an active backlog item')
  .action((backlogId, options) => emit(transitionBacklogItem(transitionBacklogItemInputSchema.parse({
    backlogId,
    status: options.status,
    reason: options.reason,
    blockedBy: options.blockedBy ? String(options.blockedBy).split(',').map((item) => item.trim()).filter(Boolean) : [],
    evidenceId: options.evidence,
    dryRun: Boolean(options.dryRun),
  }))));

program
  .command('spec-to-backlog')
  .description('Scan specification files for open points and propose draft backlog items')
  .option('--path <glob>', 'spec glob path; can be repeated with JSON input for multiple paths')
  .option('--limit <number>', 'maximum candidates', '20')
  .option('--apply', 'write draft backlog proposals')
  .option('--force', 'allow separate proposals when related records exist')
  .action((options) => emit(specToBacklog(specToBacklogInputSchema.parse({
    paths: options.path ? [options.path] : undefined,
    limit: Number(options.limit),
    apply: Boolean(options.apply),
    force: Boolean(options.force),
  }))));

program
  .command('validate-task')
  .argument('<query>')
  .description('Validate an incoming feature or bug task and create a draft task contract')
  .option('--mode <mode>', 'feature|bug|refactor', 'feature')
  .action((query, options) => emit(validateTask(query, options.mode)));

program
  .command('confirm-task')
  .argument('<taskId>')
  .description('Promote a draft task into a human-confirmed task contract')
  .option('--input <jsonFile>', 'JSON payload with goal, scope, outOfScope, acceptanceCriteria, risks, testExpectations')
  .action((taskId, options) => {
    const payload = { taskId, ...readJsonInput(options.input) };
    emit(confirmTaskContract(confirmTaskInputSchema.parse(payload)));
  });

program
  .command('start-work')
  .argument('<taskId>')
  .description('Mark a confirmed task as in progress')
  .action((taskId) => emit(startWork(taskId)));

program
  .command('finalize-work')
  .argument('[taskId]')
  .description('Create a draft run summary after implementation')
  .option('--input <jsonFile>', 'JSON payload')
  .option('--auto-fill', 'infer changed files from git diff and untracked files')
  .action((taskId, options) => {
    const input = readJsonInput(options.input);
    const payload = { taskId, ...input, autoFill: Boolean(options.autoFill) || input.autoFill === true };
    emit(finalizeWork(finalizeWorkInputSchema.parse(payload)));
  });

program
  .command('verify-task')
  .argument('[id]')
  .description('Build a verification plan for a task, backlog item, record, or query')
  .option('--query <query>', 'free-form task query')
  .action((id, options) => emit(getVerificationPlan(verificationPlanInputSchema.parse({ id, query: options.query }))));

program
  .command('record-verification')
  .description('Record verification evidence for a task, backlog item, or record')
  .requiredOption('--input <jsonFile>', 'JSON payload')
  .action((options) => emit(recordVerificationEvidence(verificationEvidenceInputSchema.parse(readJsonInput(options.input)))));

program
  .command('verification-evidence')
  .argument('[targetId]')
  .description('List recorded verification evidence')
  .option('--limit <number>', 'maximum evidence records', '20')
  .action((targetId, options) => emit(listVerificationEvidence(listVerificationEvidenceInputSchema.parse({
    targetId,
    limit: Number(options.limit),
  }))));

program
  .command('promote-draft')
  .argument('<recordId>')
  .description('Dry-run or apply promotion of a reviewed draft record into active context')
  .option('--apply', 'move the draft into active context')
  .option('--approved-by <name>', 'reviewer approving the promotion')
  .action((recordId, options) => emit(promoteDraft(promoteDraftInputSchema.parse({
    recordId,
    apply: Boolean(options.apply),
    approvedBy: options.approvedBy,
  }))));

program
  .command('promote-drafts-batch')
  .description('Dry-run or apply promotion of matching reviewed draft records into active context')
  .option('--record-ids <ids>', 'comma-separated record ids')
  .option('--types <types>', 'comma-separated record types')
  .option('--tags <tags>', 'comma-separated tags; all listed tags must match')
  .option('--statuses <statuses>', 'comma-separated draft statuses to include', 'draft')
  .option('--query <query>', 'free-form text filter')
  .option('--limit <number>', 'maximum records to preview or promote')
  .option('--all', 'allow broad selection without record ids, types, tags, or query')
  .option('--apply', 'move matched drafts into active context')
  .option('--approved-by <name>', 'reviewer approving the promotion')
  .action((options) => emit(promoteDraftsBatch(promoteDraftsBatchInputSchema.parse({
    recordIds: splitCsv(options.recordIds),
    types: splitCsv(options.types),
    tags: splitCsv(options.tags),
    statuses: splitCsv(options.statuses),
    query: options.query,
    limit: options.limit === undefined ? undefined : Number(options.limit),
    all: Boolean(options.all),
    apply: Boolean(options.apply),
    approvedBy: options.approvedBy,
  }))));

program
  .command('reuse-scan')
  .argument('<query>')
  .description('Find existing implementation capabilities before creating new code')
  .option('--modules <modules>', 'comma-separated modules')
  .action((query, options) => {
    const modules = options.modules ? String(options.modules).split(',').map((item) => item.trim()).filter(Boolean) : undefined;
    emit(findExistingCapability(query, modules));
  });

program
  .command('reuse-scan-batch')
  .description('Find existing implementation capabilities for multiple queries in one process')
  .requiredOption('--input <jsonFile>', 'JSON payload with queries: [{ query, modules? }]')
  .action((options) => {
    const input = readJsonInput(options.input) as { queries?: Array<{ query: string; modules?: string[] }> };
    emit(findExistingCapabilities({ queries: input.queries ?? [] }));
  });

program
  .command('refactor-review')
  .description('Review current diff for local or deferred refactor opportunities')
  .option('--task <taskId>')
  .action((options) => emit(reviewDiffForRefactor(options.task)));

program
  .command('gc')
  .description('Show or apply retention cleanup')
  .option('--dry-run', 'show candidates only')
  .option('--apply', 'archive eligible records')
  .option('--ci', 'fail on critical context problems')
  .option('--limit <number>', 'maximum cleanup candidates printed unless --verbose is used', '5')
  .option('--verbose', 'print every cleanup candidate')
  .action((options) => {
    if (options.apply) {
      emit({ status: 'OK', ...applyCleanup() });
      return;
    }
    const result = proposeCleanup(Boolean(options.ci));
    const limit = Math.max(0, Number(options.limit) || 0);
    emit({
      status: result.critical.length > 0 ? 'FAILED' : 'OK',
      ...compactCleanupResult(result, limit, Boolean(options.verbose)),
    }, result.critical.length > 0 ? 1 : 0);
  });

program
  .command('current-truth')
  .description('Audit or apply active-context current-truth hygiene for stale workflow history')
  .option('--apply', 'archive safe stale workflow-history records')
  .option('--approved-by <name>', 'reviewer approving the apply operation')
  .option('--archive-attention', 'also archive explicitly selected manual attention candidates')
  .option('--all-attention', 'allow selecting every attention candidate; use only after reviewing the dry-run manifest')
  .option('--record-ids <ids>', 'comma-separated attention candidate ids to select')
  .option('--attention-types <types>', 'comma-separated attention record types to select, such as task,verification-evidence,refactor')
  .option('--attention-statuses <statuses>', 'comma-separated attention statuses to select, such as confirmed,in_progress,failed,proposed')
  .option('--attention-min-age-days <number>', 'select attention candidates at least this many days old')
  .option('--done-task-days <number>', 'override project.yaml completed-task retention')
  .option('--history-days <number>', 'override project.yaml workflow-history retention')
  .option('--stale-work-days <number>', 'override project.yaml active-work attention threshold')
  .option('--limit <number>', 'maximum candidates and archived paths returned in the manifest', '50')
  .action((options) => emit(currentTruthAudit(currentTruthInputSchema.parse({
    apply: Boolean(options.apply),
    approvedBy: options.approvedBy,
    archiveAttention: Boolean(options.archiveAttention),
    allAttention: Boolean(options.allAttention),
    recordIds: splitCsv(options.recordIds),
    attentionTypes: splitCsv(options.attentionTypes),
    attentionStatuses: splitCsv(options.attentionStatuses),
    attentionMinAgeDays: options.attentionMinAgeDays === undefined ? undefined : Number(options.attentionMinAgeDays),
    doneTaskDays: options.doneTaskDays === undefined ? undefined : Number(options.doneTaskDays),
    historyDays: options.historyDays === undefined ? undefined : Number(options.historyDays),
    staleWorkDays: options.staleWorkDays === undefined ? undefined : Number(options.staleWorkDays),
    limit: Number(options.limit),
  }))));

const confluence = program
  .command('confluence')
  .description('Configure and diagnose project-scoped Confluence publishing');

confluence
  .command('auth')
  .description('Authenticate Confluence using the environment or native per-user credential store')
  .option('--base-url <url>', 'approved Confluence base URL')
  .option('--non-interactive', 'fail instead of prompting for a missing native credential')
  .action(async (options) => emit(await authenticateConfluence({
    baseUrl: options.baseUrl,
    nonInteractive: Boolean(options.nonInteractive),
  })));

confluence
  .command('setup')
  .description('Authenticate and bind the project Confluence root page')
  .option('--root-page <url>', 'Confluence root page URL')
  .option('--exclude-root', 'allow writes only to descendants, not the root page itself')
  .option('--yes', 'confirm the discovered root without another prompt')
  .option('--non-interactive', 'require credential, root page, and confirmation from non-interactive inputs')
  .action(async (options) => emit(await setupConfluence({
    rootPageUrl: options.rootPage,
    includeRoot: !Boolean(options.excludeRoot),
    yes: Boolean(options.yes),
    nonInteractive: Boolean(options.nonInteractive),
  })));

confluence
  .command('bind')
  .description('Bind the initial project Confluence root page')
  .requiredOption('--root-page <url>', 'Confluence root page URL')
  .option('--exclude-root', 'allow writes only to descendants, not the root page itself')
  .option('--yes', 'confirm the discovered root without another prompt')
  .option('--non-interactive')
  .action(async (options) => emit(await bindConfluenceRoot({
    rootPageUrl: options.rootPage,
    includeRoot: !Boolean(options.excludeRoot),
    yes: Boolean(options.yes),
    nonInteractive: Boolean(options.nonInteractive),
  })));

confluence
  .command('rebind')
  .description('Replace the project Confluence root and invalidate previous publication plans')
  .requiredOption('--root-page <url>', 'new Confluence root page URL')
  .option('--exclude-root', 'allow writes only to descendants, not the root page itself')
  .option('--yes', 'confirm the discovered root without another prompt')
  .option('--non-interactive')
  .action(async (options) => emit(await bindConfluenceRoot({
    rootPageUrl: options.rootPage,
    includeRoot: !Boolean(options.excludeRoot),
    allowReplace: true,
    yes: Boolean(options.yes),
    nonInteractive: Boolean(options.nonInteractive),
  })));

confluence
  .command('doctor')
  .description('Check the project root, credential, identity, reachability, and effective write permissions')
  .action(async () => {
    const result = await confluenceDoctor();
    emit(result, result.ok ? 0 : 1);
  });

const portal = program
  .command('portal')
  .description('Bind this repository to a project-scoped Context Hub snapshot source');

portal
  .command('auth')
  .description('Sign in through a browser or verify existing credentials and project membership')
  .requiredOption('--base-url <url>', 'Context Hub base URL')
  .requiredOption('--project-id <uuid>', 'Portal project UUID')
  .option('--issuer-url <url>', 'OIDC issuer URL used for browser device authorization')
  .option('--client-id <id>', 'public OIDC device client id')
  .option('--non-interactive', 'fail instead of prompting for a missing native credential')
  .action(async (options) => emit(await authenticatePortal({
    baseUrl: options.baseUrl,
    projectId: options.projectId,
    issuerUrl: options.issuerUrl,
    clientId: options.clientId,
    nonInteractive: Boolean(options.nonInteractive),
  })));

portal
  .command('setup')
  .description('Bind the project, cache its verified snapshot, and list assigned WorkPackages')
  .requiredOption('--base-url <url>', 'Context Hub base URL')
  .requiredOption('--project-id <uuid>', 'Portal project UUID')
  .option('--issuer-url <url>', 'OIDC issuer URL used for browser device authorization')
  .option('--client-id <id>', 'public OIDC device client id')
  .option('--yes', 'confirm the verified project without another prompt')
  .option('--non-interactive', 'require credential and confirmation from non-interactive inputs')
  .action(async (options) => {
    const result = await setupPortal({
      baseUrl: options.baseUrl,
      projectId: options.projectId,
      issuerUrl: options.issuerUrl,
      clientId: options.clientId,
      yes: Boolean(options.yes),
      nonInteractive: Boolean(options.nonInteractive),
    });
    emit(result, result.ready ? 0 : 1);
  });

portal
  .command('sync')
  .description('Verify and cache the current immutable shared project snapshot')
  .option('--offline', 'read only the last verified cache and mark it stale')
  .action(async (options) => emit(await syncPortalSnapshot({ offline: Boolean(options.offline) })));

portal
  .command('assigned')
  .description('List WorkPackages assigned to the current Portal identity')
  .action(async () => emit(await getAssignedPortalWork()));

portal
  .command('status')
  .description('Show non-secret binding and verified cache metadata')
  .action(() => emit(portalSyncStatus()));

portal
  .command('doctor')
  .description('Check binding, credential, membership, current snapshot, and cache readiness')
  .action(async () => {
    const result = await portalDoctor();
    emit(result, result.ok ? 0 : 1);
  });

program
  .command('doctor')
  .description('Diagnose context-router wiring, hooks, index, backlog, and lint health')
  .option('--fix-dry-run', 'include non-mutating fix proposals')
  .action((options) => {
    const result = contextDoctor({ fixDryRun: Boolean(options.fixDryRun) });
    emit(result, result.status === 'FAILED' ? 1 : 0);
  });

program
  .command('snapshot')
  .description('Return a compact project snapshot for agents')
  .option('--no-dirty', 'omit git dirty summary')
  .option('--no-backlog', 'omit backlog summary')
  .action((options) => emit(getProjectSnapshot({
    includeDirty: options.dirty !== false,
    includeBacklog: options.backlog !== false,
  })));

const archive = program.command('archive').description('Archive context records');
archive
  .command('stale')
  .requiredOption('--older-than <duration>', 'duration such as 90d')
  .action((options) => emit({ status: 'OK', ...archiveStale(options.olderThan) }));

program.command('restore').argument('<recordId>').description('Restore an archived record to active context').action((recordId) => emit(restore(recordId)));

program.command('capture-commit').argument('[commit]', 'commit sha', 'HEAD').description('Best-effort post-commit context capture').action((commit) => {
  emit({ status: 'OK', commit, message: 'capture-commit is non-blocking in MVP; index --changed should be run separately.' });
});

program
  .command('record-decision')
  .description('Create a decision draft')
  .requiredOption('--input <jsonFile>', 'JSON payload')
  .action((options) => emit(recordDecision(decisionInputSchema.parse(readJsonInput(options.input)))));

program.command('brief').description('Print project brief').action(() => {
  const config = loadProjectConfig();
  emit({
    project: config.project.name,
    config,
    playbooks: [...new Set(Object.values(config.modules).flatMap((module) => module.playbooks))],
    commands: Object.values(config.commands),
  });
});

program.parseAsync(process.argv).catch((error: unknown) => {
  emit({ status: 'FAILED', errors: [error instanceof Error ? error.message : String(error)] }, 1);
});

function readJsonInput(path?: string): Record<string, unknown> {
  if (!path) return {};
  const reference = classifyFileReference(path);
  if (reference.kind !== 'file') throw new Error(`Input must be a repository file: ${path}`);
  return JSON.parse(readFileSync(reference.absolutePath, 'utf8')) as Record<string, unknown>;
}

function emit(data: unknown, exitCode = 0): void {
  const asJson = jsonRequested || program.opts().json;
  if (asJson) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatHuman(data)}\n`);
  }
  process.exitCode = exitCode;
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function splitCsv(value: string | undefined): string[] {
  return value ? String(value).split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseWorkflow(value: string | undefined): 'fast' | 'standard' | 'strict' | undefined {
  if (value === undefined) return undefined;
  if (value === 'fast' || value === 'standard' || value === 'strict') return value;
  throw new Error(`Unsupported workflow: ${value}. Expected fast, standard, or strict.`);
}

function parseProfile(value: string | undefined): 'default' | 'local-model' | undefined {
  if (value === undefined) return undefined;
  if (value === 'default' || value === 'local-model') return value;
  throw new Error(`Unsupported profile: ${value}. Expected default or local-model.`);
}

function hasIndexDiagnostics(result: { fileReferenceIssues?: unknown[]; duplicateRecordIssues?: unknown[] }): boolean {
  return (result.fileReferenceIssues?.length ?? 0) > 0 || (result.duplicateRecordIssues?.length ?? 0) > 0;
}

function formatHuman(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return String(data);
  const object = data as Record<string, unknown>;
  if (Array.isArray(data)) return data.map(formatHuman).join('\n');
  if ('status' in object) {
    const lines = [`status: ${object.status}`];
    for (const [key, value] of Object.entries(object)) {
      if (key === 'status') continue;
      lines.push(`${key}: ${JSON.stringify(value, null, 2)}`);
    }
    return lines.join('\n');
  }
  return JSON.stringify(data, null, 2);
}
