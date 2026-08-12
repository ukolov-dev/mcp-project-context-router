import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextPack } from '../src/context-pack/pack.js';
import { importRpDatabase } from '../src/project-context/rp-import.js';
import { classifyFileReference } from '../src/storage/file-references.js';
import { lintContext } from '../src/storage/lint.js';
import { findRecordPath } from '../src/storage/markdown.js';

let originalCwd: string;
let tempDir: string;
let externalDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-boundary-test-'));
  externalDir = mkdtempSync(resolve(tmpdir(), 'ppm-context-external-test-'));
  process.chdir(tempDir);
  mkdirSync(resolve(tempDir, '.project-context/active/backlog'), { recursive: true });
  mkdirSync(resolve(tempDir, 'src'), { recursive: true });
  writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: PPM
modules:
  tools:
    path: tools/ppm-context
    playbooks: []
commands: {}
`, 'utf8');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
  rmSync(externalDir, { recursive: true, force: true });
});

describe('repository file boundary', () => {
  it('accepts repository files and safe missing paths', () => {
    writeFileSync(resolve(tempDir, 'src/safe.txt'), 'safe', 'utf8');

    expect(classifyFileReference('src/safe.txt').kind).toBe('file');
    expect(classifyFileReference('src/future.txt').kind).toBe('missing');
  });

  it('rejects absolute paths and parent traversal', () => {
    const external = resolve(externalDir, 'secret.txt');
    writeFileSync(external, 'outside', 'utf8');
    const traversal = relative(tempDir, external);

    expect(classifyFileReference(external).kind).toBe('outside_repository');
    expect(classifyFileReference(traversal).kind).toBe('outside_repository');
    expect(findRecordPath(traversal)).toBeNull();
  });

  it('rejects a repository symlink that resolves outside the repository', () => {
    const external = resolve(externalDir, 'secret.txt');
    writeFileSync(external, 'outside', 'utf8');
    symlinkSync(external, resolve(tempDir, 'src/linked-secret.txt'));

    expect(classifyFileReference('src/linked-secret.txt')).toEqual(expect.objectContaining({
      kind: 'outside_repository',
      reason: expect.stringContaining('symbolic link'),
    }));
  });

  it('omits unsafe explicit files from context packs', () => {
    const external = resolve(externalDir, 'secret.txt');
    writeFileSync(external, 'outside-secret-value', 'utf8');
    const traversal = relative(tempDir, external);

    const pack = buildContextPack({ query: 'external secret', files: [traversal] });

    expect(pack.files.map((file) => file.path)).not.toContain(traversal);
    expect(pack.warnings).toContain(`Ignored unsafe repository file path: ${traversal}`);
    expect(JSON.stringify(pack)).not.toContain('outside-secret-value');
  });

  it('redacts detected secrets from repository excerpts', () => {
    writeFileSync(resolve(tempDir, 'src/config.txt'), 'mode=dev\ntoken=super-secret-value\n', 'utf8');

    const pack = buildContextPack({ query: 'config token', files: ['src/config.txt'] });
    const excerpt = pack.files.find((file) => file.path === 'src/config.txt')?.excerpt;

    expect(excerpt).toContain('[REDACTED: secret-like assignment]');
    expect(excerpt).not.toContain('super-secret-value');
    expect(excerpt).toContain('mode=dev');
  });

  it('rejects record-derived paths that escape the repository', () => {
    const external = resolve(externalDir, 'secret.txt');
    writeFileSync(external, 'outside', 'utf8');
    const traversal = relative(tempDir, external);
    writeFileSync(resolve(tempDir, '.project-context/active/backlog/BACKLOG-UNSAFE.md'), `---
id: BACKLOG-UNSAFE
type: backlog
status: ready
priority: P1
agent_size: small
title: Unsafe path
modules: [tools]
files:
  - ${traversal}
tags: []
depends_on: []
acceptance_criteria: []
checks: []
retention: keep
---

# Unsafe path
`, 'utf8');

    expect(lintContext(false).errors).toContain(
      `.project-context/active/backlog/BACKLOG-UNSAFE.md: referenced path escapes the repository: ${traversal}`,
    );
  });

  it('rejects external RP import roots', () => {
    const traversal = relative(tempDir, externalDir);

    expect(() => importRpDatabase({ path: traversal })).toThrow('must be a repository directory');
  });

  it('ignores configured playbooks outside the repository', () => {
    const external = resolve(externalDir, 'outside-playbook.md');
    writeFileSync(external, '# Outside', 'utf8');
    const traversal = relative(tempDir, external);
    writeFileSync(resolve(tempDir, '.project-context/project.yaml'), `project:
  name: PPM
modules:
  tools:
    path: tools/ppm-context
    playbooks:
      - ${traversal}
commands: {}
`, 'utf8');

    const pack = buildContextPack({ query: 'tools context', modules: ['tools'] });

    expect(pack.playbooks).not.toContain(traversal);
    expect(pack.warnings).toContain(`Ignored unsafe playbook path: ${traversal}.`);
  });
});
