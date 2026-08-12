#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadHookContextConfig } from './context-config.js';

const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
const prompt = String(input.prompt ?? '');
const root = gitRoot(input.cwd ?? process.cwd());
const context = loadHookContextConfig(root);
const implementationIntent = looksLikeImplementationTask(prompt);
const draftInboxReminder = looksLikeDraftReview(prompt) ? buildDraftInboxReminder(root) : null;

let additionalContext = null;
if (looksLikeBacklogPick(prompt)) {
  additionalContext =
    `${context.logoText} Backlog workflow: call ${context.mcpServerName}.pick_next_task or read ${context.resourceScheme}://backlog/next before selecting work. Then validate/confirm the selected task before implementation.`;
} else if (implementationIntent) {
  additionalContext =
    `${context.logoText} Context workflow: call ${context.mcpServerName}.validate_task before feature/bug implementation, confirm the Task Contract with the user, then build a context pack and run reuse scan before new reusable code.`;
}

if (draftInboxReminder) {
  additionalContext = additionalContext ? `${additionalContext}\n${draftInboxReminder}` : draftInboxReminder;
}

if (additionalContext) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext,
      },
    }),
  );
}

function looksLikeBacklogPick(prompt) {
  return /(backlog|б[эе]клог|подбер|выбер|следующ\w+\s+задач|pick.+task|next.+task)/i.test(prompt);
}

function looksLikeImplementationTask(prompt) {
  return /(add|build|create|fix|implement|change|refactor|rewrite|update|connect|добав|сдела|созда|исправ|почин|измен|перепиш|реализ|обнов|подключ|рефактор|баг)/i.test(prompt);
}

function looksLikeDraftReview(prompt) {
  return /(draft|чернов|promot|review.+context|context.+review|контекст|ppm[-_\s]?context|mcp)/i.test(prompt);
}

function buildDraftInboxReminder(root) {
  const counts = reviewableDraftCounts(root);
  if (counts.length === 0) return null;
  return `${context.logoText} Draft inbox: ${counts.map(({ label, count }) => `${label}=${count}`).join(', ')} pending review. Query with --include-drafts; preview with ${context.cliCommand} promote-draft RECORD-ID, then apply only after human review: ${context.cliCommand} promote-draft RECORD-ID --apply --approved-by <name>.`;
}

function reviewableDraftCounts(root) {
  const draftTypes = [
    ['projects', 'project'],
    ['integrations', 'integration'],
    ['data-entities', 'data_entity'],
    ['apis', 'api'],
    ['decisions', 'decision'],
    ['requirements', 'requirement'],
    ['open-questions', 'open_question'],
    ['meeting-drafts', 'meeting_draft'],
  ];
  const draftsRoot = resolve(root, '.project-context', 'drafts');
  return draftTypes
    .map(([segment, label]) => ({ label, count: countMarkdownFiles(resolve(draftsRoot, segment)) }))
    .filter(({ count }) => count > 0);
}

function countMarkdownFiles(dir) {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith('.md')).length;
}

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
