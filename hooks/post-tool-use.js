#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { findRepoRoot } from '../dist/storage/repo.js';
import { captureChanges } from './state.js';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = findRepoRoot(input.cwd ?? process.cwd());
const patch = extractPatchText(input);
captureChanges(input, patch ? parseApplyPatchFiles(root, patch) : []);

function extractPatchText(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    return value.includes('*** Begin Patch') ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractPatchText(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['patch', 'input', 'tool_input', 'arguments', 'args', 'content']) {
      if (key in value) {
        const found = extractPatchText(value[key], depth + 1);
        if (found) return found;
      }
    }
    for (const child of Object.values(value)) {
      const found = extractPatchText(child, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function parseApplyPatchFiles(root, patchText) {
  const files = [];
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    /^\*\*\* Move to: (.+)$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of patchText.matchAll(pattern)) {
      const normalized = normalizeRepoPath(root, match[1]);
      if (normalized) files.push(normalized);
    }
  }
  return [...new Set(files)].filter((path) => !path.startsWith('.project-context/indexes/'));
}

function normalizeRepoPath(root, path) {
  const cleaned = String(path ?? '').trim().replace(/^"|"$/g, '');
  if (!cleaned) return null;
  if (!isAbsolute(cleaned)) return cleaned;
  const relativePath = relative(root, cleaned);
  return relativePath.startsWith('..') ? null : relativePath;
}
