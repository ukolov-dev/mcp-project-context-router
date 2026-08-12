#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadHookContextConfig } from './context-config.js';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
if (input.stop_hook_active) process.exit(0);

const root = gitRoot(input.cwd ?? process.cwd());
const context = loadHookContextConfig(root);
const statePath = resolve(root, '.project-context', 'indexes', 'hook-state', `${input.session_id ?? 'unknown'}.json`);
const state = readState(statePath);
const changedFiles = state.changedFiles ?? [];

if (changedFiles.length === 0 || state.finalizeReminderShown) {
  process.exit(0);
}

const confirmedTaskId = findConfirmedTaskForChanges(root, changedFiles);
if (!confirmedTaskId) {
  cleanupState(statePath);
  process.exit(0);
}

if (hasRecentFinalizeDraft(root, changedFiles, state.updatedAt)) {
  cleanupState(statePath);
  process.exit(0);
}

state.finalizeReminderShown = true;
writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
process.stdout.write(
  JSON.stringify({
    decision: 'block',
    reason:
      `${context.logoText} Confirmed task ${confirmedTaskId} has changed files. Call ${context.mcpServerName}.finalize_work before final response, or explain why no context finalize draft is needed.`,
  }),
);

function gitRoot(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

function hasRecentFinalizeDraft(root, changedFiles, updatedAt) {
  const changed = changedFiles.filter((path) => !path.startsWith('.project-context/indexes/'));
  if (changed.length === 0) return true;

  const draftDir = resolve(root, '.project-context', 'drafts', 'run-summaries');
  if (!existsSync(draftDir)) return false;

  const updatedAtMs = Date.parse(updatedAt ?? '');
  if (Number.isNaN(updatedAtMs)) return false;

  for (const entry of readdirSync(draftDir)) {
    if (!entry.endsWith('.md')) continue;
    const path = join(draftDir, entry);
    const stat = statSync(path);
    if (stat.mtimeMs + 1000 < updatedAtMs) continue;
    const raw = readFileSync(path, 'utf8');
    if (changed.some((file) => raw.includes(file))) {
      return true;
    }
  }

  return false;
}

function findConfirmedTaskForChanges(root, changedFiles) {
  const taskDir = resolve(root, '.project-context', 'active', 'tasks');
  if (!existsSync(taskDir)) return null;
  for (const entry of readdirSync(taskDir)) {
    if (!entry.endsWith('.md')) continue;
    try {
      const raw = readFileSync(join(taskDir, entry), 'utf8');
      if (!/^status:\s*(?:confirmed|in_progress)\s*$/m.test(raw)) continue;
      if (!changedFiles.some((file) => raw.includes(`  - ${file}`))) continue;
      return raw.match(/^id:\s*['"]?([^'"\n]+)['"]?\s*$/m)?.[1]?.trim() ?? entry.replace(/\.md$/, '');
    } catch {
      // Ignore an unreadable task record and continue looking for a valid contract.
    }
  }
  return null;
}

function cleanupState(path) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // Session cleanup is best effort.
  }
}

function readState(path) {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
