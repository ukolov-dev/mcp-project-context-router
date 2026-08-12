import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getContextBrand, withBrand } from '../brand.js';
import { resolveMcpToolProfile, toolEnabledForProfile } from './tool-profiles.js';
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
} from '../backlog/backlog.js';
import { buildContextPack } from '../context-pack/pack.js';
import { buildUnifiedContextPack } from '../context-pack/unified.js';
import { currentTruthAudit, currentTruthInputSchema } from '../current-truth/current-truth.js';
import { contextDoctor } from '../doctor/doctor.js';
import { getProjectSnapshot } from '../project-snapshot/snapshot.js';
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
} from '../project-context/analytics.js';
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
} from '../project-context/project-context.js';
import {
  defaultRpArchivePath,
  importRpDatabase,
  importRpDatabaseInputSchema,
  proposeAnalystSource,
  proposeAnalystSourceInputSchema,
} from '../project-context/rp-import.js';
import { proposeCleanup, archiveRecords } from '../gc/gc.js';
import { promoteDraft, promoteDraftInputSchema, promoteDraftsBatch, promoteDraftsBatchInputSchema } from '../promotion/promote.js';
import { reviewDiffForRefactor } from '../refactor-review/refactor.js';
import { findExistingCapabilities, findExistingCapability } from '../reuse-scan/reuse.js';
import { specToBacklog, specToBacklogInputSchema } from '../spec-intake/spec-to-backlog.js';
import { loadProjectConfig } from '../storage/config.js';
import {
  confirmTaskContract,
  confirmTaskInputSchema,
  decisionInputSchema,
  finalizeWork,
  finalizeWorkInputSchema,
  recordDecision,
  validateTask,
} from '../task-validation/task.js';
import {
  getVerificationPlan,
  listVerificationEvidence,
  listVerificationEvidenceInputSchema,
  recordVerificationEvidence,
  verificationEvidenceInputSchema,
  verificationPlanInputSchema,
} from '../verification/verification.js';
import { projectContextVersion } from '../version.js';
import {
  applyConfluencePublish,
  applyConfluencePublishInputSchema,
  getConfluencePublishPlan,
  planConfluencePublish,
  planConfluencePublishInputSchema,
} from '../confluence/publish.js';
import {
  acceptPortalAssignment,
  getAssignedPortalWork,
  getExactPortalSnapshot,
  getPortalHandoff,
  portalSyncStatus,
  submitPortalImplementationReport,
  syncPortalSnapshot,
} from '../portal/bridge.js';

const startupConfig = loadProjectConfig();
const projectName = startupConfig.project.name;
const resourceScheme = startupConfig.contextRouter.resourceScheme;
const server = new McpServer({ name: startupConfig.contextRouter.mcpServerName, version: projectContextVersion });
const activeToolProfile = resolveMcpToolProfile();
const structuredJsonOutputSchema = z.object({
  brand: z.object({
    name: z.string(),
    shortName: z.string(),
    marker: z.string(),
    logoText: z.string(),
    description: z.string(),
  }),
}).loose();

server.registerResource(
  'project-backlog',
  `${resourceScheme}://backlog`,
  {
    title: `${projectName} project backlog`,
    description: 'Active backlog records with priorities, dependencies, acceptance criteria, and checks.',
    mimeType: 'application/json',
  },
  async (uri) => resourceJson(uri, getBacklog()),
);

server.registerResource(
  'next-backlog-task',
  `${resourceScheme}://backlog/next`,
  {
    title: `Next recommended ${projectName} backlog task`,
    description: 'Best ready/open backlog item for an agent to pick next.',
    mimeType: 'application/json',
  },
  async (uri) => resourceJson(uri, pickNextBacklogTask()),
);

server.registerResource(
  'backlog-dependency-graph',
  `${resourceScheme}://backlog/graph`,
  {
    title: `${projectName} backlog dependency graph`,
    description: 'Active backlog nodes, dependency edges, blockers, missing dependencies, and cycles.',
    mimeType: 'application/json',
  },
  async (uri) => resourceJson(uri, getBacklogDependencyGraph()),
);

