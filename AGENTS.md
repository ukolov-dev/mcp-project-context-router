# Repository Guidelines

This repository contains the reusable Project Context Router package.

## Scope

- Runtime source: `src/`.
- CLI and MCP launchers: `bin/`.
- Unit and integration tests: `test/`.
- Consumer workflow templates: `templates/`.
- Local project memory: `.project-context/`; generated drafts and indexes stay untracked.

## Workflow

Before implementation, validate the request and confirm a Task Contract. Build a context pack, inspect existing capabilities, and keep changes scoped. Before handoff, run refactor review, execute the applicable verification commands, record evidence, and finalize the work.

## Verification

- `npm run build`
- `npm test`
- `npm run package:check`
- `node bin/project-context doctor --json`

Never add source-project records, credentials, absolute workstation paths, generated SQLite indexes, or `node_modules` to the repository or npm package.
