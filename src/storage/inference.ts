import { loadProjectConfig, type ProjectConfig, type ProjectModuleConfig } from './config.js';

export type ModuleInferenceInput = {
  query?: string;
  modules?: string[];
  files?: string[];
  changedFiles?: string[];
  fallback?: string[];
  config?: ProjectConfig;
};

export function inferModulesFromSignals(input: ModuleInferenceInput): string[] {
  const config = input.config ?? loadProjectConfig();
  const modules = new Set<string>();
  for (const module of input.modules ?? []) {
    if (module) modules.add(module);
  }
  for (const file of [...(input.files ?? []), ...(input.changedFiles ?? [])]) {
    for (const module of inferModulesFromPath(file, config)) modules.add(module);
  }
  const queryModules = inferModulesFromQueryText(input.query ?? '', config);
  const documentationModules = new Set(config.routing.documentationModules);
  const hasStrongSignal = [...modules].some((module) => !documentationModules.has(module));
  if (modules.size > 0 && (hasStrongSignal || queryModules.length === 0)) return [...modules];
  for (const module of queryModules) modules.add(module);
  if (modules.size > 0) return [...modules];
  return input.fallback ?? config.routing.defaultModules;
}

export function inferModulesFromPath(path: string, config = loadProjectConfig()): string[] {
  const normalized = normalizePath(path);
  if (!normalized) return [];
  const directMatches = Object.entries(config.modules)
    .filter(([, module]) => matchesPathPrefix(normalized, normalizePath(module.path)))
    .sort(([, left], [, right]) => normalizePath(right.path).length - normalizePath(left.path).length);
  if (directMatches.length > 0) {
    const longestPathLength = normalizePath(directMatches[0]?.[1].path ?? '').length;
    return directMatches
      .filter(([, module]) => normalizePath(module.path).length === longestPathLength)
      .map(([name]) => name);
  }

  return Object.entries(config.modules)
    .filter(([, module]) => module.sourceGlobs.some((glob) => sourceGlobMayMatchPath(glob, normalized)))
    .map(([name]) => name);
}

export function inferModulesFromQuery(query: string, config = loadProjectConfig()): string[] {
  return inferModulesFromSignals({ query, config });
}

export function sourceGlobsForModule(module: ProjectModuleConfig): string[] {
  if (module.sourceGlobs.length > 0) return module.sourceGlobs;
  const path = normalizePath(module.path);
  if (!path) return [];
  return [`${path}/**/*.{ts,tsx,js,jsx,mjs,cjs,java,kt,kts,go,rs,py,rb,php,cs,sql,xml,yaml,yml,md}`];
}

export function sourceGlobMayMatchPath(glob: string, path: string): boolean {
  const normalizedGlob = normalizePath(glob);
  const normalizedPath = normalizePath(path);
  if (!normalizedGlob || !normalizedPath) return false;
  const dynamicIndex = normalizedGlob.search(/[*?{[(]/);
  if (dynamicIndex < 0) return normalizedPath === normalizedGlob;
  const staticPart = normalizedGlob.slice(0, dynamicIndex);
  const slashIndex = staticPart.lastIndexOf('/');
  const prefix = slashIndex >= 0 ? staticPart.slice(0, slashIndex) : '';
  return prefix ? matchesPathPrefix(normalizedPath, prefix) : true;
}

function inferModulesFromQueryText(query: string, config: ProjectConfig): string[] {
  const signal = normalizeSignal(query);
  if (!signal) return [];
  return Object.entries(config.modules)
    .filter(([name, module]) => moduleQuerySignals(name, module).some((candidate) => matchesQuerySignal(signal, candidate)))
    .map(([name]) => name);
}

function moduleQuerySignals(name: string, module: ProjectModuleConfig): string[] {
  const pathSegments = normalizePath(module.path).split('/').filter(Boolean);
  return [...new Set([
    name,
    pathSegments.at(-1) ?? '',
    ...module.aliases,
  ].map(normalizeSignal).filter(Boolean))];
}

function matchesQuerySignal(signal: string, candidate: string): boolean {
  if (!candidate) return false;
  if (candidate.length > 3 || /[^\p{L}\p{N}_-]/u.test(candidate)) return signal.includes(candidate);
  return signal.split(/[^\p{L}\p{N}_-]+/u).includes(candidate);
}

function matchesPathPrefix(path: string, prefix: string): boolean {
  if (!prefix || prefix === '.') return true;
  return path === prefix || path.startsWith(`${prefix}/`) || path.includes(`/${prefix}/`);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}

function normalizeSignal(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}
