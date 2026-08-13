import { existsSync, lstatSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { dump, load } from 'js-yaml';
import { repoPaths } from './repo.js';

export type ProjectMetadataConfig = {
  name: string;
  repository?: string;
  contextVersion?: number;
  timezone?: string;
  purpose?: string;
  roles: string[];
  flows: string[];
};

export type ProjectModuleConfig = {
  path: string;
  stack?: string;
  playbooks: string[];
  aliases: string[];
  sourceGlobs: string[];
};

export type ProjectCommandConfig = {
  run: string;
  requiredFor: string[];
  timeoutSeconds?: number;
  network?: boolean;
  writesTo: string[];
  ciEquivalent?: string;
  includeInContextPack?: boolean;
};

export type ProjectSpecificationConfig = {
  includeInContextPack: boolean;
  files: string[];
  runbook?: string;
  modules: string[];
};

export type ProjectRoutingConfig = {
  defaultModules: string[];
  documentationModules: string[];
};

export type ContextRouterBrandConfig = {
  name: string;
  shortName: string;
  marker: string;
  logoText: string;
  description: string;
};

export type ContextRouterConfig = {
  packagePath?: string;
  cliCommand: string;
  installCommand?: string;
  mcpServerName: string;
  resourceScheme: string;
  codexConfigPath?: string;
  codexHooksPath?: string;
  requiredHookEvents: string[];
  gitHooksPath?: string;
  gitHooksInstallCommand?: string;
  cacheDependencyFiles: string[];
  brand: ContextRouterBrandConfig;
};

export type ConfluenceIntegrationConfig = {
  schemaVersion: number;
  baseUrl: string;
  rootPageId: string;
  rootPageUrl: string;
  writeScope: 'root-and-descendants';
  includeRoot: boolean;
  credentialRef: string;
};

export type PortalIntegrationConfig = {
  schemaVersion: number;
  baseUrl: string;
  projectId: string;
  projectKey?: string;
  projectName?: string;
  cachePath: string;
  credentialRef: string;
};

export type ProjectIntegrationsConfig = {
  confluence?: ConfluenceIntegrationConfig;
  portal?: PortalIntegrationConfig;
};

export type ProjectConfig = {
  project: ProjectMetadataConfig;
  modules: Record<string, ProjectModuleConfig>;
  commands: Record<string, string>;
  commandMetadata: Record<string, ProjectCommandConfig>;
  routing: ProjectRoutingConfig;
  contextRouter: ContextRouterConfig;
  integrations: ProjectIntegrationsConfig;
  retention: Record<string, Record<string, unknown>>;
  specifications: {
    current?: ProjectSpecificationConfig;
  };
};

const emptyConfig = (): ProjectConfig => {
  const paths = repoPaths();
  return {
    project: {
      name: basename(paths.root),
      roles: [],
      flows: [],
    },
    modules: {},
    commands: {},
    commandMetadata: {},
    routing: { defaultModules: [], documentationModules: [] },
    contextRouter: {
      cliCommand: 'project-context',
      mcpServerName: 'project_context',
      resourceScheme: 'project-context',
      requiredHookEvents: [],
      cacheDependencyFiles: [],
      brand: defaultContextRouterBrand(),
    },
    integrations: {},
    retention: {},
    specifications: {},
  };
};

export function loadProjectConfig(): ProjectConfig {
  const paths = repoPaths();
  const path = resolve(paths.contextDir, 'project.yaml');
  if (!existsSync(path)) return emptyConfig();

  const document = asObject(load(readFileSync(path, 'utf8')));
  const commandMetadata = parseCommands(asObject(document.commands));
  return {
    project: parseProject(asObject(document.project), paths.root),
    modules: parseModules(asObject(document.modules)),
    commands: Object.fromEntries(Object.entries(commandMetadata).map(([name, command]) => [name, command.run])),
    commandMetadata,
    routing: parseRouting(asObject(document.routing)),
    contextRouter: parseContextRouter(asObject(document.context_router)),
    integrations: parseIntegrations(asObject(document.integrations)),
    retention: parseRetention(asObject(document.retention)),
    specifications: parseSpecifications(asObject(document.specifications)),
  };
}

export function writeConfluenceIntegration(config: ConfluenceIntegrationConfig): string {
  const paths = repoPaths();
  const path = resolve(paths.contextDir, 'project.yaml');
  if (!existsSync(path)) throw new Error('Missing .project-context/project.yaml. Initialize Project Context first.');
  if (lstatSync(path).isSymbolicLink()) throw new Error('.project-context/project.yaml must not be a symbolic link.');

  const document = asObject(load(readFileSync(path, 'utf8')));
  const integrations = asObject(document.integrations);
  integrations.confluence = {
    schema_version: config.schemaVersion,
    base_url: config.baseUrl,
    root_page_id: config.rootPageId,
    root_page_url: config.rootPageUrl,
    write_scope: config.writeScope,
    include_root: config.includeRoot,
    credential_ref: config.credentialRef,
  };
  document.integrations = integrations;

  const temporary = `${path}.tmp-${process.pid}`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(temporary, dump(document, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  }), { encoding: 'utf8', mode });
  renameSync(temporary, path);
  return path;
}

