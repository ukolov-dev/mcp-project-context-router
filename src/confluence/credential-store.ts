import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const windowsScript = resolve(packageRoot, 'scripts', 'windows-confluence-credential.ps1');

export const confluenceCredentialService = 'vincenzo-confluence';
export const confluenceCredentialAccount = 'CONFLUENCE_PERSONAL_TOKEN';

type SupportedPlatform = 'darwin' | 'linux' | 'win32';
type CredentialOperation = 'store' | 'lookup' | 'delete';
type Spawn = typeof spawnSync;

type CredentialOptions = {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: Spawn;
  windowsScript?: string;
};

type Backend = {
  name: string;
  command: string;
  store: string[];
  lookup: string[];
  delete: string[];
  isMissing: (result: SpawnSyncReturns<string | Buffer>) => boolean;
};

function backend(platform: NodeJS.Platform = process.platform, scriptPath = windowsScript): Backend {
  if (platform === 'darwin') {
    return {
      name: 'macOS Keychain',
      command: '/usr/bin/security',
      store: [
        'add-generic-password',
        '-U',
        '-a',
        confluenceCredentialAccount,
        '-s',
        confluenceCredentialService,
        '-l',
        'Vincenzo Confluence personal access token',
        '-w',
      ],
      lookup: [
        'find-generic-password',
        '-a',
        confluenceCredentialAccount,
        '-s',
        confluenceCredentialService,
        '-w',
      ],
      delete: [
        'delete-generic-password',
        '-a',
        confluenceCredentialAccount,
        '-s',
        confluenceCredentialService,
      ],
      isMissing: (result) => result.status === 44,
    };
  }
  if (platform === 'linux') {
    return {
      name: 'Linux Secret Service',
      command: 'secret-tool',
      store: [
        'store',
        '--label=Vincenzo Confluence personal access token',
        'service',
        confluenceCredentialService,
        'account',
        confluenceCredentialAccount,
      ],
      lookup: [
        'lookup',
        'service',
        confluenceCredentialService,
        'account',
        confluenceCredentialAccount,
      ],
      delete: [
        'clear',
        'service',
        confluenceCredentialService,
        'account',
        confluenceCredentialAccount,
      ],
      isMissing: (result) => result.status === 1 && !String(result.stderr ?? '').trim(),
    };
  }
  if (platform === 'win32') {
    const common = ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Action'];
    return {
      name: 'Windows Credential Locker',
      command: 'powershell.exe',
      store: [...common, 'store'],
      lookup: [...common, 'lookup'],
      delete: [...common, 'delete'],
      isMissing: (result) => result.status === 3,
    };
  }
  throw new Error(`Unsupported platform for native Confluence credential storage: ${platform}. Use CONFLUENCE_PERSONAL_TOKEN in the process environment.`);
}

function backendHint(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'Install secret-tool (usually libsecret-tools) and use an unlocked Secret Service for the current user.';
  }
  if (platform === 'win32') return 'Windows PowerShell and Credential Locker are required.';
  if (platform === 'darwin') return 'The macOS security command and an unlocked login keychain are required.';
  return 'Use CONFLUENCE_PERSONAL_TOKEN in the process environment.';
}

function run(operation: CredentialOperation, options: CredentialOptions = {}) {
  const platform = options.platform ?? process.platform;
  const selected = backend(platform, options.windowsScript);
  const spawn = options.spawn ?? spawnSync;
  const capture = operation === 'lookup';
  const result = spawn(selected.command, selected[operation], {
    encoding: capture ? 'utf8' : undefined,
    shell: false,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: false,
  });
  if (result.error) {
    throw new Error(`${selected.name} is unavailable. ${backendHint(platform)}`, { cause: result.error });
  }
  return { result, selected, platform };
}

function failure(operation: string, selected: Backend, platform: NodeJS.Platform): Error {
  return new Error(`${selected.name} failed to ${operation} the Confluence credential. ${backendHint(platform)}`);
}

export function storeConfluenceCredential(options: CredentialOptions = {}): void {
  const { result, selected, platform } = run('store', options);
  if (result.status !== 0) throw failure('store', selected, platform);
}

export function getStoredConfluenceCredential(options: CredentialOptions = {}): string | null {
  const { result, selected, platform } = run('lookup', options);
  if (result.status !== 0) {
    if (selected.isMissing(result)) return null;
    throw failure('read', selected, platform);
  }
  const credential = String(result.stdout ?? '').replace(/\r?\n$/, '');
  return credential || null;
}

export function deleteStoredConfluenceCredential(options: CredentialOptions = {}): void {
  const { result, selected, platform } = run('delete', options);
  if (result.status !== 0 && !selected.isMissing(result)) {
    throw failure('delete', selected, platform);
  }
}

export function resolveConfluenceCredential(options: CredentialOptions = {}): {
  token: string;
  source: 'environment' | 'native-store';
} {
  const environment = options.environment ?? process.env;
  const fromEnvironment = environment.CONFLUENCE_PERSONAL_TOKEN;
  if (fromEnvironment) return { token: fromEnvironment, source: 'environment' };
  const stored = getStoredConfluenceCredential(options);
  if (stored) return { token: stored, source: 'native-store' };
  throw new Error('Confluence credential is missing. Run `vincenzo confluence auth` or set CONFLUENCE_PERSONAL_TOKEN for this process.');
}

export function confluenceCredentialSource(options: CredentialOptions = {}): 'environment' | 'native-store' | 'missing' {
  const environment = options.environment ?? process.env;
  if (environment.CONFLUENCE_PERSONAL_TOKEN) return 'environment';
  return getStoredConfluenceCredential(options) ? 'native-store' : 'missing';
}

export function isSupportedCredentialPlatform(platform: NodeJS.Platform): platform is SupportedPlatform {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}
