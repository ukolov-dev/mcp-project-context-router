import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { classifyFileReference } from '../storage/file-references.js';
import { gitIgnoredPaths, repoPaths } from '../storage/repo.js';
import { redactSecrets } from '../storage/secrets.js';

const pagination = {
  offset: z.number().int().min(0).max(100_000).default(0),
  limit: z.number().int().min(1).max(500).default(100),
};
export const documentTreeInputSchema = z.object({
  path: z.string().min(1).default('.'),
  depth: z.number().int().min(1).max(8).default(1),
  ...pagination,
});
export const documentOutlineInputSchema = z.object({
  path: z.string().min(1),
  ...pagination,
});
export const readDocumentSectionInputSchema = z.object({
  path: z.string().min(1),
  section: z.string().min(1).optional(),
  offset: z.number().int().min(0).max(2_000_000).default(0),
  maxChars: z.number().int().min(2).max(100_000).default(12_000),
});

export type DocumentSection = {
  id: string;
  title: string;
  level: number;
  startLine: number;
  endLine: number;
};
type TreeEntry = { path: string; type: 'directory' | 'document'; depth: number };

const excludedDirectories = new Set(['node_modules', 'build', 'dist', 'coverage', 'target', 'vendor']);
const markdownPath = /\.(?:md|markdown)$/i;

export function getDocumentTree(input: z.input<typeof documentTreeInputSchema> = {}) {
  const parsed = documentTreeInputSchema.parse(input);
  const root = visiblePath(parsed.path, 'directory');
  function* walk(path: string, depth: number): Generator<TreeEntry> {
    const directory = classifyFileReference(path).absolutePath;
    const entries = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || (entry.isFile() && markdownPath.test(entry.name)))
      .map(entry => ({ entry, path: path === '.' ? entry.name : `${path}/${entry.name}` }))
      .filter(item => isVisible(item.path))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    const ignored = gitIgnoredPaths(entries.map(item => item.path));
    for (const item of entries) {
      if (ignored.has(item.path)) continue;
      const isDirectory = item.entry.isDirectory();
      yield { path: item.path, type: isDirectory ? 'directory' : 'document', depth };
      if (isDirectory && depth < parsed.depth) yield* walk(item.path, depth + 1);
    }
  }
  const { items: entries, ...page } = paginate(walk(root.path, 1), parsed.offset, parsed.limit);
  return { path: root.path, depth: parsed.depth, entries, ...page };
}

export function getDocumentOutline(input: z.input<typeof documentOutlineInputSchema>) {
  const parsed = documentOutlineInputSchema.parse(input);
  const document = readDocument(parsed.path);
  const { items: sections, ...page } = paginate(parseSections(document.lines), parsed.offset, parsed.limit);
  return { path: document.path, totalLines: document.lines.length, redacted: document.redacted,
    sections, ...page };
}

