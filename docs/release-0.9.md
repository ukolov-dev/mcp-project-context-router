# Project Context Router 0.9.0

Requires Node.js 22.13 or newer. Distribution uses GitHub source/tarballs; the package is not published to the npm registry.

## Install or upgrade

Download `mcp-project-context-router-0.9.0.tgz` and `SHA256SUMS` from the [release](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.9.0):

```bash
shasum -a 256 -c SHA256SUMS
npm install --save-dev --save-exact ./mcp-project-context-router-0.9.0.tgz
npx project-context init --with-skills --with-hooks
npx project-context index
npx project-context doctor --json
```

Review and commit configuration and the lockfile, trust reviewed hook definitions in Codex, then reconnect the MCP client. Existing project, skill and hook files are preserved: compare customized copies with the bundled templates and merge explicitly. Git pre-commit remains a separate `hooks install` command.

## What changed since 0.8.0

- Optional Codex lifecycle hook installation and content-based task verification before the final response. Fresh verification must precede finalization; unresolved checks require an honest partial/blocked result and explicit reasons. No automatic test execution or independent acceptance.
- Bundled `project-context-workflow` skill and opt-in `init --with-skills`.
- English/Russian project website and documentation.
- Smaller memory model and exact requirement-task links; optional portal source fields preserved.
- Stable dependency refresh, shared YAML compatibility loader, unused dependencies removed.

## Migration

Ten record types are retired: `integration`, `api`, `data_entity`, `meeting_draft`, `acceptance_check`, `module`, `pattern`, `runbook`, `refactor`, `run-summary`. Existing Markdown remains readable and archivable, but new proposals/promotions/restores are disabled and ordinary packs omit it. CLI/MCP integration and data-entity search commands are removed. `trace_requirement` no longer returns `acceptanceChecks`.

`finalize_work` saves `last_result` on the confirmed task and returns `FINALIZED` / `taskPath`; it no longer creates summary drafts. Complete finalization still requires an execution run with independent acceptance. Update integrations that consume the old response or look for summary drafts. See [record model](record-model.md) and [Codex setup](install/codex.md).

## Verification boundaries

Fixture and clean-package checks cover hook execution and evidence handling. Client trust must be reviewed in the actual Codex client; not every client operation emits lifecycle events. These are workflow guardrails, not proof of test execution. Native Windows hook execution and interactive Codex trust UI are not verified by Linux/macOS checks.

FTS5 remains experimental and opt-in; runtime support and limitations from [0.8](release-0.8.md) still apply. Latest stable upstream `fast-glob` and `gray-matter` still bring unresolved transitive npm advisories; this release does not claim a clean audit.
