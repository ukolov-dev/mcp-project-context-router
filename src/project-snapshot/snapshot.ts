import { execFileSync } from 'node:child_process';
import { getContextBrand } from '../brand.js';
import { getBacklog } from '../backlog/backlog.js';
import { contextDoctor } from '../doctor/doctor.js';
import { loadProjectConfig } from '../storage/config.js';
import { repoPaths } from '../storage/repo.js';

export type ProjectSnapshotInput = {
  includeDirty?: boolean;
  includeBacklog?: boolean;
};

const defaultFlows = [
  'Validate or derive a task contract before implementation.',
  'Use the configured active specification route for product contract decisions.',
  'Pick backlog work through context-router backlog tools/resources.',
  'Build context pack and run reuse scan before new reusable implementation.',
  'Run applicable verification, record evidence, review refactor risk, finalize work.',
];

export function getProjectSnapshot(input: ProjectSnapshotInput = {}) {
  const includeDirty = input.includeDirty ?? true;
  const includeBacklog = input.includeBacklog ?? true;
  const config = loadProjectConfig();
  const doctor = contextDoctor();
  const backlog = includeBacklog ? getBacklog({ status: 'ready,open', limit: 20 }) : undefined;

  return {
    brand: getContextBrand(),
    project: {
      name: config.project.name,
      purpose: config.project.purpose ?? 'Project purpose is not configured.',
      sourceOfTruth: {
        context: '.project-context/active/**/*.md',
        specification: config.specifications.current?.runbook ?? 'No active specification runbook configured.',
        index: '.project-context/indexes/context.sqlite is a rebuildable cache, not source of truth.',
      },
    },
    modules: Object.entries(config.modules).map(([name, module]) => ({
      name,
      path: module.path,
    })),
    roles: config.project.roles,
    flows: config.project.flows.length > 0 ? config.project.flows : defaultFlows,
    contextRouter: {
      doctorStatus: doctor.status,
      warnings: doctor.diagnostics.filter((item) => item.status === 'warn').map((item) => item.message),
      failures: doctor.diagnostics.filter((item) => item.status === 'fail').map((item) => item.message),
      commands: Object.values(config.commands),
    },
    backlog: backlog ? {
      readyOrOpen: backlog.items.length,
      next: backlog.items.find((item) => item.blockedBy.length === 0) ?? null,
    } : undefined,
    dirty: includeDirty ? dirtySummary() : undefined,
  };
}

function dirtySummary() {
  const paths = repoPaths();
  try {
    const lines = execFileSync('git', ['status', '--short'], { cwd: paths.root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean);
    const byArea = new Map<string, number>();
    for (const line of lines) {
      const file = line.slice(3).trim();
      const area = file.startsWith('.project-context/')
        ? '.project-context'
        : file.split('/')[0] || '<root>';
      byArea.set(area, (byArea.get(area) ?? 0) + 1);
    }
    return {
      total: lines.length,
      byArea: Object.fromEntries([...byArea.entries()].sort(([a], [b]) => a.localeCompare(b))),
      sample: lines.slice(0, 12),
    };
  } catch {
    return {
      total: 0,
      byArea: {},
      sample: [],
      warning: 'git status is unavailable.',
    };
  }
}
