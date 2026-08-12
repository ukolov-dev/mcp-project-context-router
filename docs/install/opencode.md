# Install Project Context Router for OpenCode

OpenCode starts Project Context Router as a local stdio MCP server. Keep the
configuration in the consumer repository so the server reads that repository's
project context and can be shared with the team.

OpenCode stable and the V2 preview currently use different MCP schemas. Use the
stable configuration unless the command you installed is explicitly
`opencode2`.

## Prerequisites

- Node.js 22.13 or newer
- npm and an npm-based project with a committed lockfile
- OpenCode stable, or the separately installed OpenCode V2 preview

## 1. Install and initialize the router

Run these commands from the repository that should own the project context:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
npx project-context init --name "Example Project" --module app:src
npx project-context index
npx project-context doctor --json
```

Replace the example project name and module mapping, then review
`.project-context/project.yaml`. The installed module is named
`vincenzo-mcp-context`. Commit and review the resulting lockfile: it pins the
resolved Git commit even though the install command tracks the repository's
default branch.

## 2. Configure OpenCode stable

Create or merge `opencode.json` at the consumer repository root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "project_context": {
      "type": "local",
      "command": [
        "node",
        "node_modules/vincenzo-mcp-context/bin/project-context-mcp"
      ],
      "cwd": ".",
      "enabled": true,
      "environment": {
        "PROJECT_CONTEXT_TOOL_PROFILE": "core"
      },
      "timeout": 20000
    }
  }
}
```

The copy-ready file is
[`templates/client-configs/opencode.json`](../../templates/client-configs/opencode.json).
If `opencode.json` already exists, merge only the `project_context` entry under
its existing `mcp` object.

Start a new OpenCode session, then verify the connection:

```bash
opencode mcp list
```

Ask OpenCode to use `project_context` to get the project brief or build a context
pack. OpenCode prefixes MCP tool names with the server name, so tool names are
shown as `project_context_<tool>`.

## OpenCode V2 preview

Use this section only when the installed command is `opencode2`. V2 nests local
servers under `mcp.servers` and connects them unless `disabled` is `true`; the
stable `enabled` field is not part of the V2 schema.

Create or merge `opencode.json` at the repository root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "timeout": {
      "startup": 20000,
      "catalog": 30000,
      "execution": 600000
    },
    "servers": {
      "project_context": {
        "type": "local",
        "command": [
          "node",
          "node_modules/vincenzo-mcp-context/bin/project-context-mcp"
        ],
        "cwd": ".",
        "environment": {
          "PROJECT_CONTEXT_TOOL_PROFILE": "core"
        }
      }
    }
  }
}
```

The copy-ready file is
[`templates/client-configs/opencode-v2.json`](../../templates/client-configs/opencode-v2.json).
Verify it with:

```bash
opencode2 mcp list
```

## Troubleshooting

- **OpenCode reports an unknown `servers` or `disabled` field:** use the stable
  config; the V2 schema is only for `opencode2`.
- **OpenCode reports an unknown `enabled` field:** use the V2 config and place the
  server under `mcp.servers`.
- **The server sees the wrong project:** keep `opencode.json` in the consumer
  repository root and keep `cwd` set to `.`.
- **The MCP process exits immediately:** run `node --version` and
  `npx project-context doctor --json` from the same repository. Reinstall if the
  compiled `dist/` files are missing.
- **Too many MCP tools consume context:** keep the `core` profile, or disable
  other MCP servers that are not needed for the task.

See the official OpenCode documentation for the
[stable MCP schema](https://opencode.ai/docs/mcp-servers/),
[configuration precedence](https://opencode.ai/docs/config/), and the separate
[V2 MCP schema](https://opencode.ai/v2/docs/mcp-servers).
