import { describe, expect, it, vi } from 'vitest';
import {
  getStoredPortalCredential,
  resolvePortalAccessToken,
  resolvePortalCredential,
  storePortalOAuthCredential,
} from '../src/portal/credential-store.js';
import type { PortalOAuthCredential } from '../src/portal/device-auth.js';

const credential: PortalOAuthCredential = {
  schemaVersion: 1,
  kind: 'oauth-device',
  issuerUrl: 'https://identity.example.test/realms/project-context',
  clientId: 'project-context-cli',
  accessToken: 'DUMMY_ACCESS_TOKEN',
  refreshToken: 'DUMMY_REFRESH_TOKEN',
  accessTokenExpiresAt: '2026-07-24T09:05:00.000Z',
};

describe('Portal credential store', () => {
  it('stores OAuth credentials through stdin without putting secrets in process arguments', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    storePortalOAuthCredential(credential, { platform: 'darwin', spawn: spawn as never });

    const args = spawn.mock.calls[0]?.[1] as string[];
    const options = spawn.mock.calls[0]?.[2] as { input?: string; stdio?: unknown };
    expect(spawn.mock.calls[0]?.[0]).toBe('/usr/bin/osascript');
    expect(args).toEqual(expect.arrayContaining(['-l', 'JavaScript', 'store']));
    expect(args.join(' ')).not.toContain('DUMMY_ACCESS_TOKEN');
    expect(args.join(' ')).not.toContain('DUMMY_REFRESH_TOKEN');
    expect(options.input).toContain('DUMMY_REFRESH_TOKEN');
    expect(options.stdio).toEqual(['pipe', 'ignore', 'pipe']);
  });

  it('reads a valid stored OAuth access token synchronously', () => {
    const spawn = vi.fn().mockReturnValue({
      status: 0,
      stdout: `${JSON.stringify(credential)}\n`,
      stderr: '',
    });
    expect(resolvePortalCredential({
      platform: 'darwin',
      spawn: spawn as never,
      environment: {},
      now: () => new Date('2026-07-24T09:00:00.000Z'),
    })).toEqual({ token: 'DUMMY_ACCESS_TOKEN', source: 'native-store' });
  });

  it('refreshes an expired access token and rotates the stored envelope', async () => {
    const expired = {
      ...credential,
      accessTokenExpiresAt: '2026-07-24T08:59:00.000Z',
    };
    const spawn = vi.fn()
      .mockReturnValueOnce({ status: 0, stdout: JSON.stringify(expired), stderr: '' })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'DUMMY_REFRESHED_ACCESS_TOKEN',
      refresh_token: 'DUMMY_ROTATED_REFRESH_TOKEN',
      expires_in: 300,
    }), { status: 200 }));

    await expect(resolvePortalAccessToken({
      platform: 'darwin',
      spawn: spawn as never,
      fetch: fetchMock,
      environment: {},
      now: () => new Date('2026-07-24T09:00:00.000Z'),
    })).resolves.toEqual({
      token: 'DUMMY_REFRESHED_ACCESS_TOKEN',
      source: 'native-store',
    });
    const stored = String((spawn.mock.calls[1]?.[2] as { input?: string }).input);
    expect(stored).toContain('DUMMY_ROTATED_REFRESH_TOKEN');
    expect((spawn.mock.calls[1]?.[1] as string[]).join(' ')).not.toContain('DUMMY_ROTATED_REFRESH_TOKEN');
  });

  it('keeps legacy bearer credentials backward compatible', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stdout: 'DUMMY_LEGACY_TOKEN\n', stderr: '' });
    expect(getStoredPortalCredential({ platform: 'darwin', spawn: spawn as never }))
      .toBe('DUMMY_LEGACY_TOKEN');
    expect(resolvePortalCredential({
      platform: 'darwin',
      spawn: spawn as never,
      environment: {},
    })).toEqual({ token: 'DUMMY_LEGACY_TOKEN', source: 'native-store' });
  });
});