server.registerResource(
  'context-doctor',
  `${resourceScheme}://doctor`,
  {
    title: `${projectName} context-router doctor`,
    description: 'Current health of context-router wiring, hooks, index, backlog, and lint.',
    mimeType: 'application/json',
  },
  async (uri) => resourceJson(uri, contextDoctor()),
);

server.registerTool(
  'get_project_brief',
  {
    title: `Get ${projectName} project brief`,
    description: 'Return modules, verification commands, playbooks, and important context-router constraints.',
  },
  async () => {
    const config = loadProjectConfig();
    return json({
      brand: getContextBrand(),
      project: config.project.name,
      toolProfile: activeToolProfile,
      config,
      playbooks: [...new Set(Object.values(config.modules).flatMap((module) => module.playbooks))],
      commands: Object.values(config.commands),
      constraints: [
      'Use pick_next_task before choosing work from the backlog.',
      'Use propose_backlog_item then confirm_backlog_item before adding new active backlog records.',
      'Use transition_backlog_item for backlog status changes.',
      'Record verification evidence after checks; MCP does not execute shell commands.',
      'Validate feature/bug tasks before implementation.',
      'Do not promote drafts to active context without human review.',
      'Do not store secrets, raw transcripts, full logs, tokens, or plaintext passwords.',
      ],
    });
  },
);

server.registerTool(
  'get_shared_project_snapshot',
  {
    title: 'Get current verified Portal project snapshot',
    description: 'Return the exact immutable shared snapshot for the repository-bound Portal project, including verified revision bodies and authority/freshness metadata.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      offline: z.boolean().default(false),
    },
  },
  async ({ offline }) => json(await syncPortalSnapshot({ offline })),
);

server.registerTool(
  'get_exact_shared_snapshot',
  {
    title: 'Get an exact verified Portal snapshot',
    description: 'Resolve a specific immutable snapshot UUID in the bound project and verify its manifest and every revision digest.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      snapshotId: z.string().uuid(),
    },
  },
  async ({ snapshotId }) => json(await getExactPortalSnapshot(snapshotId)),
);

server.registerTool(
  'get_assigned_work',
  {
    title: 'Get WorkPackages assigned to the current developer',
    description: 'Return only work assigned to the authenticated identity within the repository-bound Portal project, including the exact snapshot digest and analyst-confirmed handoff ID needed for delivery.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  async () => json(await getAssignedPortalWork()),
);

server.registerTool(
  'get_handoff_bundle',
  {
    title: 'Get a project-scoped handoff bundle',
    description: 'Return a handoff and its exact verified input snapshot. Cross-project access is rejected by the Portal and connector.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      handoffId: z.string().uuid(),
    },
  },
  async ({ handoffId }) => json(await getPortalHandoff(handoffId)),
);

server.registerTool(
  'get_portal_sync_status',
  {
    title: 'Get safe Portal binding and cache status',
    description: 'Return non-secret project binding, snapshot ID, digest, and verified-cache metadata.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => json(portalSyncStatus()),
);

server.registerTool(
  'accept_assigned_work',
  {
    title: 'Accept an assigned Portal WorkPackage',
    description: 'Explicitly accept the analyst-confirmed handoff for work assigned to the current developer before implementation starts.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      workItemId: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
    },
  },
  async (args) => json(await acceptPortalAssignment(args)),
);

server.registerTool(
  'submit_implementation_report',
  {
    title: 'Submit a typed implementation report',
    description: 'Write only a structured, idempotent ImplementationReport for work assigned to the current developer. This is not a general Portal write proxy.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      workItemId: z.string().uuid(),
      expectedVersion: z.number().int().nonnegative(),
      idempotencyKey: z.string().regex(/^[A-Za-z0-9._:/-]{7,255}$/),
      commitRef: z.string().trim().min(1).max(255),
      mergeRequestUrl: z.string().url().max(1000).optional(),
      ciUrl: z.string().url().max(1000).optional(),
      summary: z.string().trim().min(1).max(4000),
    },
  },
  async (args) => json(await submitPortalImplementationReport(args)),
);

server.registerTool(
  'validate_task',
  {
    title: `Validate incoming ${projectName} task`,
    description: 'Create a draft task contract and return blocking questions.',
    inputSchema: {
      query: z.string(),
      mode: z.enum(['feature', 'bug', 'refactor']).default('feature'),
    },
  },
  async ({ query, mode }) => json(validateTask(query, mode)),
);

