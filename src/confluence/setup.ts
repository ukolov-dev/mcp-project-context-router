import { createInterface } from 'node:readline/promises';
import {
  confluenceCredentialSource,
  resolveConfluenceCredential,
  storeConfluenceCredential,
} from './credential-store.js';
import {
  ConfluenceClient,
  defaultConfluenceBaseUrl,
  pageAllows,
  parseConfluenceRootPageUrl,
} from './client.js';
import {
  loadProjectConfig,
  writeConfluenceIntegration,
  type ConfluenceIntegrationConfig,
} from '../storage/config.js';

export const confluenceCredentialRef = 'native:vincenzo-confluence/CONFLUENCE_PERSONAL_TOKEN';

type ClientFactory = (baseUrl: string, token: string) => ConfluenceClient;

type SetupDependencies = {
  createClient?: ClientFactory;
  credentialSource?: typeof confluenceCredentialSource;
  resolveCredential?: typeof resolveConfluenceCredential;
  storeCredential?: typeof storeConfluenceCredential;
  writeIntegration?: typeof writeConfluenceIntegration;
  prompt?: (question: string) => Promise<string>;
};

export type ConfluenceAuthResult = {
  status: 'authenticated';
  baseUrl: string;
  credentialSource: 'environment' | 'native-store';
  user: {
    username?: string;
    displayName?: string;
  };
};

export type ConfluenceBindResult = {
  status: 'bound' | 'unchanged';
  root: {
    pageId: string;
    pageUrl: string;
    title: string;
    spaceKey?: string;
    ancestors: Array<{ id: string; title?: string }>;
  };
  scope: 'root-and-descendants';
  includeRoot: boolean;
  permissions: {
    updateRoot: boolean;
    createChildren: 'deferred-to-apply';
  };
  credentialSource: 'environment' | 'native-store';
  configPath?: string;
};

