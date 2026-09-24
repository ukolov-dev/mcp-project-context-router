import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getBacklog } from '../src/backlog/backlog.js';
import { parseRecord } from '../src/storage/markdown.js';
import { relPath } from '../src/storage/repo.js';

// Exercise Windows path semantics on every CI platform.
vi.mock('node:path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:path')>();
  return { ...actual, ...actual.win32 };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe('Windows record paths', () => {
  const root = 'C:\\projects\\router';

  it.each([
    `${root}\\.project-context\\active\\backlog\\ITEM.md`,
    'C:/projects/router/.project-context/active/backlog/ITEM.md',
  ])('uses portable separators for %s', (file) => {
    expect(relPath(root, file)).toBe('.project-context/active/backlog/ITEM.md');
  });

  it('lists all eight parsed active backlog records and excludes drafts and archives', () => {
    const records = ['active', 'drafts', 'archive'].flatMap((area) =>
      Array.from({ length: 8 }, (_, index) => {
        vi.mocked(readFileSync).mockReturnValueOnce(`---\nid: ITEM-${area}-${index}\ntype: backlog\nstatus: open\ntitle: Item ${index}\n---\n\nBacklog item.\n`);
        return parseRecord(`${root}\\.project-context\\${area}\\backlog\\ITEM-${index}.md`, root);
      }),
    );

    const result = getBacklog({ records });
    expect(result.count).toBe(8);
    expect(result.items.map((item) => item.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `ITEM-active-${index}`),
    );
    expect(records.filter((record) => record.archived)).toHaveLength(8);
    expect(records.every((record) => !record.path.includes('\\'))).toBe(true);
  });
});