server.registerTool(
  'confirm_task_contract',
  {
    title: 'Confirm task contract',
    description: 'Promote a draft task into a confirmed active task contract.',
    inputSchema: {
      taskId: z.string(),
      goal: z.string(),
      scope: z.array(z.string()).default([]),
      outOfScope: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(z.string()).default([]),
      risks: z.array(z.string()).default([]),
      testExpectations: z.array(z.string()).default([]),
      modules: z.array(z.string()).optional(),
      files: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
    },
  },
  async (args) => json(confirmTaskContract(confirmTaskInputSchema.parse(args))),
);

server.registerTool(
  'build_context_pack',
  {
    title: 'Build context pack',
    description: 'Return a compact set of records, files, playbooks, commands, and warnings for a task.',
    inputSchema: {
      query: z.string(),
      taskId: z.string().optional(),
      profile: z.enum(['default', 'local-model']).optional(),
      workflow: z.enum(['fast', 'standard', 'strict']).optional(),
      maxTokens: z.number().int().min(500).optional(),
      includeArchive: z.boolean().default(false),
      includeHistory: z.boolean().default(false),
      explain: z.boolean().default(false),
      modules: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]),
      changedFiles: z.array(z.string()).default([]),
    },
  },
  async (args) => json(buildContextPack(args)),
);

server.registerTool(
  'retrieve_project_context',
  {
    title: 'Retrieve shared and local project context',
    description: 'Build one project-scoped, token-bounded context pack from Portal evidence and local Project Context while preserving authority, revision, digest, rank, and truncation metadata.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      query: z.string().default(''),
      intent: z.string().default(''),
      maximumTokens: z.number().int().min(500).max(128_000).default(8_000),
      topK: z.number().int().min(1).max(50).default(10),
      allowedAuthorities: z.array(z.enum([
        'SOURCE',
        'NORMALIZED_SOURCE',
        'PROPOSAL',
        'DRAFT',
        'CANDIDATE',
        'PUBLISHED',
      ])).default(['PUBLISHED', 'SOURCE', 'NORMALIZED_SOURCE']),
      mandatoryChunkIds: z.array(z.string().uuid()).default([]),
      pinnedChunkIds: z.array(z.string().uuid()).default([]),
      excludedChunkIds: z.array(z.string().uuid()).default([]),
      documentType: z.string().optional(),
      status: z.string().optional(),
      dateFrom: z.string().date().optional(),
      dateTo: z.string().date().optional(),
      participant: z.string().optional(),
      sourceId: z.string().uuid().optional(),
      documentId: z.string().uuid().optional(),
      exactRevisionId: z.string().uuid().optional(),
      exactSnapshotId: z.string().uuid().optional(),
      retrievalMode: z.enum(['AUTO', 'FULL_TEXT', 'VECTOR_EXACT', 'HYBRID']).default('AUTO'),
      taskId: z.string().optional(),
      modules: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]),
      changedFiles: z.array(z.string()).default([]),
      includeLocal: z.boolean().default(true),
    },
  },
  async (args) => json(await buildUnifiedContextPack(args)),
);

server.registerTool(
  'search_project_context',
  {
    title: 'Search project context',
    description: 'Search Markdown project context records and return mandatory source links for every result.',
    inputSchema: {
      query: z.string().default(''),
      types: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(false),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(10),
    },
  },
  async (args) => json(searchProjectContext(searchProjectContextInputSchema.parse(args))),
);

server.registerTool(
  'find_integrations',
  {
    title: 'Find integrations',
    description: 'Find integration records from Markdown project context and include sources[].',
    inputSchema: {
      query: z.string().optional(),
      systems: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(false),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(10),
    },
  },
  async (args) => json(findIntegrations(findIntegrationsInputSchema.parse(args))),
);

server.registerTool(
  'find_data_entities',
  {
    title: 'Find data entities',
    description: 'Find data entity records from Markdown project context and include sources[].',
    inputSchema: {
      query: z.string().optional(),
      entityNames: z.array(z.string()).default([]),
      fields: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(false),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(10),
    },
  },
  async (args) => json(findDataEntities(findDataEntitiesInputSchema.parse(args))),
);

