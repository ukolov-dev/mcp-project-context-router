import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compactCleanupResult, isActionableFileReferenceIssue, type GcCandidate } from '../src/gc/gc.js';
import { gitIgnoredPaths } from '../src/storage/repo.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('GC reporting', () => {
  const candidates: GcCandidate[] = Array.from({ length: 12 }, (_, index) => ({
    id: `RUN-${index}`,
    path: `.project-context/drafts/run-summaries/${index}.md`,
    action: 'archive',
    reason: 'Old draft.',
  }));

  it('prints a concise candidate sample by default', () => {
    const report = compactCleanupResult({ candidates, critical: [] });

    expect(report.candidateCount).toBe(12);
    expect(report.candidates).toHaveLength(5);
    expect(report.truncated).toBe(true);
  });

  it('keeps the complete manifest when verbose output is requested', () => {
    const report = compactCleanupResult({ candidates, critical: ['critical'] }, 2, true);

    expect(report.candidates).toHaveLength(12);
    expect(report.truncated).toBe(false);
    expect(report.critical).toEqual(['critical']);
  });

  it('does not fail CI for intentionally ignored source archives missing from a commit snapshot', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'ppm-context-gc-'));
    tempDirs.push(root);
    execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
    writeFileSync(resolve(root, '.gitignore'), '.project-context/source-archives/**\n');
    const ignored = '.project-context/source-archives/rp/RAW/source.docx';
    const ordinary = 'doc/missing.md';
    const ignoredPaths = gitIgnoredPaths([ignored, ordinary], root);

    expect(ignoredPaths).toEqual(new Set([ignored]));
    expect(isActionableFileReferenceIssue('missing', ignored, ignoredPaths)).toBe(false);
    expect(isActionableFileReferenceIssue('missing', ordinary, ignoredPaths)).toBe(true);
    expect(isActionableFileReferenceIssue('outside_repository', ignored, ignoredPaths)).toBe(true);
  });
});
