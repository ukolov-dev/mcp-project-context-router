#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const root = gitRoot(input.cwd ?? process.cwd());
pruneOldHookState(root);
const statePath = resolve(root, '.project-context', 'indexes', 'hook-state', `${input.session_id ?? 'unknown'}.json`);
const state = readState(statePath);
const patchText = extractPatchText(input);
const patchFiles = patchText ? parseApplyPatchFiles(root, patchText) : [];
const changed = patchFiles.length > 0 ? patchFiles : gitChangedFiles(root);

state.changedFiles = [...new Set([...(state.changedFiles ?? []), ...changed])];
state.lastTool = input.tool_name ?? 'unknown';
state.changedFilesSource = patchFiles.length > 0 ? 'apply_patch' : 'git-diff-fallback';
state.updatedAt = new Date().toISOString();

mkdirSync(dirname(statePath), { recursive: true });
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    return cwd;
  }
}

function gitChangedFiles(root) {
  try {
    return execFileSync('git', ['diff', '--name-only'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((path) => !path.startsWith('.project-context/indexes/'));
  } catch {
    return [];
  }
}

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

function readState(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function pruneOldHookState(root) {
  const stateDir = resolve(root, '.project-context', 'indexes', 'hook-state');
  if (!existsSync(stateDir)) return;
  const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(stateDir)) {
    if (!entry.endsWith('.json')) continue;
    const path = join(stateDir, entry);
    try {
      if (statSync(path).mtimeMs < cutoffMs) unlinkSync(path);
    } catch {
      // Best-effort cleanup must never break the tool lifecycle.
    }
  }
}
