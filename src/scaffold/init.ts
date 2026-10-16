import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoPaths } from '../storage/repo.js';
import { isRepositoryPath } from '../storage/file-references.js';

export type ProjectModuleSeed = {
  name: string;
  path: string;
};

export type InitializeProjectContextOptions = {
  name?: string;
  modules?: ProjectModuleSeed[];
  withSkills?: boolean;
  withHooks?: boolean;
  client?: 'codex' | 'zcode' | 'deepseek-harness';
};

export type InitializeProjectContextResult = {
  status: 'OK';
  contextDir: string;
  created: string[];
  skipped: string[];
};

const bundledSkills = ['project-context-workflow', 'context-research'] as const;

const contextDirectories = [
  'active/tasks',
  'active/bugs',
  'active/decisions',
  'active/backlog',
  'active/research',
  'active/verification',
  'active/agent-runs',
  'active/acceptance-reviews',
  'active/projects',
  'active/requirements',
  'active/open-questions',
  'drafts/tasks',
  'drafts/backlog',
  'drafts/bugs',
  'drafts/decisions',
  'drafts/projects',
  'drafts/requirements',
  'drafts/open-questions',
  'archive',
  'trash',
  'indexes',
  'schemas',
  'templates',
] as const;

const ignoredContextPaths = [
  '.project-context/indexes/',
  '.project-context/drafts/',
  '.project-context/trash/',
  '.project-context/active/**/.execution.lock',
  '.project-context/active/**/.research.lock',
  '.project-context/active/**/.*.tmp',
];

export function parseModuleSeed(value: string): ProjectModuleSeed {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error(`Invalid module "${value}". Expected name:path.`);
  }
  const name = value.slice(0, separator).trim();
  const path = value.slice(separator + 1).trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    throw new Error(`Invalid module name "${name}". Use lowercase letters, digits, hyphens, or underscores.`);
  }
  if (!path || isAbsolute(path) || path.split('/').includes('..')) {
    throw new Error(`Invalid module path "${path}". Use a repository-relative path.`);
  }
  return { name, path };
}

export function initializeProjectContext(options: InitializeProjectContextOptions = {}): InitializeProjectContextResult {
  const paths = repoPaths();
  const created: string[] = [];
  const skipped: string[] = [];
  const modules = uniqueModules(options.modules ?? []);
  const client = options.client ?? 'codex';
  if (!['codex', 'zcode', 'deepseek-harness'].includes(client)) throw new Error(`Unsupported client: ${client}`);
  if (client === 'zcode' && options.withHooks) throw new Error('ZCode ignores project-level hooks. Install without --with-hooks and follow docs/install/zcode.md for reviewed user-level hooks.');
  const skillsDirectory = client === 'zcode' ? '.zcode/skills' : '.agents/skills';
  const hooksPath = client === 'deepseek-harness' ? '.dsh/project-context-hooks.json' : '.codex/hooks.json';
  const configPath = client === 'zcode' ? '.zcode/config.json' : client === 'deepseek-harness' ? '.dsh/project-context.cordis.yml' : options.client ? '.codex/config.toml' : undefined;
  if (configPath && !isRepositoryPath(configPath)) throw new Error(`Client configuration destination must stay inside the repository: ${configPath}`);
  const prefix = options.withHooks || configPath ? packagePrefix() : '';
  const projectName = options.name?.trim() || humanizeRepositoryName(basename(paths.root));

  if (options.withSkills) {
    for (const name of bundledSkills) {
      const relative = `${skillsDirectory}/${name}/SKILL.md`;
      if (!isRepositoryPath(relative)) throw new Error(`Skill destination must stay inside the repository: ${relative}`);
    }
  }

  if (options.withHooks && !isRepositoryPath(hooksPath)) {
    throw new Error(`Hook destination must stay inside the repository: ${hooksPath}`);
  }

  for (const relative of contextDirectories) {
    mkdirSync(resolve(paths.contextDir, relative), { recursive: true });
  }

  writeIfMissing(
    resolve(paths.contextDir, 'project.yaml'),
    renderProjectConfig(projectName, basename(paths.root), modules, Boolean(options.withHooks) && client === 'codex'),
    '.project-context/project.yaml',
    created,
    skipped,
  );
  writeIfMissing(
    resolve(paths.contextDir, 'README.md'),
    renderContextReadme(projectName),
    '.project-context/README.md',
    created,
    skipped,
  );

  copyTemplate('portable-workflow/task-contract.md', '.project-context/templates/TASK-CONTRACT.md', created, skipped);
  copyTemplate('portable-workflow/task-contract.full.md', '.project-context/templates/TASK-CONTRACT.full.md', created, skipped);
  copyTemplate('portable-workflow/verification-record.md', '.project-context/templates/VERIFICATION-RECORD.md', created, skipped);
  if (options.withSkills) {
    for (const name of bundledSkills) {
      copyTemplate(`skills/${name}/SKILL.md`, `${skillsDirectory}/${name}/SKILL.md`, created, skipped);
    }
  }
  if (options.withHooks) {
    writeIfMissing(resolve(paths.root, hooksPath), renderHooks(prefix), hooksPath, created, skipped);
  }
  if (configPath) {
    const template = client === 'zcode' ? 'zcode.json' : client === 'deepseek-harness' ? 'deepseek-harness.cordis.yml' : 'codex.toml';
    let content = readFileSync(fileURLToPath(new URL(`../../templates/client-configs/${template}`, import.meta.url)), 'utf8');
    content = content.replaceAll('node_modules/mcp-project-context-router/', prefix);
    if (client === 'deepseek-harness' && options.withHooks) {
      content += readFileSync(fileURLToPath(new URL('../../templates/client-configs/deepseek-harness-hooks.cordis.yml', import.meta.url)), 'utf8');
    }
    writeIfMissing(resolve(paths.root, configPath), content, configPath, created, skipped);
  }
  updateGitignore(paths.root, created, skipped);

  return { status: 'OK', contextDir: paths.contextDir, created, skipped };
}

