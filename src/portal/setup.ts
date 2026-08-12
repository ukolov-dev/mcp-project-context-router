import { createInterface } from 'node:readline/promises';
import {
  loadProjectConfig,
  writePortalIntegration,
  type PortalIntegrationConfig,
} from '../storage/config.js';
import { PortalClient, normalizePortalBaseUrl } from './client.js';
import {
  portalCredentialSource,
  resolvePortalAccessToken,
  storePortalCredential,
  storePortalOAuthCredential,
} from './credential-store.js';
import {
  authorizePortalDevice,
  type PortalOAuthCredential,
} from './device-auth.js';
import {
  getAssignedPortalWork,
  portalSyncStatus,
  syncPortalSnapshot,
} from './bridge.js';

export const portalCredentialRef = 'native:vincenzo-context-hub/VINCENZO_CONTEXT_HUB_TOKEN';

type SetupDependencies = {
  client?: PortalClient;
  credentialSource?: typeof portalCredentialSource;
  resolveCredential?: (options: { environment?: NodeJS.ProcessEnv }) =>
    | { token: string; source: 'environment' | 'native-store' }
    | Promise<{ token: string; source: 'environment' | 'native-store' }>;
  storeCredential?: typeof storePortalCredential;
  storeOAuthCredential?: typeof storePortalOAuthCredential;
  authorizeDevice?: typeof authorizePortalDevice;
  writeIntegration?: typeof writePortalIntegration;
  syncSnapshot?: typeof syncPortalSnapshot;
  getAssignedWork?: typeof getAssignedPortalWork;
  prompt?: (question: string) => Promise<string>;
};

