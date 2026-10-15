#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { unfinishedTasks } from '../dist/hooks/stop.js';
import { loadHookContextConfig } from './context-config.js';
import { captureChanges } from './state.js';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const state = captureChanges(input);
  const problems = unfinishedTasks(state.changedFiles, state.updatedAt, state.startedAt);
  if (problems.length) {
    const context = loadHookContextConfig(state.root);
    process.stdout.write(JSON.stringify({ decision: 'block', reason: `${context.logoText} ${problems.join(' ')} Use ${context.mcpServerName}.record_verification_evidence and ${context.mcpServerName}.finalize_work. Report unresolved checks honestly as partial/blocked with reasons.` }));
  }
} catch (error) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `Project Context Router could not verify task finalization: ${error.message}. Repair the configuration or hook state before retrying.` }));
}
