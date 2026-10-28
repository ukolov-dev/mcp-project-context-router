import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getDocumentTree, getDocumentOutline, readDocumentSection } from '../src/tree-docs/tree-docs.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let root: string;
let external: string;
let originalCwd: string;

function write(path: string, content: string | Buffer) {
  mkdirSync(dirname(resolve(root, path)), { recursive: true });
  writeFileSync(resolve(root, path), content);
}

beforeEach(() => {
  originalCwd = process.cwd();
  root = mkdtempSync(resolve(tmpdir(), 'tree-docs-test-'));
  external = mkdtempSync(resolve(tmpdir(), 'tree-docs-external-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  process.chdir(root);
  write('.project-context/project.yaml', 'project:\n  name: Tree Docs Consumer\nmodules: {}\ncommands: {}\n');
  write('.gitignore', 'ignored/\nprivate.md\n');
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
  rmSync(external, { recursive: true, force: true });
});

describe('document tree', () => {
  it('lists directories and Markdown paths without loading bodies, and expands one level at a time', () => {
    write('README.md', '# Overview');
    write('docs/guide.markdown', '# Guide');
    write('docs/deep/design.MD', '# Design');
    write('docs/source.ts', 'export const source = 1;');
    expect(getDocumentTree({ path: 'docs' }).entries).toEqual([
      { path: 'docs/deep', type: 'directory', depth: 1 },
      { path: 'docs/guide.markdown', type: 'document', depth: 1 },
    ]);
    expect(getDocumentTree({ path: 'docs', depth: 2 }).entries.map(entry => entry.path))
      .toEqual(['docs/deep', 'docs/deep/design.MD', 'docs/guide.markdown']);
    expect(JSON.stringify(getDocumentTree())).not.toContain('# Overview');
  });

  it('pages a recursive tree without dropping entries or returning more than the limit', () => {
    for (const path of ['docs/a.md', 'docs/nested/b.md', 'docs/nested/c.md', 'docs/z.md']) write(path, '# Test');
    const first = getDocumentTree({ path: 'docs', depth: 3, limit: 2 });
    const second = getDocumentTree({ path: 'docs', depth: 3, limit: 2, offset: first.nextOffset! });
    const third = getDocumentTree({ path: 'docs', depth: 3, limit: 2, offset: second.nextOffset! });
    expect([...first.entries, ...second.entries, ...third.entries]).toEqual(getDocumentTree({ path: 'docs', depth: 3 }).entries);
    expect(third.nextOffset).toBeNull();
    expect(third.truncated).toBe(false);
  });

  it('excludes private, generated, ignored and symlink paths while retaining active project memory', () => {
    for (const path of ['docs/public.md', '.codex/policy.md', 'docs/.hidden.md', 'private.md',
      'ignored/notes.md', 'node_modules/library/README.md', 'dist/notes.md', 'AGENTS.override.md',
      '.project-context/indexes/secret.md', '.project-context/drafts/task.md', '.project-context/active/decision.md']) write(path, '# Content');
    writeFileSync(resolve(external, 'outside.md'), '# Outside');
    symlinkSync(resolve(external), resolve(root, 'linked-outside'));
    symlinkSync(resolve(root, 'docs'), resolve(root, 'linked-inside'));
    const paths = getDocumentTree({ depth: 8 }).entries.map(entry => entry.path);
    expect(paths.filter(path => path.endsWith('.md'))).toEqual(['.project-context/active/decision.md', 'docs/public.md']);
    for (const path of ['.codex/policy.md', 'docs/.hidden.md', 'private.md', 'ignored/notes.md', 'AGENTS.override.md', '.project-context/drafts/task.md']) {
      expect(() => getDocumentOutline({ path })).toThrow('excluded');
    }
    expect(() => getDocumentTree({ path: 'linked-outside' })).toThrow('repository directory');
    expect(() => getDocumentTree({ path: 'linked-inside' })).toThrow('Symbolic links');
    expect(() => readDocumentSection({ path: 'linked-inside/public.md' })).toThrow('Symbolic links');
  });

  it('rejects absolute paths, traversal and invalid numeric bounds', () => {
    write('docs/guide.md', '# Guide');
    for (const path of [resolve(root, 'docs'), '../outside', 'C:\\private', '\\\\server\\share']) {
      expect(() => getDocumentTree({ path })).toThrow();
    }
    for (const input of [{ depth: 0 }, { depth: 9 }, { limit: 0 }, { offset: -1 }, { limit: Number.NaN }]) {
      expect(() => getDocumentTree(input)).toThrow();
    }
    expect(() => getDocumentTree({ path: 'docs/guide.md' })).toThrow('directory');
  });
});

describe('Markdown outlines and section reading', () => {
  it('skips YAML frontmatter, fenced and indented code; supports ATX and single-line Setext headings', () => {
    write('docs/guide.md', [
      '---', '# YAML comment', 'title: Guide', '---', '# Guide', '',
      '````md', '## Code heading', '```', '### Still in code', '````',
      '~~~', '# Tilde code', '~~~', '    ## Indented code', '',
      'Section', '-------', 'Body', '', '## Настройка `API` ###', 'Done',
    ].join('\r\n'));
    const outline = getDocumentOutline({ path: 'docs/guide.md' });
    expect(outline.redacted).toBe(false);
    expect(outline.sections).toEqual([
      { id: 'guide', title: 'Guide', level: 1, startLine: 5, endLine: 22 },
      { id: 'section', title: 'Section', level: 2, startLine: 17, endLine: 20 },
      { id: 'настройка-api', title: 'Настройка `API`', level: 2, startLine: 21, endLine: 22 },
    ]);
    expect(readDocumentSection({ path: 'docs/guide.md', section: 'section' }).content).toBe('Section\n-------\nBody\n');
  });

  it('assigns unique IDs even when repeated headings collide with existing numeric suffixes', () => {
    write('guide.md', '# A\nfirst\n# A\nsecond\n# A-1\nthird\n# 😀\nfourth\n');
    expect(getDocumentOutline({ path: 'guide.md' }).sections.map(section => section.id))
      .toEqual(['a', 'a-1', 'a-1-1', 'section']);
    expect(readDocumentSection({ path: 'guide.md', section: '#a-1' }).content).toBe('# A\nsecond');
    const first = getDocumentOutline({ path: 'guide.md', limit: 2 });
    const second = getDocumentOutline({ path: 'guide.md', limit: 2, offset: first.nextOffset! });
    expect(second.sections.map(section => section.id)).toEqual(['a-1-1', 'section']);
    expect(second.nextOffset).toBeNull();
  });

  it('includes descendants and stops at a sibling or ancestor heading', () => {
    write('guide.md', '# Root\nintro\n## One\nbody\n### Child\nchild body\n## Two\ntwo body\n# Next\nend');
    const section = readDocumentSection({ path: 'guide.md', section: 'one' });
    expect(section.content).toBe('## One\nbody\n### Child\nchild body');
    expect(section).toMatchObject({ startLine: 3, endLine: 6, truncated: false, nextOffset: null });
    expect(readDocumentSection({ path: 'guide.md', section: 'root' }).content).toContain('two body');
    expect(readDocumentSection({ path: 'guide.md', section: 'root' }).content).not.toContain('# Next');
    expect(() => readDocumentSection({ path: 'guide.md', section: 'missing' })).toThrow('Unknown document section');
  });

  it('paginates documents containing many repeated headings with stable unique IDs', () => {
    write('guide.md', '# Repeated\n'.repeat(2000));
    const page = getDocumentOutline({ path: 'guide.md', offset: 1998, limit: 2 });
    expect(page.sections.map(section => section.id)).toEqual(['repeated-1998', 'repeated-1999']);
    expect(page.nextOffset).toBeNull();
  });

  it('pages the whole document without splitting Unicode characters or silently losing text', () => {
    write('guide.md', '😀ab😀cd');
    let offset = 0;
    let content = '';
    do {
      const page = readDocumentSection({ path: 'guide.md', maxChars: 3, offset });
      expect(page.content.length).toBeLessThanOrEqual(3);
      content += page.content;
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    } while (true);
    expect(content).toBe('😀ab😀cd');
    expect(() => readDocumentSection({ path: 'guide.md', offset: 1 })).toThrow('Unicode');
    expect(() => readDocumentSection({ path: 'guide.md', offset: 100 })).toThrow('exceeds');
    expect(getDocumentOutline({ path: 'guide.md' }).sections).toEqual([]);
  });

  it('redacts the complete source before selecting sections, preserving original line positions', () => {
    const begin = '-----BEGIN ' + 'PRIVATE KEY-----';
    const end = '-----END ' + 'PRIVATE KEY-----';
    write('guide.md', ['# Keys', begin, '## Never expose this heading', 'private-body', end, '## Visible', 'password=real-secret-value', 'mode=dev'].join('\n'));
    const outline = getDocumentOutline({ path: 'guide.md' });
    expect(outline.redacted).toBe(true);
    expect(outline.sections.map(section => section.id)).toEqual(['keys', 'visible']);
    expect(outline.sections[1].startLine).toBe(6);
    const result = readDocumentSection({ path: 'guide.md', section: 'visible' });
    expect(result.content).toBe('## Visible\n[REDACTED: secret-like assignment]\nmode=dev');
    expect(result.startLine).toBe(6);
    expect(JSON.stringify(readDocumentSection({ path: 'guide.md' }))).not.toContain('private-body');
    expect(JSON.stringify(result)).not.toContain('real-secret-value');
  });

  it('does not mistake a first-line Setext marker or a list item for a heading', () => {
    write('guide.md', '===\n\n- list\n---\n\n#\n');
    expect(getDocumentOutline({ path: 'guide.md' }).sections).toEqual([
      { id: 'section', title: '', level: 1, startLine: 6, endLine: 7 },
    ]);
    write('separator.md', '---\n# Real heading\nbody');
    expect(getDocumentOutline({ path: 'separator.md' }).sections[0].id).toBe('real-heading');
  });

  it('rejects non-Markdown, missing, binary, invalid UTF-8 and oversized documents', () => {
    write('source.ts', '# Source');
    write('binary.md', 'a\0b');
    write('invalid.md', Buffer.from([0xff, 0xfe]));
    write('large.md', 'a'.repeat(1_048_577));
    for (const path of ['source.ts', 'missing.md', 'binary.md', 'invalid.md', 'large.md']) {
      expect(() => getDocumentOutline({ path })).toThrow();
      expect(() => readDocumentSection({ path })).toThrow();
    }
  });
});

describe('tree docs CLI and MCP', () => {
  it('exposes the same bounded tree, outline and sections through CLI and core MCP', async () => {
    write('docs/guide.md', '# Guide\nintro\n## Install\nInstall body\n### Check\nCheck body\n## Other\nOther body');
    const operations = [
      { cli: ['tree', 'docs', '--limit', '1'], tool: 'get_document_tree', input: { path: 'docs', limit: 1 }, expected: getDocumentTree({ path: 'docs', limit: 1 }) },
      { cli: ['outline', 'docs/guide.md', '--limit', '2'], tool: 'get_document_outline', input: { path: 'docs/guide.md', limit: 2 }, expected: getDocumentOutline({ path: 'docs/guide.md', limit: 2 }) },
      { cli: ['read', 'docs/guide.md', '--section', 'install', '--max-chars', '20'], tool: 'read_document_section', input: { path: 'docs/guide.md', section: 'install', maxChars: 20 }, expected: readDocumentSection({ path: 'docs/guide.md', section: 'install', maxChars: 20 }) },
    ];
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [resolve(packageRoot, 'bin/project-context-mcp')], cwd: root,
      env: { ...process.env, PROJECT_CONTEXT_TOOL_PROFILE: 'core' } as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'tree-docs-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      const tools = (await client.listTools()).tools;
      for (const operation of operations) {
        const cli = JSON.parse(execFileSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), 'docs', ...operation.cli, '--json'],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
        expect(cli).toEqual(operation.expected);
        expect(tools.find(tool => tool.name === operation.tool)?.annotations?.readOnlyHint).toBe(true);
        const result = await client.callTool({ name: operation.tool, arguments: operation.input });
        expect(result.isError).not.toBe(true);
        const { brand, ...data } = result.structuredContent!;
        expect(brand).toBeDefined();
        expect(data).toEqual(operation.expected);
      }
      const invalid = await client.callTool({ name: 'read_document_section', arguments: { path: '../outside.md' } });
      expect(invalid.isError).toBe(true);
      const missing = await client.callTool({ name: 'read_document_section', arguments: { path: 'docs/guide.md', section: 'missing' } });
      expect(missing.isError).toBe(true);
      const invalidCli = spawnSync(process.execPath, [resolve(packageRoot, 'bin/project-context'), 'docs', 'read', '../outside.md', '--json'],
        { cwd: root, encoding: 'utf8' });
      expect(invalidCli.status).toBe(1);
      expect(JSON.parse(invalidCli.stdout).status).toBe('FAILED');
    } finally {
      await client.close();
      await transport.close();
    }
  }, 20_000);
});
