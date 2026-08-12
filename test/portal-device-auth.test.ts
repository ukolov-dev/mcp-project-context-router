import { describe, expect, it, vi } from 'vitest';
import { authorizePortalDevice, normalizePortalIssuerUrl } from '../src/portal/device-auth.js';

describe('Portal device authorization', () => {
  it('opens verification in a browser and polls without exposing tokens', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_code: 'DUMMY_DEVICE_CODE',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://identity.example.test/device',
        verification_uri_complete: 'https://identity.example.test/device?user_code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'authorization_pending',
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'DUMMY_ACCESS_TOKEN',
        refresh_token: 'DUMMY_REFRESH_TOKEN',
        expires_in: 300,
      }), { status: 200 }));
    const openUrl = vi.fn();
    const writeStatus = vi.fn();
    let now = new Date('2026-07-24T09:00:00.000Z');

    const credential = await authorizePortalDevice({
      issuerUrl: 'https://identity.example.test/realms/vincenzo/',
      clientId: 'vincenzo-cli',
    }, {
      fetch: fetchMock,
      now: () => now,
      openUrl,
      wait: async (milliseconds) => {
        now = new Date(now.getTime() + milliseconds);
      },
      writeStatus,
    });

    expect(openUrl).toHaveBeenCalledWith('https://identity.example.test/device?user_code=ABCD-EFGH');
    expect(writeStatus.mock.calls.flat().join('\n')).toContain('ABCD-EFGH');
    expect(writeStatus.mock.calls.flat().join('\n')).not.toContain('DUMMY_ACCESS_TOKEN');
    expect(credential).toMatchObject({
      kind: 'oauth-device',
      issuerUrl: 'https://identity.example.test/realms/vincenzo',
      clientId: 'vincenzo-cli',
      accessToken: 'DUMMY_ACCESS_TOKEN',
      refreshToken: 'DUMMY_REFRESH_TOKEN',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('permits HTTP only for loopback development', () => {
    expect(normalizePortalIssuerUrl('http://localhost:28082/realms/vincenzo'))
      .toBe('http://localhost:28082/realms/vincenzo');
    expect(() => normalizePortalIssuerUrl('http://identity.example.test/realms/vincenzo'))
      .toThrow(/must use HTTPS/);
  });
});
