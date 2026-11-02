import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let destination: string | undefined;
const sourceFixtures: string[] = [];

afterEach(() => {
  if (destination) rmSync(destination, { recursive: true, force: true });
  destination = undefined;
  for (const fixture of sourceFixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe('standalone repository export', () => {
  it.each(['scripts', 'site/assets'])('omits nested private and generated entries from %s without Git metadata', (directory) => {
    const fixture = mkdtempSync(resolve(tmpdir(), 'project-context-export-source-'));
    sourceFixtures.push(fixture);
    const createFixture = spawnSync(process.execPath, [resolve(packageRoot, 'scripts/export-standalone.mjs'), '--destination', fixture], { encoding: 'utf8' });
    expect(createFixture.status, createFixture.stderr).toBe(0);
    const privateFiles = ['.env', '.env.local', '.npmrc'];
    const generatedDirectories = ['.git', 'node_modules', 'dist', 'artifacts', 'coverage', '.project-context'];
    const nested = resolve(fixture, directory, 'nested');
    mkdirSync(nested, { recursive: true });
    for (const file of [...privateFiles, '.env.example', 'public-source.ts']) writeFileSync(resolve(nested, file), 'synthetic export fixture\n');
    for (const name of generatedDirectories) {
      mkdirSync(resolve(nested, name));
      writeFileSync(resolve(nested, name, 'generated.txt'), 'synthetic generated fixture\n');
    }
    destination = mkdtempSync(resolve(tmpdir(), 'project-context-export-filter-'));

    const result = spawnSync(process.execPath, [resolve(fixture, 'scripts/export-standalone.mjs'), '--destination', destination], { encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(resolve(fixture, '.git'))).toBe(false);
    for (const omitted of [...privateFiles, ...generatedDirectories]) expect(existsSync(resolve(destination, directory, 'nested', omitted))).toBe(false);
    for (const retained of ['.env.example', 'public-source.ts']) expect(readFileSync(resolve(destination, directory, 'nested', retained), 'utf8')).toBe('synthetic export fixture\n');
  });

  it('copies only reusable source and creates clean repository context', () => {
    destination = mkdtempSync(resolve(tmpdir(), 'project-context-export-test-'));
    const result = spawnSync(process.execPath, [
      resolve(packageRoot, 'scripts/export-standalone.mjs'),
      '--destination', destination,
      '--name', 'Standalone Context Router',
      '--version', '0.4.0',
    ], { cwd: packageRoot, encoding: 'utf8' });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expect.objectContaining({ copiedProjectRecords: false }));
    expect(existsSync(resolve(destination, 'src/mcp/server.ts'))).toBe(true);
    expect(existsSync(resolve(destination, 'test/portability.test.ts'))).toBe(true);
    expect(existsSync(resolve(destination, '.project-context/project.yaml'))).toBe(true);
    expect(existsSync(resolve(destination, '.project-context/active/tasks'))).toBe(true);
    expect(readdirSync(resolve(destination, '.project-context/active/tasks'))).toEqual([]);
    expect(readdirSync(resolve(destination, 'scripts')).sort()).toEqual(readdirSync(resolve(packageRoot, 'scripts')).sort());
    expect(existsSync(resolve(destination, 'site/build.mjs'))).toBe(true);
    expect(existsSync(resolve(destination, 'site/content/ru/quickstart.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'standalone/README.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'docs/install/codex.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'docs/install/opencode.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'CONTRIBUTING.md'))).toBe(true);
    expect(existsSync(resolve(destination, 'SECURITY.md'))).toBe(true);
    expect(existsSync(resolve(destination, '.github/workflows/ci.yml'))).toBe(true);
    expect(existsSync(resolve(destination, '.github/ISSUE_TEMPLATE/bug_report.yml'))).toBe(true);
    for (const omitted of ['.git', '.env', '.npmrc', 'dist', 'node_modules', 'site/dist']) {
      expect(existsSync(resolve(destination, omitted))).toBe(false);
    }

    const packageJson = JSON.parse(readFileSync(resolve(destination, 'package.json'), 'utf8'));
    expect(packageJson.name).toBe('mcp-project-context-router');
    expect(packageJson.version).toBe('0.4.0');
    expect(packageJson.scripts).toEqual(JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')).scripts);
    expect(readFileSync(resolve(destination, 'README.md'), 'utf8')).not.toMatch(/Artifactory|corporate registry/i);
    expect(readFileSync(resolve(destination, 'src/version.ts'), 'utf8')).toContain("'0.4.0'");
    expect(readFileSync(resolve(destination, 'scripts/package-smoke.mjs'), 'utf8')).toContain('mcp-project-context-router@0.4.0');
    const packageLock = JSON.parse(readFileSync(resolve(destination, 'package-lock.json'), 'utf8'));
    expect(packageLock.version).toBe('0.4.0');
    expect(packageLock.packages[''].version).toBe('0.4.0');
    const projectYaml = readFileSync(resolve(destination, '.project-context/project.yaml'), 'utf8');
    expect(projectYaml).toContain('name: "Standalone Context Router"');
    expect(projectYaml).toContain('repository: "project-context-export-test-');
    expect(projectYaml).not.toContain('__PROJECT_NAME__');
  });

  it('builds the exported runtime and site, runs source tests and evaluates search', () => {
    destination = mkdtempSync(resolve(tmpdir(), 'project-context-export-runtime-'));
    const run = (command: string, args: string[]) => {
      const result = spawnSync(command, args, { cwd: destination, encoding: 'utf8', timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
      expect(result.status, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      return result.stdout;
    };
    run(process.execPath, [resolve(packageRoot, 'scripts/export-standalone.mjs'), '--destination', destination]);
    // Reuse the installed development dependencies without adding them to the source export.
    symlinkSync(resolve(packageRoot, 'node_modules'), resolve(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    run(process.execPath, ['site/build.mjs']);
    run(process.execPath, ['site/check.mjs']);
    run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json']);
    // A focused child suite exercises exported sources without recursively re-running this export test.
    run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'test/search-eval.test.ts', 'test/portability.test.ts']);
    run('git', ['init', '-q']);
    run('git', ['add', 'package.json']);
    run('git', ['-c', 'user.name=Export Test', '-c', 'user.email=export@example.invalid', 'commit', '-qm', 'Export fixture']);
    run(process.execPath, ['--import', 'tsx', 'scripts/search-eval.ts', '--samples', '1', '--engines', 'current', '--output', 'artifacts/export-search.json']);
    const report = JSON.parse(readFileSync(resolve(destination, 'artifacts/export-search.json'), 'utf8'));
    expect(report.provenance.sourceFiles).toContain('scripts/search-eval.ts');
    expect(Object.keys(report.summary)).toEqual(['current']);
    expect(report.queries).toBeGreaterThan(0);
    expect(existsSync(resolve(destination, 'dist/cli.js'))).toBe(true);
    expect(existsSync(resolve(destination, 'site/dist/ru/index.html'))).toBe(true);
  }, 120_000);
});
