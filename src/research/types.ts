import { z } from 'zod';
import { generatedIdPattern } from '../storage/record-types.js';

const text = z.string().trim().min(1);
const texts = z.array(text);
export const researchIdSchema = z.string().regex(generatedIdPattern('RESEARCH'));
export const researchStatusSchema = z.enum(['idea', 'exploring', 'paused', 'ready', 'handed_off', 'closed']);
export const researchEntrySchema = z.object({
  sequence: z.number().int().positive(),
  at: text,
  kind: z.enum(['idea', 'discussion', 'finding', 'decision', 'status', 'handoff']),
  content: text,
  source_refs: texts,
  request_key: text,
  request_hash: text,
  open_questions: texts.optional(),
  from: researchStatusSchema.optional(),
  to: researchStatusSchema.optional(),
  conclusion: z.string().optional(),
  backlog_id: text.optional(),
});
export const researchRecordSchema = z.object({
  id: researchIdSchema,
  type: z.literal('research'),
  title: text,
  status: researchStatusSchema,
  question: text,
  conclusion: z.string(),
  open_questions: texts,
  revision: z.number().int().positive(),
  created_at: text,
  updated_at: text,
  modules: texts,
  files: texts,
  tags: texts,
  source_refs: texts,
  retention: z.literal('keep'),
  entries: z.array(researchEntrySchema).min(1),
});
export type ResearchRecord = z.infer<typeof researchRecordSchema>;
export type ResearchEntry = z.infer<typeof researchEntrySchema>;
export type ResearchStatus = z.infer<typeof researchStatusSchema>;

export const createResearchInputSchema = z.object({
  title: text,
  question: text,
  openQuestions: texts.default([]),
  sourceRefs: texts.default([]),
  modules: texts.default([]),
  tags: texts.default([]),
});
export const listResearchInputSchema = z.object({
  statuses: z.array(researchStatusSchema).default([]),
  modules: texts.default([]),
  query: z.string().default(''),
  includeClosed: z.boolean().default(false),
  limit: z.number().int().min(1).max(200).default(50),
});
export const getResearchInputSchema = z.object({ researchId: researchIdSchema });
const mutationFields = {
  researchId: researchIdSchema,
  expectedRevision: z.number().int().positive(),
  requestKey: text.max(100).regex(/^[a-zA-Z0-9_-]+$/),
};
export const appendResearchInputSchema = z.object({
  ...mutationFields,
  kind: z.enum(['discussion', 'finding', 'decision']).default('discussion'),
  content: text,
  sourceRefs: texts.default([]),
  openQuestions: texts.optional(),
});
export const transitionResearchInputSchema = z.object({
  ...mutationFields,
  status: z.enum(['exploring', 'paused', 'ready', 'closed']),
  reason: text,
  conclusion: text.optional(),
});
export const researchToBacklogInputSchema = z.object({
  ...mutationFields,
  item: z.object({
    title: text,
    description: z.string().default(''),
    priority: z.string().regex(/^P\d$/).default('P2'),
    agentSize: z.enum(['small', 'medium', 'large']).default('medium'),
    modules: texts.optional(),
    tags: texts.default([]),
    sourceRefs: texts.default([]),
    dependsOn: texts.default([]),
    files: texts.default([]),
    acceptanceCriteria: texts.min(1),
    checks: texts.min(1),
  }),
  dryRun: z.boolean().default(true),
});
