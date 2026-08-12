import { readFileSync } from 'node:fs';
import fg from 'fast-glob';
import { z } from 'zod';
import { proposeBacklogItem } from '../backlog/backlog.js';
import { repoPaths } from '../storage/repo.js';
import { inferModulesFromQuery } from '../storage/inference.js';
import { classifyFileReference } from '../storage/file-references.js';
import { contextCliCommand, loadProjectConfig } from '../storage/config.js';

export const specToBacklogInputSchema = z.object({
  paths: z.array(z.string()).default([]),
  limit: z.number().default(20),
  apply: z.boolean().default(false),
  force: z.boolean().default(false),
});

export type SpecBacklogCandidate = {
  title: string;
  description: string;
  sourceRef: string;
  modules: string[];
  tags: string[];
  proposal: ReturnType<typeof proposeBacklogItem>;
};

export function specToBacklog(input: z.input<typeof specToBacklogInputSchema> = {}): {
  status: 'DRY_RUN' | 'DRAFTS_CREATED';
  candidates: SpecBacklogCandidate[];
  count: number;
} {
  const parsed = specToBacklogInputSchema.parse(input);
  const paths = repoPaths();
  const config = loadProjectConfig();
  const sourcePaths = parsed.paths.length > 0 ? parsed.paths : (config.specifications.current?.files ?? []);
  const files = fg.sync(sourcePaths, { cwd: paths.root, absolute: false, onlyFiles: true });
  const candidates: SpecBacklogCandidate[] = [];

  for (const file of files) {
    const reference = classifyFileReference(file);
    if (reference.kind !== 'file') continue;
    const lines = readFileSync(reference.absolutePath, 'utf8').split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (candidates.length >= parsed.limit) break;
      const cleaned = cleanSpecLine(line);
      if (!cleaned || !isBacklogCandidateLine(cleaned)) continue;
      const title = titleFromSpecLine(cleaned);
      const modules = inferModulesFromQuery(`${title} ${cleaned}`);
      const proposal = proposeBacklogItem({
        title,
        description: cleaned,
        priority: 'P2',
        agentSize: 'medium',
        status: 'proposed',
        modules,
        tags: ['specification', 'from-spec'],
        sourceRefs: [`${file}:${index + 1}`],
        dependsOn: [],
        files: [file],
        acceptanceCriteria: ['Spec-derived open point is resolved and reflected in project context.'],
        checks: [contextCliCommand(config, 'lint')],
        force: parsed.force,
        dryRun: !parsed.apply,
      });
      candidates.push({
        title,
        description: cleaned,
        sourceRef: `${file}:${index + 1}`,
        modules,
        tags: ['specification', 'from-spec'],
        proposal,
      });
    }
    if (candidates.length >= parsed.limit) break;
  }

  return {
    status: parsed.apply ? 'DRAFTS_CREATED' : 'DRY_RUN',
    candidates,
    count: candidates.length,
  };
}

function isBacklogCandidateLine(line: string): boolean {
  return /todo|fixme|open question|next step|not done|tbd|не реализ|не готов|открыт|следующ|вопрос|\[ \]/i.test(line);
}

function cleanSpecLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/^\[ \]\s+/, '')
    .replace(/^#+\s+/, '')
    .trim();
}

function titleFromSpecLine(line: string): string {
  const withoutMarker = line
    .replace(/^(todo|fixme|open question|next step|tbd)\s*[:—-]\s*/i, '')
    .replace(/^(открытый вопрос|следующий шаг|вопрос)\s*[:—-]\s*/i, '')
    .trim();
  const title = withoutMarker.length > 110 ? `${withoutMarker.slice(0, 107)}...` : withoutMarker;
  return title || 'Spec-derived backlog item';
}
