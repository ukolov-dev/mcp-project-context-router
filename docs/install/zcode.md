# Install for ZCode (Z.ai)

This guide targets ZCode's built-in agent. Client support is on Git `main` after 0.9.0; install from Git until a newer release is tagged. Router runtime needs Node.js 22.13+; follow ZCode's own runtime requirements separately.

## Install and connect

From the consumer Git repository root:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router#main
npx project-context init --client zcode --with-skills --name "My project" --module app:src
npx project-context index
npx project-context doctor --json
```

This creates `.zcode/config.json` with `mcp.servers.project_context` and two skills under `.zcode/skills/`. Keep the package installed locally. Review module paths/checks in `.project-context/project.yaml`, commit the lockfile and shared configuration, and open the consumer repository root in ZCode.

Existing files are preserved and reported in `skipped`. If `.zcode/config.json` already exists, merge the `project_context` entry from [the template](../../templates/client-configs/zcode.json) into its existing `mcp.servers`; do not replace other settings. Existing project configuration and custom skills stay unchanged.

Check Settings → MCP Servers: `project_context` should be enabled and connected. For CLI configurations, the same server entry belongs in the main config's `mcp.servers`; the user file is `~/.zcode/cli/config.json`. Launch from the consumer root so `cwd: "."` binds the right repository. Restart the session after configuration changes.

## Skills and real verification

Refresh Settings → Skills and confirm `project-context-workflow` / `context-research` are enabled. Invoke `$project-context-workflow` and ask it to obtain the project brief and build a context pack. The returned project name must match the consumer. Tools appear as `mcp__project_context__<tool>`; installing files alone does not prove connection. Research tools need the `planning` profile: change `PROJECT_CONTEXT_TOOL_PROFILE` in the server's `env` and reconnect.

## Optional user-level hooks

ZCode ignores workspace hook configuration. `init --client zcode --with-hooks` therefore fails before writing files, with an explanation. MCP and skills work without hooks.

For optional hooks, manually review [zcode-user-hooks.json](../../templates/client-configs/zcode-user-hooks.json), replace every `REPLACE_WITH_ABSOLUTE_PACKAGE_DIR` with your installed package directory, and merge the `hooks.events` groups into `~/.zcode/cli/config.json`, preserving your existing hooks. The installer never edits your home directory or enables global hooks. In this user configuration, set `hooks.enabled: true`, review the scope across workspaces and start a new session. The package must remain at that path.

The Stop adapter retains the desktop block decision and supplies CLI continuation feedback. It reuses the same freshness/evidence checks; it does not run tests or grant independent acceptance. ZCode desktop caps consecutive Stop continuations at three, so this is a reminder/guardrail rather than guaranteed enforcement. Review actual hook events in the client.

## Boundaries and sources

Automated tests cover configuration-based MCP startup, correct consumer data, skill installation, file preservation and Stop payload conversion. Interactive ZCode sessions and native Windows execution are not verified. Doctor checks router configuration/data, not live ZCode attachment.

Official sources checked 2026-10-16: [MCP](https://zcode.z.ai/en/docs/mcp-services), [skills and workspace locations](https://zcode.z.ai/en/docs/qa), [hooks](https://zcode.z.ai/en/docs/hooks), [CLI configuration](https://github.com/zai-org/ZCode/blob/main/apps/zcode-cli/README.md).
