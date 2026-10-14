# Quick start

Install the router in the repository that should own the project context.

## Install and initialize

You need Node.js **22.13 or newer** and npm. If the repository has no `package.json`, run `npm init -y` first.

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
npx project-context init --name "My project" --module app:src --with-skills
npx project-context index
npx project-context doctor --json
```

Adjust the project name and source path. Review `.project-context/project.yaml`: source globs, playbooks and checks must match your repository. Commit the package manifest and lockfile; Git installations are pinned to an exact commit.

`--with-skills` installs `project-context-workflow` and `context-research` into `.agents/skills/`. It works for existing projects and preserves customized files. Plain `init` installs no skills. Updating the npm package does not replace installed skill copies.

## Connect your agent

For Codex, create `.codex/config.toml` in the consumer repository:

```toml
[mcp_servers.project_context]
command = "node"
args = ["node_modules/mcp-project-context-router/bin/project-context-mcp"]
cwd = ".."
startup_timeout_sec = 20
tool_timeout_sec = 60
env = { PROJECT_CONTEXT_TOOL_PROFILE = "core" }
```

Trust the project and reconnect the client after changing configuration. The relative `cwd` is resolved from `.codex/`; the server must read the consumer repository.

For OpenCode, use the [stable configuration template](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/opencode.json). The [V2 template](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/opencode-v2.json) has a different schema. [Full OpenCode guide](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/opencode.md).

## Check the connection

Ask your agent: “Use project_context to get the project brief and build a context pack for this task.” A doctor check verifies configuration and local data, not attachment to your current chat. Confirm a real tool call works.

The CLI also works without an MCP client:

```bash
npx project-context pack "Update customer service" --modules app
npx project-context reuse-scan "CustomerService" --modules app
```

Continue with [project configuration](configuration.html) to select the correct source paths and verification commands.
