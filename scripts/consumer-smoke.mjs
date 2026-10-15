import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const output = join(root, 'artifacts/consumer-install');
mkdirSync(output, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'project-context-consumer-'));
const consumer = join(scratch, 'consumer');
const cache = join(scratch, 'npm-cache');
const userconfig = join(scratch, 'empty.npmrc');
const report = { status: 'RUNNING', version: metadata.version, node: process.version, sqlite: process.versions.sqlite,
  sourceCommit: null, sourceDirty: null, fts5Available: null, checks: [], tarball: null, tarballSha256: null, lockSha256: null };
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run package:consumer.');
const env = { ...process.env, npm_config_cache: cache, npm_config_userconfig: userconfig,
  npm_config_registry: 'https://registry.npmjs.org/', npm_config_audit: 'false', npm_config_fund: 'false' };
const run = (command, args, cwd = consumer) => execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 180000,
  stdio: ['ignore', 'pipe', 'pipe'] });
const checked = (name) => report.checks.push(name);
let client;
try {
  report.sourceCommit = run('git', ['rev-parse', 'HEAD'], root).trim();
  report.sourceDirty = Boolean(run('git', ['status', '--porcelain'], root).trim());
  mkdirSync(consumer);
  run('git', ['init', '-q']);
  writeFileSync(userconfig, '');
  writeFileSync(join(consumer, 'package.json'), '{"name":"clean-context-consumer","version":"1.0.0","private":true}\n');
  assert(!existsSync(join(consumer, 'node_modules')));
  assert(!existsSync(cache));
  const packed = JSON.parse(run(process.execPath, [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', output], root))[0];
  assert.equal(packed.version, metadata.version);
  report.tarball = relative(root, join(output, packed.filename)).split('\\').join('/');
  const tarball = join(output, packed.filename);
  report.tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  checked('Packed built candidate tarball');
  writeFileSync(join(output, 'install.log'), run(process.execPath, [npmCli, 'install', '--save-exact', '--no-audit', '--no-fund', tarball]));
  const installed = join(consumer, 'node_modules', metadata.name);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version, metadata.version);
  for (const name of [metadata.name, ...Object.keys(metadata.dependencies)]) {
    const location = join(consumer, 'node_modules', name);
    assert(!lstatSync(location).isSymbolicLink());
    assert(realpathSync(location).startsWith(realpathSync(join(consumer, 'node_modules')) + sep));
  }
  const tree = JSON.parse(run(process.execPath, [npmCli, 'ls', '--omit=dev', '--json']));
  assert(!tree.problems?.length);
  writeFileSync(join(output, 'dependencies.json'), JSON.stringify(tree, null, 2) + '\n');
  report.lockSha256 = createHash('sha256').update(readFileSync(join(consumer, 'package-lock.json'))).digest('hex');
  checked('Fresh dependency installation, empty npm cache, no shared or symlinked dependency directories');
  const cli = join(installed, 'bin/project-context');
  const json = (...args) => JSON.parse(run(process.execPath, [cli, '--json', ...args]));
  assert(run(process.execPath, [cli, 'pack', '--help']).includes('experimental'));
  mkdirSync(join(consumer, 'src'));
  writeFileSync(join(consumer, 'src/example.ts'), 'export function example() { return true; }\n');
  json('init', '--name', 'Clean consumer', '--module', 'app:src');
  assert(!existsSync(join(consumer, '.agents')));
  assert(!existsSync(join(consumer, '.codex')));
  const skillInit = json('init', '--with-skills');
  for (const name of ['project-context-workflow', 'context-research']) {
    const relativePath = `.agents/skills/${name}/SKILL.md`;
    assert(skillInit.created.includes(relativePath));
    assert.equal(readFileSync(join(consumer, relativePath), 'utf8'),
      readFileSync(join(installed, 'templates/skills', name, 'SKILL.md'), 'utf8'));
  }
  const customizedSkill = '.agents/skills/project-context-workflow/SKILL.md';
  writeFileSync(join(consumer, customizedSkill), 'User customized workflow\n');
  assert(json('init', '--with-skills').skipped.includes(customizedSkill));
  assert.equal(readFileSync(join(consumer, customizedSkill), 'utf8'), 'User customized workflow\n');
  checked('Installed init --with-skills copies both bundled skills and preserves customized files');
  const beforeHooks = readFileSync(join(consumer, '.project-context/project.yaml'), 'utf8');
  assert(json('init', '--with-hooks').created.includes('.codex/hooks.json'));
  assert.equal(readFileSync(join(consumer, '.project-context/project.yaml'), 'utf8'), beforeHooks);
  const hookConfig = JSON.parse(readFileSync(join(consumer, '.codex/hooks.json'), 'utf8'));
  assert.deepEqual(Object.keys(hookConfig.hooks), ['UserPromptSubmit', 'PostToolUse', 'Stop']);
  for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop']) {
    const command = hookConfig.hooks[event][0].hooks[0];
    const input = JSON.stringify({ cwd: join(consumer, 'src'), session_id: 'installed-consumer' });
    const output = execFileSync(command.command, { cwd: join(consumer, 'src'), shell: true, input, env, encoding: 'utf8', timeout: 30000 });
    if (event === 'Stop') assert.equal(output, '');
  }
  writeFileSync(join(consumer, '.codex/hooks.json'), '{"custom": true}');
  assert(json('init', '--with-hooks').skipped.includes('.codex/hooks.json'));
  assert.equal(readFileSync(join(consumer, '.codex/hooks.json'), 'utf8'), '{"custom": true}');
  checked('Installed optional hooks execute from a subdirectory and preserve custom hook/project configuration');
  // A small consumer policy isolates install/retrieval correctness from guidance-size limits.
  writeFileSync(join(consumer, 'AGENTS.md'), '# Clean consumer\nUse scoped project context.\n');
  writeFileSync(join(consumer, '.project-context/project.yaml'), 'project:\n  name: Clean consumer\nmodule_defaults: &module_defaults\n  path: src\nmodules:\n  app:\n    <<: *module_defaults\nrouting:\n  default_modules: [app]\ncontext_router:\n  mcp_server_name: clean_context\ncommands: {}\n');
  const { loadHookContextConfig } = await import(pathToFileURL(join(installed, 'hooks/context-config.js')).href);
  assert.equal(loadHookContextConfig(consumer).mcpServerName, 'clean_context');
  checked('Installed CLI reads merged YAML modules; installed hooks resolve the packaged YAML loader');
  const taskPath = join(consumer, '.project-context/active/tasks/TASK-HOOK.md');
  writeFileSync(taskPath, '---\nid: TASK-HOOK\ntype: task\nstatus: confirmed\ntitle: Installed hook fixture\nconfirmed_by_human: true\nmodules: [app]\nfiles: [src/example.ts]\n---\n## Verification Plan\n\n- `node --version`\n');
  const runInstalledStop = () => execFileSync(hookConfig.hooks.Stop[0].hooks[0].command, {
    cwd: join(consumer, 'src'), shell: true, input: JSON.stringify({ cwd: join(consumer, 'src'), session_id: 'installed-consumer' }), env, encoding: 'utf8', timeout: 30000,
  });
  assert.equal(JSON.parse(runInstalledStop()).decision, 'block');
  const evidencePayload = '.project-context/indexes/hook-evidence.json';
  writeFileSync(join(consumer, evidencePayload), JSON.stringify({ targetId: 'TASK-HOOK', summary: 'Synthetic installed-hook fixture',
    checks: json('verify-task', 'TASK-HOOK').required.map(({ command }) => ({ command, status: 'passed' })), changedFiles: ['src/example.ts'] }));
  json('record-verification', '--input', evidencePayload);
  const resultPayload = '.project-context/indexes/hook-result.json';
  writeFileSync(join(consumer, resultPayload), JSON.stringify({ summary: 'Installed-hook fixture finalized', changedFiles: ['src/example.ts'], completion: 'partial' }));
  assert.equal(json('finalize-work', 'TASK-HOOK', '--input', resultPayload).status, 'FINALIZED');
  assert.equal(runInstalledStop(), '');
  rmSync(taskPath);
  const verification = json('verification-evidence', 'TASK-HOOK');
  for (const item of verification.items) rmSync(join(consumer, item.path));
  checked('Installed Stop blocks a confirmed task and accepts fresh fixture evidence produced by the real CLI finalization flow');
  const records = join(consumer, '.project-context/active/decisions');
  mkdirSync(records, { recursive: true });
  for (const [id, body] of [['DIRECT', 'quick_valid direct evidence'], ['RESERVE', 'quick_validation reserve evidence']]) {
    writeFileSync(join(records, `${id}.md`), `---\nid: ${id}\ntype: decision\nstatus: active\ntitle: ${id}\nmodules: [app]\nfiles: []\ntags: []\n---\n${body}\n`);
  }
  json('index');
  const dbPath = join(consumer, '.project-context/indexes/context.sqlite');
  const { DatabaseSync } = await import('node:sqlite');
  const probe = new DatabaseSync(':memory:');
  try { report.fts5Available = Boolean(probe.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled").get().enabled); }
  finally { probe.close(); }
  if (env.PROJECT_CONTEXT_EXPECT_FTS5 !== undefined) assert.equal(String(report.fts5Available), env.PROJECT_CONTEXT_EXPECT_FTS5);
  const defaultSearch = json('search', 'quick_valid');
  assert.deepEqual(defaultSearch, json('search', 'quick_valid', '--search-engine', 'current'));
  const db = new DatabaseSync(dbPath);
  try { assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='record_fts'").get(), undefined); }
  finally { db.close(); }
  checked('Default current search is equivalent and creates no FTS projection');
  const ftsSearch = json('search', 'quick_valid', '--search-engine', 'fts5');
  if (report.fts5Available) assert.deepEqual(ftsSearch.records.map((record) => record.id), ['DIRECT', 'RESERVE']);
  else assert.deepEqual(ftsSearch, defaultSearch);
  const stripCache = ({ cache, ...pack }) => pack;
  const packArgs = ['pack', 'quick_valid', '--modules', 'app', '--max-tokens', '4000'];
  assert.deepEqual(stripCache(json(...packArgs)), stripCache(json(...packArgs, '--search-engine', 'current')));
  const pack = json(...packArgs, '--search-engine', 'fts5');
  if (report.fts5Available) {
    assert.deepEqual(pack.records.map((record) => record.id), ['DIRECT', 'RESERVE']);
    assert.equal(pack.records[1].reason, 'Matched partial identifier reserve.');
    assert(pack.records[1].excerpt.includes('quick_validation'));
  } else {
    assert.deepEqual(pack.records, json(...packArgs).records);
    assert.equal(pack.cache.status, 'disabled');
  }
  assert(!pack.budget.exceedsLimit && pack.budget.estimatedTokens <= 4000);
  assert.equal(pack.warnings.some((warning) => warning.includes('FTS5 unavailable')), !report.fts5Available);
  checked(report.fts5Available ? 'Installed CLI preserves direct FTS results and delivers reserve evidence in a bounded pack'
    : 'Installed CLI falls back to current search with a visible warning and disabled caching');
  const sdk = join(consumer, 'node_modules/@modelcontextprotocol/sdk/dist/esm/client');
  const { Client } = await import(pathToFileURL(join(sdk, 'index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')).href);
  client = new Client({ name: 'clean-consumer-smoke', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(installed, 'bin/project-context-mcp')], cwd: consumer,
    env: { ...env, PROJECT_CONTEXT_TOOL_PROFILE: 'core' }, stderr: 'pipe' });
  let serverErrors = '';
  transport.stderr?.on('data', (chunk) => { serverErrors += chunk.toString(); });
  await client.connect(transport);
  assert.equal(client.getServerVersion()?.version, metadata.version);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.find((tool) => tool.name === 'build_context_pack')?.inputSchema.properties.searchEngine.enum, ['current', 'fts5']);
  const input = { query: 'quick_valid', modules: ['app'], maxTokens: 4000 };
  const call = async (args) => {
    const result = await client.callTool({ name: 'build_context_pack', arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  assert.deepEqual(stripCache(await call(input)), stripCache(await call({ ...input, searchEngine: 'current' })));
  const mcpPack = await call({ ...input, searchEngine: 'fts5' });
  if (report.fts5Available) {
    assert.deepEqual(mcpPack.records.map((record) => record.id), ['DIRECT', 'RESERVE']);
    assert.equal(mcpPack.records[1].reason, 'Matched partial identifier reserve.');
    assert(mcpPack.records[1].excerpt.includes('quick_validation'));
  } else {
    assert.deepEqual(mcpPack.records, (await call(input)).records);
    assert.equal(mcpPack.cache.status, 'disabled');
  }
  assert(!mcpPack.budget.exceedsLimit);
  assert.equal(mcpPack.warnings.some((warning) => warning.includes('FTS5 unavailable')), !report.fts5Available);
  checked('Installed stdio MCP handshake/version/default/FTS pack tool');
  await client.close();
  client = undefined;
  writeFileSync(join(output, 'mcp-stderr.log'), serverErrors);
  report.status = 'OK';
} catch (error) {
  report.status = 'FAILED';
  report.error = error.message;
  throw error;
} finally {
  if (client) await client.close();
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
