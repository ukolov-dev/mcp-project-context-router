import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

execFileSync('npm', ['run', 'build'], { cwd: packageRoot, stdio: 'inherit' });
const cache = mkdtempSync(resolve(tmpdir(), 'project-context-npm-cache-'));
let raw;
try {
  raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_ignore_scripts: 'true' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
} finally {
  rmSync(cache, { recursive: true, force: true });
}
const report = JSON.parse(raw)[0];
const files = report.files.map((entry) => entry.path);
const required = [
  'bin/project-context',
  'bin/project-context-mcp',
  'bin/ppm-context',
  'dist/cli.js',
  'dist/mcp/server.js',
  'docs/install/codex.md',
  'docs/install/opencode.md',
  'scripts/macos-portal-credential.js',
  'scripts/windows-confluence-credential.ps1',
  'scripts/windows-portal-credential.ps1',
  'templates/portable-workflow/project.yaml.example',
  'templates/client-configs/codex.toml',
  'templates/client-configs/opencode.json',
  'templates/client-configs/opencode-v2.json',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'README.md',
];
const forbiddenPrefixes = [
  '.project-context/',
  '.codex/',
  'node_modules/',
  'src/',
  'test/',
  'scripts/',
  'dist/mcp-server.',
];
const missing = required.filter((path) => !files.includes(path));
const allowedScripts = new Set([
  'scripts/macos-portal-credential.js',
  'scripts/windows-confluence-credential.ps1',
  'scripts/windows-portal-credential.ps1',
]);
const forbidden = files.filter((path) => forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) && !allowedScripts.has(path));

const result = {
  status: missing.length === 0 && forbidden.length === 0 ? 'OK' : 'FAILED',
  package: report.name,
  version: report.version,
  filename: report.filename,
  entryCount: files.length,
  unpackedSize: report.unpackedSize,
  missing,
  forbidden,
};

if (report.name !== 'mcp-project-context-router' || report.version !== '0.4.0') {
  result.status = 'FAILED';
  result.identity = `Expected mcp-project-context-router@0.4.0, got ${report.name}@${report.version}`;
}

const packageJson = JSON.parse(execFileSync('npm', ['pkg', 'get'], {
  cwd: packageRoot,
  encoding: 'utf8',
  env: { ...process.env, npm_config_ignore_scripts: 'true' },
}));
const floatingRuntimeDependencies = Object.entries(packageJson.dependencies ?? {})
  .filter(([, version]) => !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version));
if (floatingRuntimeDependencies.length > 0) {
  result.status = 'FAILED';
  result.floatingRuntimeDependencies = floatingRuntimeDependencies;
}
if (packageJson.engines?.node !== '>=22.13.0') {
  result.status = 'FAILED';
  result.nodeEngine = `Expected >=22.13.0, got ${packageJson.engines?.node ?? '<missing>'}`;
}
if (packageJson.dependencies?.['better-sqlite3'] || packageJson.devDependencies?.['@types/better-sqlite3']) {
  result.status = 'FAILED';
  result.nativeSqliteDependency = 'The standalone package must use node:sqlite without a native lifecycle build.';
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status === 'FAILED') process.exitCode = 1;