server.registerTool(
  'get_decisions',
  {
    title: 'Get decisions',
    description: 'Return reviewed decision records with mandatory sources[].',
    inputSchema: {
      query: z.string().optional(),
      statuses: z.array(z.string()).default(['active']),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(false),
      includeArchive: z.boolean().default(false),
      includeSuperseded: z.boolean().default(false),
      limit: z.number().default(10),
    },
  },
  async (args) => json(getDecisions(getDecisionsInputSchema.parse(args))),
);

server.registerTool(
  'build_project_context_pack',
  {
    title: 'Build project context pack',
    description: 'Build a context pack and add mandatory top-level sources[] for the included records.',
    inputSchema: {
      query: z.string(),
      taskId: z.string().optional(),
      profile: z.enum(['default', 'local-model']).optional(),
      workflow: z.enum(['fast', 'standard', 'strict']).optional(),
      maxTokens: z.number().int().min(500).optional(),
      includeArchive: z.boolean().default(false),
      explain: z.boolean().default(false),
      modules: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]),
      changedFiles: z.array(z.string()).default([]),
    },
  },
  async (args) => json(buildProjectContextPack(buildProjectContextPackInputSchema.parse(args))),
);

server.registerTool(
  'propose_context_update',
  {
    title: 'Propose context update',
    description: 'Create a reviewable draft Markdown project context record with YAML frontmatter.',
    inputSchema: {
      type: z.enum(['project', 'integration', 'data_entity', 'api', 'decision', 'requirement', 'open_question', 'meeting_draft', 'source', 'source_chunk', 'acceptance_check']),
      title: z.string(),
      summary: z.string(),
      modules: z.array(z.string()).default(['doc']),
      tags: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]),
      sourceRefs: z.array(z.string()).default([]),
      status: z.string().default('draft'),
      frontmatter: z.record(z.string(), z.unknown()).default({}),
      sections: z.array(z.object({
        heading: z.string(),
        body: z.string(),
      })).default([]),
    },
  },
  async (args) => json(proposeContextUpdate(proposeContextUpdateInputSchema.parse(args))),
);

server.registerTool(
  'find_requirements',
  {
    title: 'Find analyst requirements',
    description: 'Find analyst-facing requirement records with mandatory sources[]. Draft records are included by default.',
    inputSchema: {
      query: z.string().optional(),
      requirementKeys: z.array(z.string()).default([]),
      areas: z.array(z.string()).default([]),
      sourceIds: z.array(z.string()).default([]),
      chunkIds: z.array(z.string()).default([]),
      taskIds: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(20),
    },
  },
  async (args) => json(findRequirements(findRequirementsInputSchema.parse(args))),
);

server.registerTool(
  'find_source_chunks',
  {
    title: 'Find analyst source chunks',
    description: 'Find source chunk records by source id, chunk id, topic, area, or information type.',
    inputSchema: {
      query: z.string().optional(),
      sourceIds: z.array(z.string()).default([]),
      chunkIds: z.array(z.string()).default([]),
      topics: z.array(z.string()).default([]),
      systemAreas: z.array(z.string()).default([]),
      informationTypes: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(20),
    },
  },
  async (args) => json(findSourceChunks(findSourceChunksInputSchema.parse(args))),
);

server.registerTool(
  'get_open_questions',
  {
    title: 'Get analyst open questions',
    description: 'Find analyst open questions with mandatory sources[]. Draft records are included by default.',
    inputSchema: {
      query: z.string().optional(),
      questionKinds: z.array(z.string()).default([]),
      owners: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(20),
    },
  },
  async (args) => json(getOpenQuestions(getOpenQuestionsInputSchema.parse(args))),
);

server.registerTool(
  'get_conflicts',
  {
    title: 'Get analyst conflicts',
    description: 'Find analyst conflict records with mandatory sources[]. Draft records are included by default.',
    inputSchema: {
      query: z.string().optional(),
      statuses: z.array(z.string()).default([]),
      modules: z.array(z.string()).default([]),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(20),
    },
  },
  async (args) => json(getConflicts(getOpenQuestionsInputSchema.parse({
    ...args,
    questionKinds: ['conflict'],
  }))),
);

