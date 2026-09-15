import { z } from 'zod';

export const executionIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
export const executionDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const executionStatusSchema = z.enum(['confirmed', 'implementing', 'verifying', 'reviewing', 'ready_to_merge', 'failed']);
const identitySchema = z.string().trim().min(1).max(200);

export const executionCheckSchema = z.object({
  command: z.string().trim().min(1),
  status: z.enum(['passed', 'failed', 'skipped', 'not_run']),
  reason: z.string().optional(),
  durationMs: z.number().finite().nonnegative().optional(),
});

export const agentRunSchema = z.object({
  id: executionIdSchema,
  taskId: executionIdSchema,
  taskDigest: executionDigestSchema,
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  branch: z.string().nullable(),
  worktree: z.literal('.'),
  executor: identitySchema,
  attempt: z.number().int().positive(),
  status: executionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  result: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  requiredChecks: z.array(z.string().min(1)),
  acceptanceCriteria: z.array(z.object({ id: executionIdSchema, text: z.string().min(1) })),
  evidenceIds: z.array(executionIdSchema),
  evidenceDigests: z.record(executionIdSchema, executionDigestSchema).default({}),
  reviewId: executionIdSchema.optional(),
  history: z.array(z.object({
    from: executionStatusSchema.nullable(),
    status: executionStatusSchema,
    at: z.string().datetime(),
    reason: z.string().optional(),
    evidenceIds: z.array(executionIdSchema).optional(),
    reviewId: executionIdSchema.optional(),
  })),
});
export type AgentRun = z.infer<typeof agentRunSchema>;
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;

export const acceptanceReviewSchema = z.object({
  id: executionIdSchema,
  runId: executionIdSchema,
  taskId: executionIdSchema,
  taskDigest: executionDigestSchema,
  codeDigest: executionDigestSchema,
  reviewer: identitySchema,
  executor: identitySchema,
  runRevision: z.number().int().nonnegative(),
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  verdict: z.enum(['passed', 'failed']),
  criteria: z.array(z.object({
    criterionId: executionIdSchema,
    status: z.enum(['passed', 'failed']),
    implementationEvidence: z.string().trim().min(1),
    verificationEvidence: z.string().trim().min(1),
    risk: z.string().optional(),
  })),
  findings: z.array(z.string()),
  evidenceIds: z.array(executionIdSchema),
  createdAt: z.string().datetime(),
});
export type AcceptanceReview = z.infer<typeof acceptanceReviewSchema>;

export const runVerificationEvidenceSchema = z.object({
  id: executionIdSchema,
  runId: executionIdSchema,
  taskId: executionIdSchema,
  taskDigest: executionDigestSchema,
  codeDigest: executionDigestSchema,
  baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  headCommit: z.string().regex(/^[a-f0-9]{40,64}$/),
  summary: z.string().min(1),
  checks: z.array(executionCheckSchema),
  createdAt: z.string().datetime(),
});
export type RunVerificationEvidence = z.infer<typeof runVerificationEvidenceSchema>;

export const createAgentRunInputSchema = z.object({
  taskId: executionIdSchema,
  executor: identitySchema,
  baseCommit: z.string().trim().min(1).max(200).optional(),
});
export const listAgentRunsInputSchema = z.object({ taskId: executionIdSchema.optional() });
export const transitionAgentRunInputSchema = z.object({
  runId: executionIdSchema,
  status: executionStatusSchema,
  reason: z.string().trim().min(1).optional(),
  evidenceIds: z.array(executionIdSchema).optional(),
  reviewId: executionIdSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});
export const recordRunVerificationInputSchema = z.object({
  runId: executionIdSchema,
  expectedCodeDigest: executionDigestSchema,
  checks: z.array(executionCheckSchema).min(1),
  summary: z.string().trim().min(1),
});

export type CodeSnapshot = {
  codeDigest: string;
  baseCommit: string;
  headCommit: string;
  changedFiles: string[];
  diff: string;
};
