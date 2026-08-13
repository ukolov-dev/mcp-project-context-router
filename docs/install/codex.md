# Install Project Context Router for Codex

This setup connects Project Context Router to the ChatGPT desktop app, Codex
CLI, and the Codex IDE extension through one project-scoped MCP configuration.
Those Codex clients share `config.toml` on the same host.

## Prerequisites

- Node.js 22.13 or newer
- npm and an npm-based project with a committed lockfile
- A local Codex client that supports stdio MCP servers

## 1. Install and initialize the router

Run these commands from the repository that should own the project context:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
npx project-context init --name "Example Project" --module app:src
npx project-context index
npx project-context doctor --json
```

Replace the example project name and module mapping. The installed module is
named `mcp-project-context-router`, matching the GitHub repository. Commit and
review the resulting lockfile: it pins
the exact Git commit resolved by npm even though the install command tracks the
repository's default branch.

Review `.project-context/project.yaml` before continuing. The generated config
is intentionally generic and `init` never overwrites an existing file.

## 2. Add the project-scoped Codex configuration

Create `.codex/config.toml` in the consumer repository and add:

```toml
[mcp_servers.project_context]
command = "node"
args = ["node_modules/mcp-project-context-router/bin/project-context-mcp"]
cwd = ".."
startup_timeout_sec = 20
tool_timeout_sec = 60
env = { PROJECT_CONTEXT_TOOL_PROFILE = "core" }
```

You can copy the same content from
[`templates/client-configs/codex.toml`](../../templates/client-configs/codex.toml).
The relative `cwd = ".."` moves from `.codex/` to the consumer repository root,
so the MCP server reads that repository's `.project-context` data. Do not replace
it with this package repository's absolute path.

Codex loads project-scoped configuration only for a trusted project. Restart the
desktop app or IDE extension after changing the file, or start a new CLI
session.

## 3. Verify the connection

From the consumer repository, verify both the package and Codex connection:

```bash
npx project-context doctor --json
codex mcp list
```

In an interactive Codex session, `/mcp` should show `project_context`. Then ask:

```text
Use project_context to get the project brief and build a context pack for this task.
```

The server should expose the `core` tool profile. Change
`PROJECT_CONTEXT_TOOL_PROFILE` only if the agent needs the `developer`,
`analyst`, `admin`, or `full` surface described in the project README.

## Troubleshooting

- **Compiled MCP server is missing:** remove `node_modules` and reinstall without
  disabling npm lifecycle scripts. Git dependencies run the package's build step.
- **Codex cannot start `node`:** confirm `node --version` is at least 22.13 in the
  environment that launches Codex, not only in an interactive shell.
- **The server sees the wrong project:** keep the config under the consumer
  repository's `.codex/` directory and keep `cwd = ".."`.
- **The server is absent from `/mcp`:** trust the project and restart the active
  Codex client after editing `.codex/config.toml`.

Codex configuration details are documented in the official
[MCP guide](https://learn.chatgpt.com/docs/extend/mcp) and
[configuration guide](https://learn.chatgpt.com/docs/config-file/config-basic).
