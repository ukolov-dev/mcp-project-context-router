import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

it('rejects the unimplemented capture-commit command instead of reporting success', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'router-cli-cleanup-'));
  try {
    const result = spawnSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), 'capture-commit', '--json'], {
      cwd: root, encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown command 'capture-commit'");
    expect(result.stdout).not.toContain('"status": "OK"');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