export async function authenticateConfluence(
  options: {
    baseUrl?: string;
    nonInteractive?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
  dependencies: SetupDependencies = {},
): Promise<ConfluenceAuthResult> {
  const baseUrl = options.baseUrl ?? defaultConfluenceBaseUrl;
  const credentialSource = dependencies.credentialSource ?? confluenceCredentialSource;
  const storeCredential = dependencies.storeCredential ?? storeConfluenceCredential;
  const resolveCredential = dependencies.resolveCredential ?? resolveConfluenceCredential;
  const source = credentialSource({ environment: options.environment });
  if (source === 'missing') {
    if (options.nonInteractive) {
      throw new Error('Non-interactive Confluence auth requires CONFLUENCE_PERSONAL_TOKEN or an existing native credential.');
    }
    storeCredential();
  }
  const credential = resolveCredential({ environment: options.environment });
  const client = createClient(dependencies, baseUrl, credential.token);
  const identity = await client.getCurrentUser();
  return {
    status: 'authenticated',
    baseUrl: client.baseUrl,
    credentialSource: credential.source,
    user: {
      username: identity.username,
      displayName: identity.displayName,
    },
  };
}

export async function bindConfluenceRoot(
  options: {
    rootPageUrl: string;
    includeRoot?: boolean;
    allowReplace?: boolean;
    yes?: boolean;
    nonInteractive?: boolean;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies: SetupDependencies = {},
): Promise<ConfluenceBindResult> {
  const parsed = parseConfluenceRootPageUrl(options.rootPageUrl);
  const resolveCredential = dependencies.resolveCredential ?? resolveConfluenceCredential;
  const credential = resolveCredential({ environment: options.environment });
  const client = createClient(dependencies, parsed.baseUrl, credential.token);
  await client.getCurrentUser();
  const page = await client.getPage(parsed.rootPageId);
  const permissions = {
    updateRoot: pageAllows(page, 'update'),
    createChildren: 'deferred-to-apply' as const,
  };
  const existing = loadProjectConfig().integrations.confluence;
  const includeRoot = options.includeRoot ?? true;
  if (includeRoot && !permissions.updateRoot) {
    throw new Error(`Confluence root page ${page.id} requires update-page permission when root updates are included.`);
  }
  const sameBinding = existing?.baseUrl === parsed.baseUrl
    && existing.rootPageId === parsed.rootPageId
    && existing.includeRoot === includeRoot;
  if (sameBinding) {
    return resultForBinding('unchanged', page, parsed.rootPageUrl, includeRoot, permissions, credential.source);
  }
  if (existing && !options.allowReplace) {
    throw new Error(`Confluence root is already bound to page ${existing.rootPageId}. Use confluence rebind to change it.`);
  }

  if (!options.yes) {
    if (options.nonInteractive) {
      throw new Error('Non-interactive Confluence bind requires --yes.');
    }
    const answer = await ask(
      dependencies,
      `Bind project Confluence root to "${page.title}" (${page.id}) and allow writes only in this subtree? [y/N] `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Confluence root binding was not confirmed.');
  }

  const integration: ConfluenceIntegrationConfig = {
    schemaVersion: 1,
    baseUrl: parsed.baseUrl,
    rootPageId: parsed.rootPageId,
    rootPageUrl: parsed.rootPageUrl,
    writeScope: 'root-and-descendants',
    includeRoot,
    credentialRef: confluenceCredentialRef,
  };
  const configPath = (dependencies.writeIntegration ?? writeConfluenceIntegration)(integration);
  return {
    ...resultForBinding('bound', page, parsed.rootPageUrl, includeRoot, permissions, credential.source),
    configPath,
  };
}

export async function setupConfluence(
  options: {
    rootPageUrl?: string;
    includeRoot?: boolean;
    yes?: boolean;
    nonInteractive?: boolean;
    environment?: NodeJS.ProcessEnv;
  } = {},
  dependencies: SetupDependencies = {},
): Promise<{ auth: ConfluenceAuthResult; binding: ConfluenceBindResult }> {
  const auth = await authenticateConfluence({
    nonInteractive: options.nonInteractive,
    environment: options.environment,
  }, dependencies);
  let rootPageUrl = options.rootPageUrl;
  if (!rootPageUrl) {
    if (options.nonInteractive) throw new Error('Non-interactive Confluence setup requires --root-page.');
    rootPageUrl = (await ask(dependencies, 'Confluence root page URL: ')).trim();
  }
  if (!rootPageUrl) throw new Error('Confluence root page URL is required.');
  const binding = await bindConfluenceRoot({
    rootPageUrl,
    includeRoot: options.includeRoot,
    yes: options.yes,
    nonInteractive: options.nonInteractive,
    environment: options.environment,
  }, dependencies);
  return { auth, binding };
}

export async function confluenceDoctor(
  options: { environment?: NodeJS.ProcessEnv } = {},
  dependencies: SetupDependencies = {},
): Promise<{
  ok: boolean;
  root?: { pageId: string; title: string; spaceKey?: string };
  credentialSource: 'environment' | 'native-store' | 'missing';
  checks: Array<{ name: string; status: 'pass' | 'fail'; detail: string }>;
}> {
  const checks: Array<{ name: string; status: 'pass' | 'fail'; detail: string }> = [];
  const config = loadProjectConfig().integrations.confluence;
  if (!config) {
    return {
      ok: false,
      credentialSource: 'missing',
      checks: [{ name: 'project-root', status: 'fail', detail: 'Confluence root is not bound for this project.' }],
    };
  }
  checks.push({ name: 'project-root', status: 'pass', detail: `${config.rootPageId} · ${config.writeScope}` });
  const credentialSource = (dependencies.credentialSource ?? confluenceCredentialSource)({ environment: options.environment });
  if (credentialSource === 'missing') {
    checks.push({ name: 'credential', status: 'fail', detail: 'No environment or native-store credential is available.' });
    return { ok: false, credentialSource, checks };
  }
  checks.push({ name: 'credential', status: 'pass', detail: credentialSource });

  try {
    const credential = (dependencies.resolveCredential ?? resolveConfluenceCredential)({ environment: options.environment });
    const client = createClient(dependencies, config.baseUrl, credential.token);
    const identity = await client.getCurrentUser();
    checks.push({
      name: 'identity',
      status: 'pass',
      detail: identity.displayName || identity.username || 'authenticated',
    });
    const page = await client.getPage(config.rootPageId);
    checks.push({ name: 'root-reachable', status: 'pass', detail: `${page.title} (${page.id})` });
    const update = pageAllows(page, 'update');
    const effective = !config.includeRoot || update;
    checks.push({
      name: 'root-permissions',
      status: effective ? 'pass' : 'fail',
      detail: `update=${update} create-child=deferred-to-apply include-root=${config.includeRoot}`,
    });
    return {
      ok: checks.every((check) => check.status === 'pass'),
      root: { pageId: page.id, title: page.title, spaceKey: page.space?.key },
      credentialSource,
      checks,
    };
  } catch (error) {
    checks.push({
      name: 'confluence-api',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, credentialSource, checks };
  }
}

function createClient(dependencies: SetupDependencies, baseUrl: string, token: string): ConfluenceClient {
  return dependencies.createClient?.(baseUrl, token) ?? new ConfluenceClient(baseUrl, token);
}

async function ask(dependencies: SetupDependencies, question: string): Promise<string> {
  if (dependencies.prompt) return dependencies.prompt(question);
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

function resultForBinding(
  status: 'bound' | 'unchanged',
  page: Awaited<ReturnType<ConfluenceClient['getPage']>>,
  pageUrl: string,
  includeRoot: boolean,
  permissions: { updateRoot: boolean; createChildren: 'deferred-to-apply' },
  credentialSource: 'environment' | 'native-store',
): ConfluenceBindResult {
  return {
    status,
    root: {
      pageId: page.id,
      pageUrl,
      title: page.title,
      spaceKey: page.space?.key,
      ancestors: page.ancestors,
    },
    scope: 'root-and-descendants',
    includeRoot,
    permissions,
    credentialSource,
  };
}