export function writePortalIntegration(config: PortalIntegrationConfig): string {
  const paths = repoPaths();
  const path = resolve(paths.contextDir, 'project.yaml');
  if (!existsSync(path)) throw new Error('Missing .project-context/project.yaml. Initialize Project Context first.');
  if (lstatSync(path).isSymbolicLink()) throw new Error('.project-context/project.yaml must not be a symbolic link.');
  if (!config.projectKey?.trim() || !config.projectName?.trim()) {
    throw new Error('Portal binding requires the verified project key and name.');
  }

  const document = asObject(load(readFileSync(path, 'utf8')));
  const integrations = asObject(document.integrations);
  integrations.portal = {
    schema_version: config.schemaVersion,
    base_url: config.baseUrl,
    project_id: config.projectId,
    project_key: config.projectKey,
    project_name: config.projectName,
    cache_path: config.cachePath,
    credential_ref: config.credentialRef,
  };
  document.integrations = integrations;

  const temporary = `${path}.tmp-${process.pid}`;
  const mode = statSync(path).mode & 0o777;
  writeFileSync(temporary, dump(document, {
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  }), { encoding: 'utf8', mode });
  renameSync(temporary, path);
  return path;
}

export function contextCliCommand(config: ProjectConfig, subcommand: string): string {
  return `${config.contextRouter.cliCommand} ${subcommand}`.trim();
}

