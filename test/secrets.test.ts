import { describe, expect, it } from 'vitest';
import { redactSecrets, scanSecrets } from '../src/storage/secrets.js';

describe('secret scanning', () => {
  it.each([
    '-----BEGIN ' + 'PRIVATE KEY-----',
    '-----BEGIN ' + 'RSA PRIVATE KEY-----',
    '-----BEGIN ' + 'ENCRYPTED PRIVATE KEY-----',
    '-----BEGIN ' + 'PGP PRIVATE KEY BLOCK-----',
  ])('detects private key marker %s', (marker) => {
    expect(scanSecrets('secret.txt', marker)).toHaveLength(1);
  });

  it('ignores explicit placeholders', () => {
    expect(scanSecrets('example.env', 'password=<set-in-secret-store>')).toHaveLength(0);
  });

  it('redacts secret assignments while preserving placeholders', () => {
    const result = redactSecrets('token=real-secret-token\npassword=<set-in-secret-store>\nmode=dev');

    expect(result).toContain('[REDACTED: secret-like assignment]');
    expect(result).not.toContain('real-secret-token');
    expect(result).toContain('password=<set-in-secret-store>');
    expect(result).toContain('mode=dev');
  });

  it('redacts complete private key blocks', () => {
    const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
    const end = '-----END ' + 'PRIVATE KEY-----';
    const result = redactSecrets(['before', begin, 'abc123', end, 'after'].join('\n'));

    expect(result).toBe('before\n[REDACTED: private key]\nafter');
  });
});
