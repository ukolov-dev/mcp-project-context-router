import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRecord, updateRecord, writeMarkdown } from '../src/storage/markdown.js';

let root: string;
let first: string;
let second: string;

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'context-markdown-records-'));
  mkdirSync(resolve(root, '.project-context/active/tasks'), { recursive: true });
  first = resolve(root, '.project-context/active/tasks/first.md');
  second = resolve(root, '.project-context/active/tasks/second.md');
  writeMarkdown(first, {
    id: basename(root), type: 'task', status: 'confirmed', title: 'Isolated metadata',
    tags: ['original'], policy: { accepted: false },
  }, 'Identical original record content.');
  writeFileSync(second, readFileSync(first));
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Markdown record updates', () => {
  it('does not mutate cached metadata for a different file with identical content', () => {
    const original = readFileSync(second);
    expect(parseRecord(second, root).status).toBe('confirmed');
    updateRecord(first, (data) => {
      data.status = 'done';
      (data.tags as string[]).push('changed');
      (data.policy as { accepted: boolean }).accepted = true;
    });

    expect(parseRecord(first, root).status).toBe('done');
    expect(readFileSync(second)).toEqual(original);
    expect(parseRecord(second, root)).toMatchObject({
      status: 'confirmed', tags: ['original'], frontmatter: { policy: { accepted: false } },
    });
  });

  it('reads the original state when a record is rewritten with its earlier contents', () => {
    const original = readFileSync(first);
    parseRecord(first, root);
    updateRecord(first, (data) => { data.status = 'done'; });
    expect(parseRecord(first, root).status).toBe('done');

    writeFileSync(first, original);
    expect(parseRecord(first, root).status).toBe('confirmed');
  });
});
