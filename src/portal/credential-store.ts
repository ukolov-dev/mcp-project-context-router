import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  normalizePortalIssuerUrl,
  type PortalOAuthCredential,
} from './device-auth.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const windowsScript = resolve(packageRoot, 'scripts', 'windows-portal-credential.ps1');
const macosScript = resolve(packageRoot, 'scripts', 'macos-portal-credential.js');

export const portalCredentialService = 'project-context-hub';
export const portalCredentialAccount = 'PROJECT_CONTEXT_HUB_TOKEN';

type CredentialOperation = 'store' | 'lookup' | 'delete';
type Spawn = typeof spawnSync;

export type PortalCredentialOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  windowsScript?: string;
  macosScript?: string;
  fetch?: typeof fetch;
  now?: () => Date;
};

type Backend = {
  name: string;
  command: string;
  store: string[];
  lookup: string[];
  delete: string[];
  isMissing: (result: SpawnSyncReturns<string | Buffer>) => boolean;
};

function backend(
  platform: NodeJS.Platform = process.platform,
  windowsScriptPath = windowsScript,
  macosScriptPath = macosScript,
): Backend {
  if (platform === 'darwin') {
    const common = ['-l', 'JavaScript', macosScriptPath];
    return {
      name: 'macOS Keychain',
      command: '/usr/bin/osascript',
      store: [...common, 'store',
        portalCredentialService,
        portalCredentialAccount,
        'Project Context Hub access token',
      ],
      lookup: [...common, 'lookup', portalCredentialService, portalCredentialAccount],
      delete: [...common, 'delete', portalCredentialService, portalCredentialAccount],
      isMissing: () => false,
    };
  }
  if (platform === 'linux') {
    return {
      name: 'Linux Secret Service',
      command: 'secret-tool',
      store: [
        'store',
        '--label=Project Context Hub access token',
        'service',
        portalCredentialService,
        'account',
        portalCredentialAccount,
      ],
      lookup: ['lookup', 'service', portalCredentialService, 'account', portalCredentialAccount],
      delete: ['clear', 'service', portalCredentialService, 'account', portalCredentialAccount],
      isMissing: (result) => result.status === 1 && !String(result.stderr ?? '').trim(),
    };
  }
  if (platform === 'win32') {
    const common = [
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      windowsScriptPath,
      '-Action',
    ];
    return {
      name: 'Windows Credential Locker',
      command: 'powershell.exe',
      store: [...common, 'store'],
      lookup: [...common, 'lookup'],
      delete: [...common, 'delete'],
      isMissing: (result) => result.status === 3,
    };
  }
  throw new Error(
    `Unsupported platform for native Portal credential storage: ${platform}. `
    + 'Use PROJECT_CONTEXT_HUB_TOKEN in the process environment.',
  );
}

function backendHint(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'Install secret-tool (usually libsecret-tools) and use an unlocked Secret Service.';
  }
  if (platform === 'win32') return 'Windows PowerShell and Credential Locker are required.';
  if (platform === 'darwin') return 'JavaScript for Automation and an unlocked macOS login keychain are required.';
  return 'Use PROJECT_CONTEXT_HUB_TOKEN in the process environment.';
}

const oauthCredentialSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('oauth-device'),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
});

function run(operation: CredentialOperation, options: PortalCredentialOptions = {}, value?: string) {
  const platform = options.platform ?? process.platform;
  const selected = backend(
    platform,
    options.windowsScript ?? windowsScript,
    options.macosScript ?? macosScript,
  );
  const spawn = options.spawn ?? spawnSync;
  const capture = operation === 'lookup';
  const automaticStore = operation === 'store' && value !== undefined;
  const result = spawn(selected.command, selected[operation], {
    encoding: capture || automaticStore ? 'utf8' : undefined,
    ...(automaticStore ? { input: `${value}\n` } : {}),
    shell: false,
    stdio: capture
      ? ['ignore', 'pipe', 'pipe']
      : automaticStore
        ? ['pipe', 'ignore', 'pipe']
        : 'inherit',
    windowsHide: false,
  });
  if (result.error) {
    throw new Error(`${selected.name} is unavailable. ${backendHint(platform)}`, { cause: result.error });
  }
  return { result, selected, platform };
}

function failure(operation: string, selected: Backend, platform: NodeJS.Platform): Error {
  return new Error(`${selected.name} failed to ${operation} the Portal credential. ${backendHint(platform)}`);
}

export function storePortalCredential(options: PortalCredentialOptions = {}): void {
  const { result, selected, platform } = run('store', options);
  if (result.status !== 0) throw failure('store', selected, platform);
}

