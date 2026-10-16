#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ZCode CLI consumes continuation feedback; desktop also understands the block decision.
const result = spawnSync(process.execPath, [fileURLToPath(new URL('./stop-capture.js', import.meta.url))], {
  input: readFileSync(0), encoding: 'utf8',
});
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
if (result.stdout.trim()) {
  const output = JSON.parse(result.stdout);
  if (output.decision === 'block') {
    output.continue = true;
    output.hookSpecificOutput = { hookEventName: 'Stop', additionalContext: output.reason };
  }
  process.stdout.write(JSON.stringify(output));
}
