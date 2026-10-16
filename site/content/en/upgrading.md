# Upgrading and troubleshooting

The current stable release is **0.10.0**, including ZCode and official DeepSeek Harness. Existing release tags are immutable; review the lockfile when upgrading.

## Update to 0.10.0

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.0/mcp-project-context-router-0.10.0.tgz
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

## Release 0.9.0

[Release notes and migration](https://github.com/ukolov-dev/mcp-project-context-router/blob/v0.9.0/docs/release-0.9.md). Add missing lifecycle hooks with `init --with-hooks`; review and trust them in Codex. Existing hook configuration is preserved.

## Release 0.10.0: ZCode and DeepSeek Harness

[Release and package](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.10.0) · [Release notes](https://github.com/ukolov-dev/mcp-project-context-router/blob/v0.10.0/docs/release-0.10.md).

Use `init --client zcode --with-skills` or `init --client deepseek-harness --with-skills --with-hooks` after upgrading. See [quick start](quickstart.html#zcode-and-deepseek-harness). Existing configs are preserved: merge skipped client entries/DSH hook rows manually. DSH needs its explicit `--patch` launch; ZCode user hooks remain a reviewed manual setup. No native client session or Windows verification is claimed.
