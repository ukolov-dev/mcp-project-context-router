import { describe, expect, it, vi } from 'vitest';
import {
  confluenceCredentialSource,
  getStoredConfluenceCredential,
  resolveConfluenceCredential,
  storeConfluenceCredential,
} from '../src/confluence/credential-store.js';

describe('Confluence credential store', () => {
  it('gives the process environment precedence over native storage', () => {
    const spawn = vi.fn();
    expect(resolveConfluenceCredential({
      environment: { CONFLUENCE_PERSONAL_TOKEN: 'DUMMY_ENV_PAT' },
      spawn: spawn as never,
    })).toEqual({ token: 'DUMMY_ENV_PAT', source: 'environment' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reads a native macOS credential without a shell', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stdout: 'DUMMY_STORED_PAT\n', stderr: '' });
    expect(getStoredConfluenceCredential({ platform: 'darwin', spawn: spawn as never })).toBe('DUMMY_STORED_PAT');
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/security',
      expect.arrayContaining(['find-generic-password', '-w']),
      expect.objectContaining({ shell: false, stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('stores through a native masked prompt and never puts the PAT in process arguments', () => {
    const spawn = vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
    storeConfluenceCredential({ platform: 'darwin', spawn: spawn as never });
    const args = spawn.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('DUMMY_PAT');
    expect(spawn).toHaveBeenCalledWith(
      '/usr/bin/security',
      expect.arrayContaining(['add-generic-password', '-w']),
      expect.objectContaining({ shell: false, stdio: 'inherit' }),
    );
  });

  it('reports a missing Linux credential without leaking backend output', () => {
    const spawn = vi.fn().mockReturnValue({ status: 1, stdout: '', stderr: '' });
    expect(getStoredConfluenceCredential({ platform: 'linux', spawn: spawn as never })).toBeNull();
    expect(confluenceCredentialSource({
      platform: 'linux',
      environment: {},
      spawn: spawn as never,
    })).toBe('missing');
  });
});