server.registerTool(
  'trace_requirement',
  {
    title: 'Trace requirement',
    description: 'Trace a requirement to source records, chunks, linked tasks, and acceptance checks.',
    inputSchema: {
      requirementKey: z.string().optional(),
      query: z.string().optional(),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(5),
    },
  },
  async (args) => json(traceRequirement(traceRequirementInputSchema.parse(args))),
);

server.registerTool(
  'build_analyst_context_pack',
  {
    title: 'Build analyst context pack',
    description: 'Return requirements, source chunks, open questions, decisions, and sources for an analyst query.',
    inputSchema: {
      query: z.string(),
      includeDrafts: z.boolean().default(true),
      includeArchive: z.boolean().default(false),
      limit: z.number().default(10),
    },
  },
  async (args) => json(buildAnalystContextPack(buildAnalystContextPackInputSchema.parse(args))),
);

server.registerTool(
  'analyst_delta_to_backlog',
  {
    title: 'Analyst delta to backlog',
    description: 'Convert matched analyst requirements or open questions into draft backlog proposals.',
    inputSchema: {
      query: z.string(),
      apply: z.boolean().default(false),
      force: z.boolean().default(false),
      limit: z.number().default(5),
    },
  },
  async (args) => json(analystDeltaToBacklog(analystDeltaToBacklogInputSchema.parse(args))),
);

server.registerTool(
  'propose_analyst_source',
  {
    title: 'Propose analyst source',
    description: 'Create or preview a draft analyst source record for a new incoming document or transcript.',
    inputSchema: {
      sourceId: z.string().optional(),
      title: z.string(),
      summary: z.string(),
      sourcePath: z.string().optional(),
      sourceKind: z.string().default('document'),
      tags: z.array(z.string()).default([]),
      sourceRefs: z.array(z.string()).default([]),
      apply: z.boolean().default(false),
    },
  },
  async (args) => json(proposeAnalystSource(proposeAnalystSourceInputSchema.parse(args))),
);

server.registerTool(
  'import_rp_database',
  {
    title: 'Import RP database',
    description: 'Import curated RP source archive database knowledge into reviewable project-context drafts. Raw files are linked, not copied into active records.',
    inputSchema: {
      path: z.string().default(defaultRpArchivePath),
      apply: z.boolean().default(false),
      limit: z.number().optional(),
      includeSources: z.boolean().default(true),
      includeChunks: z.boolean().default(true),
      includeTraceability: z.boolean().default(true),
      includeDecisions: z.boolean().default(true),
    },
  },
  async (args) => json(importRpDatabase(importRpDatabaseInputSchema.parse(args))),
);

server.registerTool(
  'plan_confluence_publish',
  {
    title: 'Plan Project Context publication to Confluence',
    description: 'Create a non-writing publication plan from explicit active Project Context records. Every target is checked against the project-bound Confluence root subtree.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      operation: z.enum(['update', 'create-child']).default('update'),
      targetPageId: z.string().regex(/^\d+$/).optional(),
      parentPageId: z.string().regex(/^\d+$/).optional(),
      title: z.string().trim().min(1).max(255).optional(),
      recordPaths: z.array(z.string().min(1)).min(1).max(100),
    },
  },
  async (args) => json(await planConfluencePublish(planConfluencePublishInputSchema.parse(args))),
);

server.registerTool(
  'apply_confluence_publish',
  {
    title: 'Apply confirmed Project Context publication to Confluence',
    description: 'Write a previously reviewed plan only after explicit human approval. Requires the exact confirmation digest and revalidates root ancestry, record digests, permissions, and remote page version.',
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      planDigest: z.string().regex(/^[a-f0-9]{64}$/),
      confirmDigest: z.string().regex(/^[a-f0-9]{64}$/),
      approvedBy: z.string().trim().min(1).max(120),
    },
  },
  async (args) => json(await applyConfluencePublish(applyConfluencePublishInputSchema.parse(args))),
);

