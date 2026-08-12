import { spawn } from 'node:child_process';
import { z } from 'zod';

const deviceAuthorizationSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});

const oauthErrorSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export type PortalOAuthCredential = {
  schemaVersion: 1;
  kind: 'oauth-device';
  issuerUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
};

type DeviceAuthDependencies = {
  fetch?: typeof fetch;
  now?: () => Date;
  openUrl?: (url: string) => void;
  wait?: (milliseconds: number) => Promise<void>;
  writeStatus?: (message: string) => void;
};

export async function authorizePortalDevice(
  options: {
    issuerUrl: string;
    clientId: string;
    allowInsecureDevelopment?: boolean;
  },
  dependencies: DeviceAuthDependencies = {},
): Promise<PortalOAuthCredential> {
  const issuerUrl = normalizePortalIssuerUrl(options.issuerUrl, options.allowInsecureDevelopment);
  const clientId = normalizeClientId(options.clientId);
  const request = dependencies.fetch ?? fetch;
  const device = deviceAuthorizationSchema.parse(await postForm(
    `${issuerUrl}/protocol/openid-connect/auth/device`,
    { client_id: clientId, scope: 'openid profile' },
    request,
  ));
  const verificationUrl = device.verification_uri_complete ?? device.verification_uri;
  const writeStatus = dependencies.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
  writeStatus(`Откройте ${verificationUrl}`);
  writeStatus(`Код подтверждения: ${device.user_code}`);
  try {
    (dependencies.openUrl ?? openExternalUrl)(verificationUrl);
  } catch {
    writeStatus('Браузер не удалось открыть автоматически; откройте ссылку вручную.');
  }

  const wait = dependencies.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const startedAt = (dependencies.now?.() ?? new Date()).getTime();
  const deadline = startedAt + device.expires_in * 1_000;
  let intervalMs = (device.interval ?? 5) * 1_000;
  while ((dependencies.now?.() ?? new Date()).getTime() < deadline) {
    await wait(intervalMs);
    const response = await request(`${issuerUrl}/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: device.device_code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await responseJson(response);
    if (response.ok) {
      const token = tokenSchema.parse(payload);
      const obtainedAt = dependencies.now?.() ?? new Date();
      return {
        schemaVersion: 1,
        kind: 'oauth-device',
        issuerUrl,
        clientId,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        accessTokenExpiresAt: new Date(obtainedAt.getTime() + token.expires_in * 1_000).toISOString(),
      };
    }
    const oauthError = oauthErrorSchema.parse(payload);
    if (oauthError.error === 'authorization_pending') continue;
    if (oauthError.error === 'slow_down') {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(oauthError.error_description || `Portal authorization failed: ${oauthError.error}.`);
  }
  throw new Error('Portal authorization expired before browser confirmation.');
}

export function normalizePortalIssuerUrl(value: string, allowInsecureDevelopment = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Portal issuer URL cannot contain credentials, query, or fragment.');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || allowInsecureDevelopment))) {
    throw new Error('Portal issuer URL must use HTTPS; HTTP is allowed only for loopback development.');
  }
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') throw new Error('Portal issuer URL must include the realm path.');
  return `${url.origin}${path}`;
}

function normalizeClientId(value: string): string {
  const clientId = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) throw new Error('Portal OAuth client id is invalid.');
  return clientId;
}

async function postForm(url: string, values: Record<string, string>, request: typeof fetch): Promise<unknown> {
  const response = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(values),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await responseJson(response);
  if (response.ok) return payload;
  const oauthError = oauthErrorSchema.safeParse(payload);
  throw new Error(
    oauthError.success
      ? oauthError.data.error_description || `Portal authorization failed: ${oauthError.data.error}.`
      : `Portal authorization failed with HTTP ${response.status}.`,
  );
}

async function responseJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('Portal identity provider returned invalid JSON.');
  }
}

function openExternalUrl(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = '/usr/bin/open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  const child = spawn(command, args, {
    detached: true,
    shell: false,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}