export async function authenticatePortal(
  options: {
    baseUrl: string;
    projectId: string;
    issuerUrl?: string;
    clientId?: string;
    nonInteractive?: boolean;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies: SetupDependencies = {},
) {
  const source = (dependencies.credentialSource ?? portalCredentialSource)({ environment: options.environment });
  let browserCredential: PortalOAuthCredential | undefined;
  if (source === 'missing') {
    if (options.nonInteractive) {
      throw new Error(
        'Non-interactive Portal auth requires VINCENZO_CONTEXT_HUB_TOKEN or an existing native credential.',
      );
    }
    if (options.issuerUrl || options.clientId) {
      if (!options.issuerUrl || !options.clientId) {
        throw new Error('Portal browser auth requires both --issuer-url and --client-id.');
      }
      browserCredential = await (dependencies.authorizeDevice ?? authorizePortalDevice)({
        issuerUrl: options.issuerUrl,
        clientId: options.clientId,
        allowInsecureDevelopment: options.environment?.VINCENZO_ALLOW_INSECURE_LOCAL_PORTAL === 'true'
          || (options.environment === undefined && process.env.VINCENZO_ALLOW_INSECURE_LOCAL_PORTAL === 'true'),
      });
      (dependencies.storeOAuthCredential ?? storePortalOAuthCredential)(
        browserCredential,
        { environment: options.environment },
      );
    } else {
      (dependencies.storeCredential ?? storePortalCredential)();
    }
  }
  const credential = browserCredential
    ? { token: browserCredential.accessToken, source: 'native-store' as const }
    : await (dependencies.resolveCredential ?? resolvePortalAccessToken)({
      environment: options.environment,
    });
  const allowInsecureDevelopment = options.environment?.VINCENZO_ALLOW_INSECURE_LOCAL_PORTAL === 'true'
    || (options.environment === undefined && process.env.VINCENZO_ALLOW_INSECURE_LOCAL_PORTAL === 'true');
  const baseUrl = normalizePortalBaseUrl(options.baseUrl, allowInsecureDevelopment);
  const client = dependencies.client ?? new PortalClient(baseUrl, credential.token, { allowInsecureDevelopment });
  const project = await client.getProject(options.projectId);
  return {
    status: 'authenticated' as const,
    baseUrl,
    project: {
      id: String(project.id),
      key: String(project.key),
      name: String(project.name),
    },
    credentialSource: credential.source,
  };
}

export async function setupPortal(
  options: {
    baseUrl: string;
    projectId: string;
    issuerUrl?: string;
    clientId?: string;
    yes?: boolean;
    nonInteractive?: boolean;
    environment?: NodeJS.ProcessEnv;
  },
  dependencies: SetupDependencies = {},
) {
  const auth = await authenticatePortal(options, dependencies);
  const existing = loadProjectConfig().integrations.portal;
  const unchanged = existing?.baseUrl === auth.baseUrl
    && existing.projectId === options.projectId
    && existing.projectKey === auth.project.key
    && existing.projectName === auth.project.name;
  if (!unchanged && !options.yes) {
    if (options.nonInteractive) throw new Error('Non-interactive Portal setup requires --yes.');
    const answer = await ask(
      dependencies,
      `Bind this repository to Portal project "${auth.project.name}" [${auth.project.key}] (${auth.project.id})? [y/N] `,
    );
    if (!/^y(?:es)?$/i.test(answer.trim())) throw new Error('Portal project binding was not confirmed.');
  }
  let configPath: string | undefined;
  if (!unchanged) {
    const binding: PortalIntegrationConfig = {
      schemaVersion: 2,
      baseUrl: auth.baseUrl,
      projectId: options.projectId,
      projectKey: auth.project.key,
      projectName: auth.project.name,
      cachePath: '.project-context/indexes/portal',
      credentialRef: portalCredentialRef,
    };
    configPath = (dependencies.writeIntegration ?? writePortalIntegration)(binding);
  }
  const bridgeDependencies = dependencies.client ? { client: dependencies.client } : {};
  const [snapshotResult, assignedResult] = await Promise.allSettled([
    (dependencies.syncSnapshot ?? syncPortalSnapshot)({}, bridgeDependencies),
    (dependencies.getAssignedWork ?? getAssignedPortalWork)(bridgeDependencies),
  ]);
  const snapshot = snapshotResult.status === 'fulfilled'
    ? {
      status: 'ready' as const,
      id: snapshotResult.value.snapshot.id,
      digest: snapshotResult.value.snapshot.digest,
      documentCount: snapshotResult.value.snapshot.documents.length,
      freshness: snapshotResult.value.freshness,
    }
    : {
      status: 'unavailable' as const,
      error: errorMessage(snapshotResult.reason),
    };
  const assignedWork = assignedResult.status === 'fulfilled'
    ? {
      status: 'ready' as const,
      authority: assignedResult.value.authority,
      count: assignedResult.value.workItems.length,
      workItems: assignedResult.value.workItems,
    }
    : {
      status: 'unavailable' as const,
      authority: 'portal' as const,
      count: 0,
      workItems: [],
      error: errorMessage(assignedResult.reason),
    };
  return {
    status: unchanged ? 'unchanged' : 'bound',
    ready: snapshot.status === 'ready' && assignedWork.status === 'ready',
    auth,
    binding: {
      authority: 'portal',
      projectId: options.projectId,
      projectKey: auth.project.key,
      projectName: auth.project.name,
      baseUrl: auth.baseUrl,
      cachePath: '.project-context/indexes/portal',
      configPath,
    },
    snapshot,
    assignedWork,
  };
}

export async function portalDoctor(
  options: { environment?: NodeJS.ProcessEnv } = {},
  dependencies: SetupDependencies = {},
) {
  const binding = loadProjectConfig().integrations.portal;
  const checks: Array<{ name: string; status: 'pass' | 'fail'; detail: string }> = [];
  if (!binding) {
    return {
      ok: false,
      credentialSource: 'missing' as const,
      checks: [{ name: 'project-binding', status: 'fail' as const, detail: 'Portal project is not bound.' }],
    };
  }
  if (!binding.projectKey || !binding.projectName) {
    checks.push({
      name: 'project-binding',
      status: 'fail',
      detail: 'Portal binding lacks verified project key/name. Run `vincenzo portal setup` again.',
    });
  } else {
    checks.push({
      name: 'project-binding',
      status: 'pass',
      detail: `${binding.projectName} [${binding.projectKey}] · ${binding.projectId} @ ${binding.baseUrl}`,
    });
  }
  const credentialSource = (dependencies.credentialSource ?? portalCredentialSource)({
    environment: options.environment,
  });
  if (credentialSource === 'missing') {
    checks.push({ name: 'credential', status: 'fail', detail: 'No environment or native-store token is available.' });
    return { ok: false, credentialSource, checks, sync: portalSyncStatus() };
  }
  checks.push({ name: 'credential', status: 'pass', detail: credentialSource });
  try {
    const credential = await (dependencies.resolveCredential ?? resolvePortalAccessToken)({
      environment: options.environment,
    });
    const client = dependencies.client ?? new PortalClient(binding.baseUrl, credential.token);
    const project = await client.getProject(binding.projectId);
    const remoteKey = String(project.key);
    const remoteName = String(project.name);
    if (!binding.projectKey || !binding.projectName
      || remoteKey !== binding.projectKey || remoteName !== binding.projectName) {
      checks.push({
        name: 'project-identity',
        status: 'fail',
        detail: `Remote project is ${remoteName} [${remoteKey}]; re-run setup before sync.`,
      });
      return {
        ok: false,
        credentialSource,
        checks,
        sync: portalSyncStatus(),
      };
    }
    checks.push({
      name: 'project-identity',
      status: 'pass',
      detail: `${remoteName} [${remoteKey}] · ${binding.projectId}`,
    });
    checks.push({ name: 'membership', status: 'pass', detail: `${remoteKey} · ${remoteName}` });
    const synced = await syncPortalSnapshot({}, { client });
    checks.push({
      name: 'snapshot',
      status: synced.freshness.state === 'fresh' ? 'pass' : 'fail',
      detail: `${synced.snapshot.id} · ${synced.snapshot.digest}`,
    });
  } catch (error) {
    checks.push({
      name: 'portal-api',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    ok: checks.every((check) => check.status === 'pass'),
    credentialSource,
    checks,
    sync: portalSyncStatus(),
  };
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