server.registerTool(
  'get_confluence_publish_plan',
  {
    title: 'Get Confluence publication plan status',
    description: 'Return safe metadata for a stored Confluence publication plan without returning the generated page body or any credential.',
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      planDigest: z.string().regex(/^[a-f0-9]{64}$/),
    },
  },
  async ({ planDigest }) => json(getConfluencePublishPlan(planDigest)),
);

server.registerTool(
  'get_backlog',
  {
    title: `Get ${projectName} backlog`,
    description: 'Return active backlog records with status, priority, dependencies, acceptance criteria, and checks.',
    inputSchema: {
      status: z.string().optional(),
      modules: z.array(z.string()).optional(),
      includeDone: z.boolean().default(false),
      limit: z.number().default(50),
    },
  },
  async (args) => json(getBacklog(args)),
);

server.registerTool(
  'pick_next_task',
  {
    title: 'Pick next backlog task',
    description: 'Select the best ready/open backlog task for an agent and return a suggested implementation prompt.',
    inputSchema: {
      query: z.string().optional(),
      modules: z.array(z.string()).optional(),
    },
  },
  async (args) => json(pickNextBacklogTask(args)),
);

server.registerTool(
  'get_backlog_dependency_graph',
  {
    title: 'Get backlog dependency graph',
    description: 'Return active backlog nodes, dependency edges, blockers, missing dependencies, and cycles.',
    inputSchema: {
      modules: z.array(z.string()).optional(),
      includeDone: z.boolean().default(true),
    },
  },
  async (args) => json(getBacklogDependencyGraph(args)),
);

server.registerTool(
  'task_from_backlog',
  {
    title: 'Create task from backlog',
    description: 'Convert a backlog record into a task contract preview, draft, or confirmed task.',
    inputSchema: {
      backlogId: z.string(),
      mode: z.enum(['preview', 'draft', 'confirm']).default('preview'),
    },
  },
  async (args) => json(taskFromBacklog(taskFromBacklogInputSchema.parse(args))),
);

server.registerTool(
  'propose_backlog_item',
  {
    title: 'Propose backlog item',
    description: 'Validate an incoming backlog idea and create a reviewable draft backlog record.',
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      priority: z.string().default('P2'),
      agentSize: z.enum(['small', 'medium', 'large']).default('medium'),
      status: z.enum(['proposed', 'open', 'ready', 'blocked']).default('proposed'),
      modules: z.array(z.string()).optional(),
      tags: z.array(z.string()).default([]),
      sourceRefs: z.array(z.string()).default([]),
      dependsOn: z.array(z.string()).default([]),
      files: z.array(z.string()).default([]),
      acceptanceCriteria: z.array(z.string()).default([]),
      checks: z.array(z.string()).default([]),
      force: z.boolean().default(false),
      dryRun: z.boolean().default(false),
    },
  },
  async (args) => json(proposeBacklogItem(proposeBacklogItemInputSchema.parse(args))),
);

server.registerTool(
  'confirm_backlog_item',
  {
    title: 'Confirm backlog item',
    description: 'Promote a reviewed draft backlog proposal into active backlog with approval metadata.',
    inputSchema: {
      backlogId: z.string(),
      approvedBy: z.string(),
      status: z.enum(['open', 'ready', 'blocked']).default('open'),
      dryRun: z.boolean().default(false),
    },
  },
  async (args) => json(confirmBacklogItem(confirmBacklogItemInputSchema.parse(args))),
);

server.registerTool(
  'transition_backlog_item',
  {
    title: 'Transition backlog item',
    description: 'Apply a validated lifecycle transition to an active backlog item.',
    inputSchema: {
      backlogId: z.string(),
      status: z.enum(['open', 'ready', 'blocked', 'in_progress', 'done', 'cancelled']),
      reason: z.string().optional(),
      blockedBy: z.array(z.string()).default([]),
      evidenceId: z.string().optional(),
      dryRun: z.boolean().default(false),
    },
  },
  async (args) => json(transitionBacklogItem(transitionBacklogItemInputSchema.parse(args))),
);

server.registerTool(
  'spec_to_backlog',
  {
    title: 'Spec to backlog',
    description: 'Scan specification files for open points and propose draft backlog items; dry-run by default.',
    inputSchema: {
      paths: z.array(z.string()).default([]),
      limit: z.number().default(20),
      apply: z.boolean().default(false),
      force: z.boolean().default(false),
    },
  },
  async (args) => json(specToBacklog(specToBacklogInputSchema.parse(args))),
);

