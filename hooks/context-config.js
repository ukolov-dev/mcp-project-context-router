import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';

const defaults = {
  logoText: '[Project Context]',
  mcpServerName: 'project_context',
  resourceScheme: 'project-context',
  cliCommand: 'project-context',
};

export function loadHookContextConfig(root) {
  const path = resolve(root, '.project-context/project.yaml');
  if (!existsSync(path)) return defaults;
  try {
    const document = asObject(load(readFileSync(path, 'utf8')));
    const router = asObject(document.context_router);
    const brand = asObject(router.brand);
    return {
      logoText: stringValue(brand.logo_text) || defaults.logoText,
      mcpServerName: stringValue(router.mcp_server_name) || defaults.mcpServerName,
      resourceScheme: stringValue(router.resource_scheme) || defaults.resourceScheme,
      cliCommand: stringValue(router.cli_command) || defaults.cliCommand,
    };
  } catch {
    return defaults;
  }
}

function asObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}
