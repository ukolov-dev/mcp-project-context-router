import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import fg from 'fast-glob';
import { loadProjectConfig, type ProjectConfig } from '../storage/config.js';
import { inferModulesFromPath, sourceGlobMayMatchPath, sourceGlobsForModule } from '../storage/inference.js';
import type { Capability, Endpoint } from '../storage/types.js';
import { repoPaths } from '../storage/repo.js';

export function isCapabilitySourcePath(filePath: string): boolean {
  const config = loadProjectConfig();
  return Object.values(config.modules)
    .flatMap(sourceGlobsForModule)
    .some((glob) => sourceGlobMayMatchPath(glob, filePath));
}

export function inferModule(filePath: string): string {
  return inferModulesFromPath(filePath)[0] ?? 'unknown';
}

export function discoverCapabilities(): { capabilities: Capability[]; endpoints: Endpoint[]; sourceFingerprint: string } {
  const paths = repoPaths();
  const files = capabilitySourceFiles();
  const capabilities: Capability[] = [];
  const endpoints: Endpoint[] = [];
  const fingerprint = createHash('sha256');

  for (const { filePath, module } of files) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    const text = readFileSync(absolute, 'utf8');
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(text).update('\0');
    const lines = text.split(/\r?\n/);
    extractTsCapabilities(filePath, module, lines, capabilities);
    extractJavaCapabilities(filePath, module, lines, capabilities, endpoints);
    extractDocsCapabilities(filePath, module, lines, capabilities);
  }

  return { capabilities, endpoints, sourceFingerprint: fingerprint.digest('hex') };
}

export function discoverCapabilitySourceFingerprint(): string {
  const paths = repoPaths();
  const fingerprint = createHash('sha256');
  for (const { filePath, module } of capabilitySourceFiles()) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(readFileSync(absolute)).update('\0');
  }
  return fingerprint.digest('hex');
}

export function discoverCapabilitySourceStateFingerprint(): string {
  const paths = repoPaths();
  const fingerprint = createHash('sha256');
  for (const { filePath, module } of capabilitySourceFiles()) {
    const absolute = resolve(paths.root, filePath);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    fingerprint.update(module).update('\0').update(filePath).update('\0').update(`${stat.size}:${stat.mtimeMs}`).update('\0');
  }
  return fingerprint.digest('hex');
}

function capabilitySourceFiles(): Array<{ filePath: string; module: string }> {
  const config = loadProjectConfig();
  const files = new Map<string, string>();
  for (const [moduleName, module] of Object.entries(config.modules)) {
    for (const filePath of discoverModuleFiles(config, moduleName)) {
      if (!files.has(filePath)) files.set(filePath, moduleName);
    }
  }
  return [...files.entries()]
    .map(([filePath, module]) => ({ filePath, module }))
    .sort((left, right) => left.filePath.localeCompare(right.filePath));
}

function discoverModuleFiles(config: ProjectConfig, moduleName: string): string[] {
  const module = config.modules[moduleName];
  if (!module) return [];
  return fg.sync(sourceGlobsForModule(module), {
    cwd: repoPaths().root,
    absolute: false,
    onlyFiles: true,
    ignore: [
      '**/.git/**',
      '**/node_modules/**',
      '**/build/**',
      '**/dist/**',
      '**/coverage/**',
      '**/target/**',
      '**/vendor/**',
    ],
  });
}

function push(capabilities: Capability[], item: Omit<Capability, 'id'>): void {
  capabilities.push({
    id: `${item.filePath}:${item.kind}:${item.name}:${item.lineStart ?? 0}`,
    ...item,
  });
}

function extractTsCapabilities(filePath: string, module: string, lines: string[], capabilities: Capability[]): void {
  lines.forEach((line, index) => {
    const exports = /\bexport\b/.test(line);
    const fn = /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line);
    const cnst = /\b(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=/.exec(line);
    const type = /\b(?:export\s+)?(?:type|interface)\s+([A-Za-z0-9_]+)/.exec(line);
    const match = fn ?? cnst ?? type;
    if (!match) return;
    const name = match[1];
    const kind = fn ? (name.startsWith('use') ? 'hook' : /^[A-Z]/.test(name) ? 'component' : 'function') : type ? 'type' : /^[A-Z]/.test(name) ? 'component' : 'constant';
    push(capabilities, {
      name,
      kind,
      module,
      filePath,
      lineStart: index + 1,
      lineEnd: index + 1,
      signature: line.trim(),
      exported: exports,
    });
  });
}

function extractJavaCapabilities(
  filePath: string,
  module: string,
  lines: string[],
  capabilities: Capability[],
  endpoints: Endpoint[],
): void {
  let currentClass: string | undefined;
  let currentBasePath = '';
  lines.forEach((line, index) => {
    const classMatch = /\b(public\s+)?(class|record|interface|enum)\s+([A-Za-z0-9_]+)/.exec(line);
    if (classMatch) {
      currentClass = classMatch[3];
      push(capabilities, {
        name: currentClass,
        kind: classMatch[2],
        module,
        filePath,
        lineStart: index + 1,
        lineEnd: index + 1,
        signature: line.trim(),
        exported: Boolean(classMatch[1]),
      });
    }

    const requestMapping = /@RequestMapping\((?:value\s*=\s*)?"([^"]+)"/.exec(line);
    if (requestMapping) {
      currentBasePath = requestMapping[1];
    }

    const endpoint = /@(Get|Post|Put|Patch|Delete)Mapping\((?:value\s*=\s*)?"?([^")]+)?"?\)/.exec(line);
    if (endpoint) {
      const method = endpoint[1].toUpperCase().replace('DELETE', 'DELETE');
      const localPath = endpoint[2] && !endpoint[2].startsWith('produces') ? endpoint[2] : '';
      const path = normalizeEndpointPath(`${currentBasePath}/${localPath}`);
      endpoints.push({
        id: `${method}:${path}`,
        method,
        path,
        module,
        controllerSymbolId: currentClass ? `${filePath}:class:${currentClass}` : undefined,
        filePath,
      });
    }
  });
}

function extractDocsCapabilities(filePath: string, module: string, lines: string[], capabilities: Capability[]): void {
  if (!filePath.endsWith('.md')) return;
  lines.forEach((line, index) => {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (!heading) return;
    push(capabilities, {
      name: heading[2].trim(),
      kind: 'doc-heading',
      module,
      filePath,
      lineStart: index + 1,
      lineEnd: index + 1,
      signature: line.trim(),
      exported: false,
    });
  });
}

function normalizeEndpointPath(path: string): string {
  return `/${path.split('/').filter(Boolean).join('/')}`.replace(/\/$/, '') || '/';
}