export function storePortalOAuthCredential(
  credential: PortalOAuthCredential,
  options: PortalCredentialOptions = {},
): void {
  const serialized = JSON.stringify(oauthCredentialSchema.parse(credential));
  const { result, selected, platform } = run('store', options, serialized);
  if (result.status !== 0) throw failure('store', selected, platform);
}

export function getStoredPortalCredential(options: PortalCredentialOptions = {}): string | null {
  const { result, selected, platform } = run('lookup', options);
  if (result.status !== 0) {
    if (selected.isMissing(result)) return null;
    throw failure('read', selected, platform);
  }
  const credential = String(result.stdout ?? '').replace(/\r?\n$/, '');
  return credential || null;
}

export function resolvePortalCredential(options: PortalCredentialOptions = {}): {
  token: string;
  source: 'environment' | 'native-store';
} {
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment.PROJECT_CONTEXT_HUB_TOKEN;
  if (fromEnvironment) return { token: fromEnvironment, source: 'environment' };
  const stored = getStoredPortalCredential(options);
  if (stored) {
    const oauthCredential = parseOAuthCredential(stored);
    if (!oauthCredential) return { token: stored, source: 'native-store' };
    if (new Date(oauthCredential.accessTokenExpiresAt).getTime() > (options.now?.() ?? new Date()).getTime() + 30_000) {
      return { token: oauthCredential.accessToken, source: 'native-store' };
    }
    throw new Error('Stored Portal access token expired. Run `project-context portal auth` to refresh the browser session.');
  }
  throw new Error(
    'Portal credential is missing. Run `project-context portal auth` '
    + 'or set PROJECT_CONTEXT_HUB_TOKEN for this process.',
  );
}

export async function resolvePortalAccessToken(options: PortalCredentialOptions = {}): Promise<{
  token: string;
  source: 'environment' | 'native-store';
}> {
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment.PROJECT_CONTEXT_HUB_TOKEN;
  if (fromEnvironment) return { token: fromEnvironment, source: 'environment' };
  const stored = getStoredPortalCredential(options);
  if (!stored) {
    throw new Error(
      'Portal credential is missing. Run `project-context portal auth` '
      + 'or set PROJECT_CONTEXT_HUB_TOKEN for this process.',
    );
  }
  const oauthCredential = parseOAuthCredential(stored);
  if (!oauthCredential) return { token: stored, source: 'native-store' };
  const now = options.now?.() ?? new Date();
  if (new Date(oauthCredential.accessTokenExpiresAt).getTime() > now.getTime() + 30_000) {
    return { token: oauthCredential.accessToken, source: 'native-store' };
  }
  const issuerUrl = normalizePortalIssuerUrl(
    oauthCredential.issuerUrl,
    environment.PROJECT_CONTEXT_ALLOW_INSECURE_LOCAL_PORTAL === 'true',
  );
  const response = await (options.fetch ?? fetch)(`${issuerUrl}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauthCredential.clientId,
      refresh_token: oauthCredential.refreshToken,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json() as {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
    error_description?: unknown;
  };
  if (!response.ok
    || typeof payload.access_token !== 'string'
    || typeof payload.expires_in !== 'number'
    || !Number.isInteger(payload.expires_in)
    || payload.expires_in <= 0) {
    throw new Error(
      typeof payload.error_description === 'string'
        ? payload.error_description
        : 'Portal browser session expired. Run `project-context portal auth` again.',
    );
  }
  const refreshed: PortalOAuthCredential = {
    ...oauthCredential,
    accessToken: payload.access_token,
    refreshToken: typeof payload.refresh_token === 'string'
      ? payload.refresh_token
      : oauthCredential.refreshToken,
    accessTokenExpiresAt: new Date(now.getTime() + payload.expires_in * 1_000).toISOString(),
  };
  storePortalOAuthCredential(refreshed, options);
  return { token: refreshed.accessToken, source: 'native-store' };
}

export function portalCredentialSource(
  options: PortalCredentialOptions = {},
): 'environment' | 'native-store' | 'missing' {
  const environment = options.environment ?? process.env;
  if (environment.PROJECT_CONTEXT_HUB_TOKEN) return 'environment';
  return getStoredPortalCredential(options) ? 'native-store' : 'missing';
}

function parseOAuthCredential(value: string): PortalOAuthCredential | null {
  if (!value.startsWith('{')) return null;
  try {
    return oauthCredentialSchema.parse(JSON.parse(value));
  } catch {
    throw new Error('Stored Portal OAuth credential is invalid. Run `project-context portal auth` again.');
  }
}