function packagePrefix(): string {
  const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
  const local = relative(repoPaths().root, packageRoot).replaceAll('\\', '/');
  const prefix = local === '' ? '' : !isAbsolute(local) && local !== '..' && !local.startsWith('../') ? `${local}/` : 'node_modules/mcp-project-context-router/';
  if (/[\u0000-\u001f"'$`]/.test(prefix)) throw new Error('Client package path contains unsupported shell characters.');
  return prefix;
}

function renderHooks(prefix: string): string {
  const template = readFileSync(fileURLToPath(new URL('../../templates/client-configs/codex-hooks.json', import.meta.url)), 'utf8');
  return template.replaceAll('node_modules/mcp-project-context-router/', prefix);
}

function uniqueModules(modules: ProjectModuleSeed[]): ProjectModuleSeed[] {
  const byName = new Map<string, ProjectModuleSeed>();
  for (const module of modules) {
    if (byName.has(module.name)) throw new Error(`Duplicate module name: ${module.name}.`);
    byName.set(module.name, module);
  }
  return [...byName.values()];
}

function writeIfMissing(
  absolutePath: string,
  content: string,
  relativePath: string,
  created: string[],
  skipped: string[],
): void {
  if (existsSync(absolutePath)) {
    skipped.push(relativePath);
    return;
  }
  mkdirSync(dirname(absolutePath), { recursive: true });
  try {
    writeFileSync(absolutePath, content, { encoding: 'utf8', flag: 'wx' });
    created.push(relativePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    skipped.push(relativePath);
  }
}

function copyTemplate(sourceName: string, relative: string, created: string[], skipped: string[]): void {
  const paths = repoPaths();
  const source = fileURLToPath(new URL(`../../templates/${sourceName}`, import.meta.url));
  writeIfMissing(resolve(paths.root, relative), readFileSync(source, 'utf8'), relative, created, skipped);
}

function updateGitignore(root: string, created: string[], skipped: string[]): void {
  const path = resolve(root, '.gitignore');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const missing = ignoredContextPaths.filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (missing.length === 0) {
    skipped.push('.gitignore');
    return;
  }
  const separator = existing.length === 0 || existing.endsWith('\n') ? '' : '\n';
  const heading = existing.includes('# Project context router') ? '' : '# Project context router\n';
  writeFileSync(path, `${existing}${separator}${heading}${missing.join('\n')}\n`, 'utf8');
  created.push('.gitignore');
}

function renderProjectConfig(projectName: string, repository: string, modules: ProjectModuleSeed[], withHooks: boolean): string {
  const defaultModules = modules.length > 0 ? [modules[0].name] : [];
  const documentationModules = modules
    .filter((module) => ['doc', 'docs', 'documentation'].includes(module.name))
    .map((module) => module.name);
  const moduleYaml = modules.length === 0
    ? '{}'
    : `\n${modules.map((module) => renderModule(module)).join('\n')}`;

  return `project:
  name: ${yamlString(projectName)}
  repository: ${yamlString(repository)}
  context_version: 1
  timezone: UTC
  purpose: ${yamlString(`Local project context for ${projectName}.`)}
  roles: [Developer]
  flows:
    - Validate or derive a task contract before implementation.
    - Build a context pack and inspect existing capabilities.
    - Run applicable verification and finalize the work.
routing:
  default_modules: ${yamlArray(defaultModules)}
  documentation_modules: ${yamlArray(documentationModules)}
context_router:
  cli_command: npx project-context
  mcp_server_name: project_context
  resource_scheme: project-context
  codex_config_path: false
  codex_hooks_path: ${withHooks ? ".codex/hooks.json\n  required_hook_events: [UserPromptSubmit, PostToolUse, Stop]" : "false"}
  git_hooks_path: false
  brand:
    name: Project Context Router
    short_name: Project Context
    marker: PROJECT_CONTEXT
    logo_text: "[Project Context]"
    description: local-first project memory, backlog, and verification router
modules: ${moduleYaml}
commands:
  context_lint: npx project-context lint
  context_index: npx project-context index
  context_doctor: npx project-context doctor
`;
}

function renderModule(module: ProjectModuleSeed): string {
  const sourceGlob = module.path === '.'
    ? '**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,java,kt,kts,go,rs,py,rb,php,cs,sql,xml,yaml,yml,md}'
    : `${module.path}/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts,java,kt,kts,go,rs,py,rb,php,cs,sql,xml,yaml,yml,md}`;
  return `  ${module.name}:
    path: ${yamlString(module.path)}
    # Add query aliases in your team languages and reviewed legacy module names.
    aliases: [${yamlString(module.name)}]
    source_globs: [${yamlString(sourceGlob)}]
    playbooks: []`;
}

function renderContextReadme(projectName: string): string {
  return `# ${projectName} project context

This directory is the tracked source of truth for project-context records and routing configuration.

- Edit \`project.yaml\` to define real modules, aliases, source globs, playbooks, and verification commands.
- Keep reviewed durable records under \`active/\`.
- Keep generated drafts and SQLite indexes untracked.
- Confirm Task Contracts before implementation and record verification before finalization.
`;
}

function humanizeRepositoryName(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join(' ');
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlArray(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}