server.registerTool(
  'get_verification_plan',
  {
    title: 'Get verification plan',
    description: 'Build required and optional checks for a task, backlog item, context record, or query.',
    inputSchema: {
      id: z.string().optional(),
      query: z.string().optional(),
    },
  },
  async (args) => json(getVerificationPlan(verificationPlanInputSchema.parse(args))),
);

server.registerTool(
  'record_verification_evidence',
  {
    title: 'Record verification evidence',
    description: 'Record executed or skipped verification checks. This does not execute shell commands.',
    inputSchema: {
      targetId: z.string(),
      targetType: z.enum(['task', 'backlog', 'record']).default('task'),
      summary: z.string(),
      checks: z.array(z.object({
        command: z.string(),
        status: z.enum(['passed', 'failed', 'skipped', 'not_run']),
        reason: z.string().optional(),
        durationMs: z.number().optional(),
      })).default([]),
      changedFiles: z.array(z.string()).default([]),
      modules: z.array(z.string()).optional(),
      recordedBy: z.string().default('agent'),
    },
  },
  async (args) => json(recordVerificationEvidence(verificationEvidenceInputSchema.parse(args))),
);

server.registerTool(
  'list_verification_evidence',
  {
    title: 'List verification evidence',
    description: 'List recorded verification evidence, optionally filtered by target id.',
    inputSchema: {
      targetId: z.string().optional(),
      limit: z.number().default(20),
    },
  },
  async (args) => json(listVerificationEvidence(listVerificationEvidenceInputSchema.parse(args))),
);

server.registerTool(
  'promote_draft',
  {
    title: 'Promote reviewed draft',
    description: 'Dry-run or apply promotion of a reviewed draft record into active context.',
    inputSchema: {
      recordId: z.string(),
      apply: z.boolean().default(false),
      approvedBy: z.string().optional(),
    },
  },
  async (args) => json(promoteDraft(promoteDraftInputSchema.parse(args))),
);

server.registerTool(
  'promote_drafts_batch',
  {
    title: 'Promote reviewed drafts in batch',
    description: 'Dry-run or apply promotion of matching reviewed draft records into active context.',
    inputSchema: {
      recordIds: z.array(z.string()).default([]),
      types: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
      statuses: z.array(z.string()).default(['draft']),
      query: z.string().optional(),
      limit: z.number().optional(),
      all: z.boolean().default(false),
      apply: z.boolean().default(false),
      approvedBy: z.string().optional(),
    },
  },
  async (args) => json(promoteDraftsBatch(promoteDraftsBatchInputSchema.parse(args))),
);

server.registerTool(
  'context_doctor',
  {
    title: 'Run context doctor',
    description: 'Diagnose context-router wiring, hooks, index, backlog, and lint health.',
    inputSchema: {
      fixDryRun: z.boolean().default(false),
    },
  },
  async ({ fixDryRun }) => json(contextDoctor({ fixDryRun })),
);

server.registerTool(
  'current_truth',
  {
    title: 'Audit current truth',
    description: 'Audit or apply active-context current-truth hygiene for stale workflow history.',
    inputSchema: {
      apply: z.boolean().default(false),
      approvedBy: z.string().optional(),
      archiveAttention: z.boolean().default(false),
      allAttention: z.boolean().default(false),
      recordIds: z.array(z.string()).default([]),
      attentionTypes: z.array(z.string()).default([]),
      attentionStatuses: z.array(z.string()).default([]),
      attentionMinAgeDays: z.number().optional(),
      doneTaskDays: z.number().optional(),
      historyDays: z.number().optional(),
      staleWorkDays: z.number().optional(),
      limit: z.number().default(50),
    },
  },
  async (args) => json(currentTruthAudit(currentTruthInputSchema.parse(args))),
);

server.registerTool(
  'get_project_snapshot',
  {
    title: `Get ${projectName} project snapshot`,
    description: 'Return a compact live snapshot of project purpose, modules, roles, flows, backlog, context health, and dirty state.',
    inputSchema: {
      includeDirty: z.boolean().default(true),
      includeBacklog: z.boolean().default(true),
    },
  },
  async (args) => json(getProjectSnapshot(args)),
);

