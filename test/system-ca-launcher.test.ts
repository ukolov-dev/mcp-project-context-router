import { describe, expect, it } from 'vitest';
import { systemCaNodeArgs } from '../bin/system-ca.js';

describe('system CA launcher', () => {
  it('enables Node system CA trust when the runtime supports it', () => {
    expect(systemCaNodeArgs(['entrypoint.js', '--json'], {
      allowedNodeEnvironmentFlags: new Set(['--use-system-ca']),
      execArgv: [],
      nodeOptions: '',
    })).toEqual(['--use-system-ca', 'entrypoint.js', '--json']);
  });

  it('does not duplicate an existing system CA flag', () => {
    expect(systemCaNodeArgs(['entrypoint.js'], {
      allowedNodeEnvironmentFlags: new Set(['--use-system-ca']),
      execArgv: [],
      nodeOptions: '--trace-warnings --use-system-ca',
    })).toEqual(['entrypoint.js']);
  });

  it('preserves compatibility with runtimes that do not support the flag', () => {
    expect(systemCaNodeArgs(['entrypoint.js'], {
      allowedNodeEnvironmentFlags: new Set(),
      execArgv: [],
      nodeOptions: '',
    })).toEqual(['entrypoint.js']);
  });
});