export function readDocumentSection(input: z.input<typeof readDocumentSectionInputSchema>) {
  const parsed = readDocumentSectionInputSchema.parse(input);
  const document = readDocument(parsed.path);
  const sectionId = parsed.section?.replace(/^#/, '');
  const section = sectionId === undefined ? undefined
    : parseSections(document.lines).find(item => item.id === sectionId);
  if (parsed.section !== undefined && !section) throw new Error(`Unknown document section: ${parsed.section}. Read the outline for section IDs.`);
  const startLine = section?.startLine ?? 1;
  const endLine = section?.endLine ?? document.lines.length;
  const text = document.lines.slice(startLine - 1, endLine).join('\n');
  if (parsed.offset > text.length) throw new Error('Offset exceeds the selected document section.');
  if (splitsSurrogate(text, parsed.offset)) throw new Error('Offset splits a Unicode character; use nextOffset from the previous response.');
  let end = Math.min(text.length, parsed.offset + parsed.maxChars);
  if (splitsSurrogate(text, end)) end--;
  return {
    path: document.path, section: section ?? null, startLine, endLine,
    content: text.slice(parsed.offset, end), redacted: document.redacted,
    offset: parsed.offset, totalCharacters: text.length,
    truncated: end < text.length, nextOffset: end < text.length ? end : null,
  };
}

function isVisible(path: string): boolean {
  const parts = path.split('/');
  return !parts.some((part, index) => (part.startsWith('.') && part !== '.' && !(part === '.project-context' && index === 0))
    || excludedDirectories.has(part) || part === 'AGENTS.override.md')
    && !/^\.project-context\/(?:indexes|drafts|trash)(?:\/|$)/.test(path);
}

function visiblePath(path: string, kind: 'file' | 'directory') {
  const reference = classifyFileReference(path);
  if (reference.kind !== kind) throw new Error(`Expected a repository ${kind}: ${path}`);
  const root = repoPaths().root;
  const normalized = relative(root, reference.absolutePath).replaceAll('\\', '/') || '.';
  const actual = relative(realpathSync(root), realpathSync(reference.absolutePath)).replaceAll('\\', '/') || '.';
  if (actual !== normalized) throw new Error('Symbolic links are not supported by tree docs.');
  if (!isVisible(normalized) || gitIgnoredPaths([normalized]).has(normalized)) {
    throw new Error(`Hidden, generated or Git-ignored paths are excluded from tree docs: ${normalized}`);
  }
  return { path: normalized, absolutePath: reference.absolutePath };
}

function readDocument(path: string) {
  const reference = visiblePath(path, 'file');
  if (!markdownPath.test(reference.path)) throw new Error('Tree docs reads Markdown files (.md or .markdown).');
  if (statSync(reference.absolutePath).size > 1_048_576) throw new Error('Document exceeds the 1 MiB reading limit.');
  const bytes = readFileSync(reference.absolutePath);
  if (bytes.length > 1_048_576) throw new Error('Document exceeds the 1 MiB reading limit.');
  const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (raw.includes('\0')) throw new Error('Document must contain UTF-8 text without NUL bytes.');
  const text = redactSecrets(raw, { preserveLines: true });
  return { path: reference.path, lines: text.split(/\r?\n/), redacted: text !== raw.replaceAll('\r\n', '\n') };
}

function paginate<T>(items: Iterable<T>, offset: number, limit: number) {
  const selected: T[] = [];
  let index = 0;
  for (const item of items) {
    if (index++ < offset) continue;
    if (selected.length === limit) return { items: selected, offset, truncated: true, nextOffset: offset + limit };
    selected.push(item);
  }
  return { items: selected, offset, truncated: false, nextOffset: null };
}

function splitsSurrogate(text: string, index: number): boolean {
  return /[\uD800-\uDBFF]/.test(text.charAt(index - 1)) && /[\uDC00-\uDFFF]/.test(text.charAt(index));
}

function parseSections(lines: string[]): DocumentSection[] {
  const sections: DocumentSection[] = [];
  const ids = new Set<string>();
  const nextSuffix = new Map<string, number>();
  let fence: { marker: string; length: number } | undefined;
  let frontmatter = lines[0] === '---' && lines.slice(1).some(line => /^(?:---|\.\.\.)\s*$/.test(line));
  let previousTextLine = -1;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (frontmatter) {
      if (index > 0 && /^(?:---|\.\.\.)\s*$/.test(line)) frontmatter = false;
      continue;
    }
    const codeFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (codeFence && codeFence[1][0] === fence.marker && codeFence[1].length >= fence.length && !codeFence[2].trim()) fence = undefined;
      previousTextLine = -1;
      continue;
    }
    if (codeFence) {
      fence = { marker: codeFence[1][0], length: codeFence[1].length };
      previousTextLine = -1;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
    const setext = previousTextLine >= 0 && previousTextLine === index - 1 ? /^ {0,3}(=+|-+)[ \t]*$/.exec(line) : null;
    if (atx || setext) {
      const title = atx ? (atx[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim() : lines[previousTextLine].trim();
      const base = title.toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').replace(/\s/g, '-') || 'section';
      let suffix = nextSuffix.get(base) ?? 0;
      let id = suffix ? `${base}-${suffix}` : base;
      while (ids.has(id)) id = `${base}-${++suffix}`;
      nextSuffix.set(base, suffix + 1);
      ids.add(id);
      sections.push({ id, title, level: atx ? atx[1].length : setext![1][0] === '=' ? 1 : 2,
        startLine: (atx ? index : previousTextLine) + 1, endLine: lines.length });
      previousTextLine = -1;
    } else {
      // shortcut: single-line Setext only; use a Markdown parser if multiline headings are needed.
      previousTextLine = line.trim() && !/^(?: {4}|\t| {0,3}(?:>|[-+*] |\d+[.)] ))/.test(line) ? index : -1;
    }
  }
  const parents: DocumentSection[] = [];
  for (const section of sections) {
    while (parents.length && parents.at(-1)!.level >= section.level) parents.pop()!.endLine = section.startLine - 1;
    parents.push(section);
  }
  return sections;
}
