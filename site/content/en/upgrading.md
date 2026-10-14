# Upgrading and troubleshooting

The website describes current Git `main`. Existing release tags are immutable; a version string alone does not identify a Git installation.

## Update from GitHub

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router#main
npx project-context index
npx project-context doctor --json
```

Review and commit the new lockfile, then reconnect the MCP client. For skills, `init --with-skills` copies missing files only. Compare installed copies with the templates in `node_modules/mcp-project-context-router/templates/skills/` before manually updating custom instructions.

## Smaller memory model

The retired types are `integration`, `api`, `data_entity`, `meeting_draft`, `acceptance_check`, `module`, `pattern`, `runbook`, `refactor` and `run-summary`. New proposals, promotions and restores for these types are disabled. Existing Markdown is preserved, readable and archivable; default packs hide it.

CLI `find-integrations` / `find-data-entities` and MCP `find_integrations` / `find_data_entities` are removed. `trace_requirement` no longer returns `acceptanceChecks`. `finalize_work` returns `FINALIZED` with `taskPath` instead of `CREATED`/`UPDATED` with `draftPath`. It saves the result on the confirmed task. [Detailed migration](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/record-model.md).

## Diagnose common problems

| Symptom | Check |
| --- | --- |
| Agent cannot see a tool | Check the MCP profile, reconnect and inspect the actual tool list |
| Server sees the wrong project | Check its `cwd`; shell `cd` does not rebind native MCP |
| Source symbols are missing | Check module paths and explicit source globs; rebuild the index |
| Skill is missing | Inspect `.agents/skills/<name>/SKILL.md` and the client discovery rules |
| Installed skill is old | Existing files are deliberately skipped; review changes and update manually |
| Complete finalization is rejected | Provide a fresh independently accepted execution run; do not bypass the gate |
| Doctor reports WARN | Read the diagnostic; warnings do not establish failure or a live connection |
| Compiled MCP server is missing | Reinstall Git dependency with lifecycle scripts enabled; it builds the router |

## Verification boundaries

A successful build or fixture test does not prove deployment, authorization in a live service, or current client attachment. Record commands and environments explicitly. Indexes and pack caches are disposable; durable Markdown is the source of truth.

For bugs, include the router Git commit, Node version, exact command, sanitized output and a minimal reproduction in [GitHub Issues](https://github.com/ukolov-dev/mcp-project-context-router/issues). Never include credentials or private project material.