server.registerTool(
  'find_existing_capability',
  {
    title: 'Find existing capability',
    description: 'Search existing components, hooks, DTOs, mappers, policies, utilities, and test helpers.',
    inputSchema: {
      query: z.string(),
      modules: z.array(z.string()).optional(),
    },
  },
  async ({ query, modules }) => json(findExistingCapability(query, modules)),
);

server.registerTool(
  'find_existing_capabilities',
  {
    title: 'Find existing capabilities in batch',
    description: 'Search existing components, hooks, DTOs, mappers, policies, utilities, and test helpers for multiple queries in one call.',
    inputSchema: {
      queries: z.array(z.object({
        query: z.string(),
        modules: z.array(z.string()).optional(),
      })),
    },
  },
  async (args) => json(findExistingCapabilities(args)),
);

server.registerTool(
  'review_diff_for_refactor',
  {
    title: 'Review diff for refactor',
    description: 'Analyze the current diff for low-risk local or deferred broad refactor candidates.',
    inputSchema: {
      taskId: z.string().optional(),
    },
  },
  async ({ taskId }) => json(reviewDiffForRefactor(taskId)),
);

server.registerTool(
  'finalize_work',
  {
    title: 'Finalize work',
    description: 'Create or reuse a task-linked draft run summary; taskless git-only work is skipped.',
    inputSchema: {
      taskId: z.string().optional(),
      summary: z.string(),
      changedFiles: z.array(z.string()).default([]),
      tests: z.array(z.object({ command: z.string(), status: z.string() })).default([]),
      skippedChecks: z.array(z.object({ command: z.string(), reason: z.string() })).default([]),
      decisions: z.array(z.string()).default([]),
      result: z.string().default('implemented'),
      autoFill: z.boolean().default(false),
    },
  },
  async (args) => json(finalizeWork(finalizeWorkInputSchema.parse(args))),
);

server.registerTool(
  'propose_cleanup',
  {
    title: 'Propose cleanup',
    description: 'Return retention cleanup candidates without applying changes.',
    inputSchema: {
      ci: z.boolean().default(false),
    },
  },
  async ({ ci }) => json(proposeCleanup(ci)),
);

server.registerTool(
  'archive_records',
  {
    title: 'Archive records',
    description: 'Archive records by explicit id only.',
    inputSchema: {
      ids: z.array(z.string()),
    },
  },
  async ({ ids }) => json(archiveRecords(ids)),
);

server.registerTool(
  'record_decision',
  {
    title: 'Record decision draft',
    description: 'Create a decision draft for human review.',
    inputSchema: {
      title: z.string(),
      context: z.string(),
      decision: z.string(),
      consequences: z.array(z.string()).default([]),
      sourceTask: z.string().optional(),
      modules: z.array(z.string()).default([]),
      tags: z.array(z.string()).default([]),
    },
  },
  async (args) => json(recordDecision(decisionInputSchema.parse(args))),
);

configureRegisteredTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

type RegisteredToolWithExecution = {
  execution?: unknown;
  outputSchema?: unknown;
  disable?: () => void;
};

type McpServerWithRegisteredTools = {
  _registeredTools?: Record<string, RegisteredToolWithExecution>;
};

function configureRegisteredTools(mcpServer: McpServer): void {
  const registeredTools = (mcpServer as unknown as McpServerWithRegisteredTools)._registeredTools;
  if (!registeredTools) {
    return;
  }

  // Context-router tools are synchronous and do not use MCP task augmentation. The SDK
  // emits a default task metadata block that some Codex builds do not cache.
  for (const [name, tool] of Object.entries(registeredTools)) {
    delete tool.execution;
    tool.outputSchema = structuredJsonOutputSchema;
    if (!toolEnabledForProfile(activeToolProfile, name)) tool.disable?.();
  }
}

function json(data: unknown) {
  const structuredContent = withBrand(data) as Record<string, unknown>;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
  };
}

function resourceJson(uri: URL, data: unknown) {
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(withBrand(data)),
      },
    ],
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
