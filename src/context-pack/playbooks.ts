import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import type { ProjectConfig } from '../storage/config.js';
import { classifyFileReference } from '../storage/file-references.js';
import { repoPaths } from '../storage/repo.js';

export type PlaybookDetail = {
  path: string;
  reason: string;
  estimatedTokens: number;
  required: boolean;
};

type PlaybookMetadata = {
  path: string;
  modules: string[];
  routing: 'core' | 'conditional';
  triggers: string[];
  required: boolean;
};

export function selectPlaybooks(
  modules: string[],
  query: string,
  files: string[],
  config: ProjectConfig,
): { details: PlaybookDetail[]; warnings: string[] } {
  const configured = new Set<string>(['AGENTS.md']);
  for (const module of modules) {
    for (const path of config.modules[module]?.playbooks ?? []) configured.add(path);
  }

  const candidates = new Set<string>([
    ...configured,
    ...discoverRepositoryPlaybooks(),
  ]);
  const signal = [query, ...files].join('\n').toLowerCase();
  const details: PlaybookDetail[] = [];
  const warnings: string[] = [];

  for (const path of candidates) {
    const metadata = readPlaybookMetadata(path);
    const isConfigured = configured.has(path);
    if (metadata && !metadata.modules.some((module) => modules.includes(module))) continue;

    const matchedTriggers = metadata?.routing === 'conditional'
      ? metadata.triggers.filter((trigger) => matchesTrigger(signal, trigger))
      : [];
    if (metadata?.routing === 'conditional' && matchedTriggers.length === 0) continue;
    if (!metadata && !isConfigured) continue;

    const reference = classifyFileReference(path);
    if (reference.kind === 'outside_repository') {
      warnings.push(`Ignored unsafe playbook path: ${path}.`);
      continue;
    }
    if (reference.kind !== 'file') {
      warnings.push(`Configured playbook is missing: ${path}.`);
    }
    const reason = metadata?.routing === 'conditional'
      ? `Matched playbook trigger(s): ${matchedTriggers.join(', ')}.`
      : metadata
        ? `Core playbook for module(s): ${metadata.modules.filter((module) => modules.includes(module)).join(', ')}.`
        : 'Configured module playbook (legacy routing).';
    details.push({
      path,
      reason,
      estimatedTokens: estimateFileTokens(reference.absolutePath),
      required: metadata?.required ?? isRequiredLegacyPlaybook(path),
    });
  }

  return { details, warnings };
}

export function allKnownPlaybookPaths(config: ProjectConfig): string[] {
  return [...new Set([
    ...Object.values(config.modules).flatMap((module) => module.playbooks),
    ...discoverRepositoryPlaybooks(),
  ])];
}

function discoverRepositoryPlaybooks(): string[] {
  const dir = resolve(repoPaths().root, 'playbooks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => `playbooks/${entry.name}`)
    .sort();
}

function readPlaybookMetadata(path: string): PlaybookMetadata | undefined {
  if (!path.startsWith('playbooks/')) return undefined;
  const reference = classifyFileReference(path);
  if (reference.kind !== 'file') return undefined;
  try {
    const text = readFileSync(reference.absolutePath, 'utf8');
    if (!text.startsWith('---\n')) return undefined;
    const end = text.indexOf('\n---\n', 4);
    if (end < 0) return undefined;
    const frontmatter = asObject(load(text.slice(4, end)));
    const modules = stringArray(frontmatter.modules);
    const routing = frontmatter.routing === 'conditional' ? 'conditional' : 'core';
    return {
      path,
      modules,
      routing,
      triggers: stringArray(frontmatter.triggers).map((trigger) => trigger.toLowerCase()),
      required: frontmatter.required !== false,
    };
  } catch {
    return undefined;
  }
}

function isRequiredLegacyPlaybook(path: string): boolean {
  return path === 'AGENTS.md' || path.endsWith('/AGENTS.md') || path.startsWith('playbooks/');
}

function matchesTrigger(signal: string, trigger: string): boolean {
  const normalized = trigger.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.length > 3 || /[^\p{L}\p{N}_-]/u.test(normalized)) return signal.includes(normalized);
  return signal.split(/[^\p{L}\p{N}_-]+/u).includes(normalized);
}

function estimateFileTokens(path: string): number {
  try {
    return Math.ceil(readFileSync(path).byteLength / 3);
  } catch {
    return 0;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
