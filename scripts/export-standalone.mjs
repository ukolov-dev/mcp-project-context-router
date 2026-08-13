import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArguments(process.argv.slice(2));
const destination = resolve(options.destination);
const repositoryName = basename(destination);
const projectName = options.name || humanize(repositoryName);
const standaloneVersion = options.version || sourcePackage().version;

if (existsSync(destination) && readdirSync(destination).length > 0) {
  fail(`Destination must be empty: ${destination}`);
}
mkdirSync(destination, { recursive: true });

for (const entry of [
  'src',
  'test',
  'bin',
  'hooks',
  'templates',
  'docs',
  'standalone',
  '.github',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'package-lock.json',
  'tsconfig.json',
]) {
  cpSync(resolve(packageRoot, entry), resolve(destination, entry), { recursive: true, preserveTimestamps: true });
}
for (const test of ['ci-contract.test.ts', 'release.test.ts']) {
  rmSync(resolve(destination, 'test', test), { force: true });
}
mkdirSync(resolve(destination, 'scripts'), { recursive: true });
for (const script of [
  'package-smoke.mjs',
  'export-standalone.mjs',
  'macos-portal-credential.js',
  'windows-confluence-credential.ps1',
  'windows-portal-credential.ps1',
]) {
  cpSync(resolve(packageRoot, `scripts/${script}`), resolve(destination, `scripts/${script}`));
}

const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
for (const script of ['perf:smoke', 'quality:smoke', 'ci:check', 'release:check', 'release:prepare']) delete packageJson.scripts[script];
packageJson.version = standaloneVersion;
writeFileSync(resolve(destination, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
const packageLock = JSON.parse(readFileSync(resolve(packageRoot, 'package-lock.json'), 'utf8'));
packageLock.version = standaloneVersion;
packageLock.packages[''].version = standaloneVersion;
writeFileSync(resolve(destination, 'package-lock.json'), `${JSON.stringify(packageLock, null, 2)}\n`, 'utf8');
writeFileSync(
  resolve(destination, 'src/version.ts'),
  `export const projectContextVersion = '${standaloneVersion}';\n`,
  'utf8',
);
rewriteStandalonePackageCheck();

const standaloneTemplate = resolve(packageRoot, 'templates/standalone-repository');
materializeSource(resolve(packageRoot, 'standalone/README.md'), 'README.md');
materialize('AGENTS.md', 'AGENTS.md');
materialize('gitignore', '.gitignore', (content) => content.replace('dist/\n', 'dist/\nartifacts/\n'));
materialize('codex-config.toml', '.codex/config.toml');
materialize('project.yaml', '.project-context/project.yaml', (content) => content.replace(
  '"src/**/*.ts", "bin/*", "hooks/*.js"',
  '"src/**/*.ts", "bin/*", "hooks/*.js", "scripts/*.mjs"',
));
materialize('context-README.md', '.project-context/README.md', (content) => content.replace(
  'PPM backlog items',
  'source-project backlog items',
));
materialize('testing-playbook.md', 'playbooks/testing.md');

for (const relative of [
  'active/modules', 'active/tasks', 'active/bugs', 'active/decisions', 'active/runbooks',
  'active/refactors', 'active/patterns', 'active/backlog', 'active/verification',
  'drafts/tasks', 'drafts/backlog', 'drafts/bugs', 'drafts/decisions', 'drafts/refactors',
  'drafts/run-summaries', 'archive', 'trash', 'indexes', 'schemas', 'templates',
]) {
  mkdirSync(resolve(destination, '.project-context', relative), { recursive: true });
}
cpSync(
  resolve(packageRoot, 'templates/portable-workflow/task-contract.md'),
  resolve(destination, '.project-context/templates/TASK-CONTRACT.md'),
);
cpSync(
  resolve(packageRoot, 'templates/portable-workflow/task-contract.full.md'),
  resolve(destination, '.project-context/templates/TASK-CONTRACT.full.md'),
);
cpSync(
  resolve(packageRoot, 'templates/portable-workflow/verification-record.md'),
  resolve(destination, '.project-context/templates/VERIFICATION-RECORD.md'),
);

process.stdout.write(`${JSON.stringify({
  status: 'OK',
  destination,
  project: projectName,
  package: packageJson.name,
  copiedSource: true,
  copiedProjectRecords: false,
  distribution: 'local-tarball',
  version: standaloneVersion,
}, null, 2)}\n`);

function materialize(sourceName, destinationName, transform = (content) => content) {
  materializeSource(resolve(standaloneTemplate, sourceName), destinationName, transform);
}

function materializeSource(source, destinationName, transform = (content) => content) {
  const target = resolve(destination, destinationName);
  mkdirSync(dirname(target), { recursive: true });
  const content = transform(readFileSync(source, 'utf8')
    .replaceAll('__PROJECT_NAME__', projectName)
    .replaceAll('__REPOSITORY__', repositoryName)
    .replaceAll('__PACKAGE_VERSION__', standaloneVersion));
  writeFileSync(target, content, 'utf8');
}

function parseArguments(args) {
  let destination;
  let name;
  let version;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--destination') destination = args[++index];
    else if (args[index] === '--name') name = args[++index];
    else if (args[index] === '--version') version = args[++index];
    else fail(`Unknown argument: ${args[index]}`);
  }
  if (!destination) fail('Usage: npm run export:standalone -- --destination <empty-directory> [--name <project-name>] [--version <semver>]');
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail(`Invalid standalone semver: ${version}`);
  return { destination, name, version };
}

function sourcePackage() {
  return JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
}

function rewriteStandalonePackageCheck() {
  const target = resolve(destination, 'scripts/package-smoke.mjs');
  const sourceVersion = sourcePackage().version;
  const content = readFileSync(target, 'utf8')
    .replaceAll(`report.version !== '${sourceVersion}'`, `report.version !== '${standaloneVersion}'`)
    .replaceAll(`Expected mcp-project-context-router@${sourceVersion}`, `Expected mcp-project-context-router@${standaloneVersion}`);
  writeFileSync(target, content, 'utf8');
}

function humanize(value) {
  return value.split(/[-_\s]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

function fail(message) {
  process.stderr.write(`[project-context export] ${message}\n`);
  process.exit(1);
}