export function retentionNumber(
  config: ProjectConfig,
  section: string,
  field: string,
  fallback: number,
): number {
  const value = config.retention[section]?.[field];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function contextPackCommandsForModules(config: ProjectConfig, modules: string[]): string[] {
  return [...new Set(Object.values(config.commandMetadata)
    .filter((command) => command.includeInContextPack === true)
    .filter((command) => command.requiredFor.some((module) => modules.includes(module)))
    .map((command) => command.run))];
}

function parseModules(input: Record<string, unknown>): Record<string, ProjectModuleConfig> {
  return Object.fromEntries(Object.entries(input).flatMap(([name, raw]) => {
    const module = asObject(raw);
    const path = stringValue(module.path);
    if (!path) return [];
    return [[name, {
      path,
      stack: stringValue(module.stack) || undefined,
      playbooks: stringArray(module.playbooks),
      aliases: stringArray(module.aliases),
      sourceGlobs: stringArray(module.source_globs),
    } satisfies ProjectModuleConfig]];
  }));
}

function parseProject(input: Record<string, unknown>, root: string): ProjectMetadataConfig {
  return {
    name: stringValue(input.name) || basename(root),
    repository: stringValue(input.repository) || undefined,
    contextVersion: numberValue(input.context_version),
    timezone: stringValue(input.timezone) || undefined,
    purpose: stringValue(input.purpose) || undefined,
    roles: stringArray(input.roles),
    flows: stringArray(input.flows),
  };
}

function parseRouting(input: Record<string, unknown>): ProjectRoutingConfig {
  return {
    defaultModules: stringArray(input.default_modules),
    documentationModules: stringArray(input.documentation_modules),
  };
}

function parseContextRouter(input: Record<string, unknown>): ContextRouterConfig {
  return {
    packagePath: stringValue(input.package_path) || undefined,
    cliCommand: stringValue(input.cli_command) || 'project-context',
    installCommand: stringValue(input.install_command) || undefined,
    mcpServerName: stringValue(input.mcp_server_name) || 'project_context',
    resourceScheme: stringValue(input.resource_scheme) || 'project-context',
    codexConfigPath: optionalPath(input.codex_config_path),
    codexHooksPath: optionalPath(input.codex_hooks_path),
    requiredHookEvents: stringArray(input.required_hook_events),
    gitHooksPath: optionalPath(input.git_hooks_path),
    gitHooksInstallCommand: stringValue(input.git_hooks_install_command) || undefined,
    cacheDependencyFiles: stringArray(input.cache_dependency_files),
    brand: parseContextRouterBrand(asObject(input.brand)),
  };
}

function parseIntegrations(input: Record<string, unknown>): ProjectIntegrationsConfig {
  const integrations: ProjectIntegrationsConfig = {};
  const confluence = asObject(input.confluence);
  const confluenceBaseUrl = stringValue(confluence.base_url);
  const rootPageId = stringValue(confluence.root_page_id);
  const rootPageUrl = stringValue(confluence.root_page_url);
  const writeScope = stringValue(confluence.write_scope);
  const confluenceCredentialRef = stringValue(confluence.credential_ref);
  if (confluenceBaseUrl && rootPageId && rootPageUrl && writeScope === 'root-and-descendants') {
    integrations.confluence = {
      schemaVersion: numberValue(confluence.schema_version) ?? 1,
      baseUrl: confluenceBaseUrl,
      rootPageId,
      rootPageUrl,
      writeScope,
      includeRoot: booleanValue(confluence.include_root) ?? true,
      credentialRef: confluenceCredentialRef || 'native:project-context-confluence/CONFLUENCE_PERSONAL_TOKEN',
    };
  }

  const portal = asObject(input.portal);
  const portalBaseUrl = stringValue(portal.base_url);
  const projectId = stringValue(portal.project_id);
  const projectKey = stringValue(portal.project_key);
  const projectName = stringValue(portal.project_name);
  if (portalBaseUrl && projectId) {
    integrations.portal = {
      schemaVersion: numberValue(portal.schema_version) ?? 1,
      baseUrl: portalBaseUrl,
      projectId,
      ...(projectKey ? { projectKey } : {}),
      ...(projectName ? { projectName } : {}),
      cachePath: stringValue(portal.cache_path) || '.project-context/indexes/portal',
      credentialRef: stringValue(portal.credential_ref)
        || 'native:project-context-hub/PROJECT_CONTEXT_HUB_TOKEN',
    };
  }
  return integrations;
}

function parseContextRouterBrand(input: Record<string, unknown>): ContextRouterBrandConfig {
  const defaults = defaultContextRouterBrand();
  return {
    name: stringValue(input.name) || defaults.name,
    shortName: stringValue(input.short_name) || defaults.shortName,
    marker: stringValue(input.marker) || defaults.marker,
    logoText: stringValue(input.logo_text) || defaults.logoText,
    description: stringValue(input.description) || defaults.description,
  };
}

function defaultContextRouterBrand(): ContextRouterBrandConfig {
  return {
    name: 'Project Context Router',
    shortName: 'Project Context',
    marker: 'PROJECT_CONTEXT',
    logoText: '[Project Context]',
    description: 'local-first project memory, backlog, and verification router',
  };
}

function parseCommands(input: Record<string, unknown>): Record<string, ProjectCommandConfig> {
  return Object.fromEntries(Object.entries(input).flatMap(([name, raw]) => {
    if (typeof raw === 'string') {
      return [[name, commandConfig(raw)]];
    }
    const block = asObject(raw);
    const run = stringValue(block.run);
    if (!run) return [];
    return [[name, {
      run,
      requiredFor: stringArray(block.required_for),
      timeoutSeconds: numberValue(block.timeout_seconds),
      network: booleanValue(block.network),
      writesTo: stringArray(block.writes_to),
      ciEquivalent: stringValue(block.ci_equivalent) || undefined,
      includeInContextPack: booleanValue(block.context_pack),
    } satisfies ProjectCommandConfig]];
  }));
}

function commandConfig(run: string): ProjectCommandConfig {
  return { run, requiredFor: [], writesTo: [] };
}

function parseRetention(input: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(input).flatMap(([name, raw]) => {
    const value = asObject(raw);
    return Object.keys(value).length > 0 ? [[name, value]] : [];
  }));
}

function parseSpecifications(input: Record<string, unknown>): ProjectConfig['specifications'] {
  const current = asObject(input.current);
  if (Object.keys(current).length === 0) return {};
  return {
    current: {
      includeInContextPack: booleanValue(current.include_in_context_pack) ?? false,
      files: stringArray(current.files),
      runbook: stringValue(current.runbook) || undefined,
      modules: stringArray(current.modules),
    },
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function optionalPath(value: unknown): string | undefined {
  if (value === false || value === null) return undefined;
  return stringValue(value) || undefined;
}
