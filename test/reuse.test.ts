import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildIndex } from '../src/indexer/sqlite.js';
import { findExistingCapabilities, findExistingCapability } from '../src/reuse-scan/reuse.js';

let originalCwd: string;
let tempDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context'), { recursive: true });
  mkdirSync(resolve(tempDir, 'ppm-frontend/src/shared/api'), { recursive: true });
  writeFileSync(
    resolve(tempDir, '.project-context/project.yaml'),
    `project:
  name: Reuse Test
routing:
  default_modules: [frontend]
modules:
  frontend:
    path: ppm-frontend
    aliases: [frontend]
    source_globs: ["ppm-frontend/src/**/*.{ts,tsx}"]
    playbooks: []
commands: {}
`,
  );
  writeFileSync(
    resolve(tempDir, 'ppm-frontend/src/shared/api/buildSearchParams.ts'),
    'export function buildSearchParams(input: Record<string, string>) { return new URLSearchParams(input) }\n',
  );
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

describe('reuse scan', () => {
  it('finds indexed frontend helpers', () => {
    rebuildIndex();

    const result = findExistingCapability('search params filters', ['frontend']);

    expect(result.matches.some((match) => match.path.includes('buildSearchParams.ts'))).toBe(true);
  });

  it('scans multiple reuse queries in one batch', () => {
    rebuildIndex();

    const result = findExistingCapabilities({
      queries: [
        { query: 'search params filters', modules: ['frontend'] },
        { query: 'build search params helper', modules: ['frontend'] },
      ],
    });

    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.query).toBe('search params filters');
    expect(result.results.every((item) => item.result.matches.some((match) => match.path.includes('buildSearchParams.ts')))).toBe(true);
  });
});
