# Quick start

Install the router in the repository that should own the project context.

## Install and initialize

You need Node.js **22.13 or newer** and npm. If the repository has no `package.json`, run `npm init -y` first.

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.0/mcp-project-context-router-0.10.0.tgz
npx project-context init --name "My project" --module app:src --with-skills
npx project-context index
npx project-context doctor --json
```

Adjust the project name and source path. Review `.project-context/project.yaml`: source globs, playbooks and checks must match your repository. Commit the package manifest and lockfile. The URL pins the prebuilt 0.10.0 release; no npm-registry publication is required.

`--with-skills` installs `project-context-workflow` and `context-research` into `.agents/skills/`. It works for existing projects and preserves customized files. Plain `init` installs no skills. Updating the npm package does not replace installed skill copies.

## Optional Codex lifecycle hooks

```bash
npx project-context init --with-hooks --with-skills
```

`--with-hooks` creates repository-local `.codex/hooks.json` with `UserPromptSubmit`, `PostToolUse` and `Stop`. Plain `init` installs no lifecycle hooks. Existing hook files and project configuration are preserved and reported in `skipped`; merge the [bundled template](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/templates/client-configs/codex-hooks.json) manually if you already have hooks. Keep the package installed locally and use a Git checkout; commands resolve the repository root even when Codex works in a subdirectory. Standalone exports use their own `hooks/` directory.

Review the commands, trust the project, and review/trust the exact hook definitions in Codex (`/hooks` in the CLI). Restart or reconnect the client as needed. Installation does not grant trust or prove hooks are active; see the official [Codex hooks guide](https://learn.chatgpt.com/docs/hooks).

The prompt hook supplies workflow hints. The tool hook fingerprints staged, unstaged, untracked and deleted files. The Stop hook checks every confirmed task whose declared `files` overlap changes: save fresh `record_verification_evidence`, then call `finalize_work`. All required checks must pass, or the result must explicitly be `partial`/`blocked` with a reason for every unresolved check (`checks[].reason` in evidence or `skippedChecks: [{command, reason}]` in finalization). A bare finalization timestamp is insufficient. New source edits invalidate evidence; reading tools and generated task/evidence/index records do not. Repeated Stop events continue to block missing evidence.

Hooks validate reported evidence; they do not run tests, independently accept work, close tasks, or intercept every possible client operation. `completion: "complete"` still requires an independently accepted execution run. An explained partial result permits a final response without claiming completion. The Git pre-commit check remains a separate `npx project-context hooks install` command.

Hook state is disposable under ignored `.project-context/indexes/hook-state/`; inactive session files expire after seven days. For a storage/configuration error, repair the reported path and retry. Existing installed hook copies/configuration are never silently upgraded; compare them with the bundled template after package updates.

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

## ZCode and DeepSeek Harness

Release **0.10.0** includes both clients. After installing the package above, choose your client:

```bash
npx project-context init --client zcode --with-skills
npx project-context init --client deepseek-harness --with-skills --with-hooks
```

Choose your client. ZCode receives `.zcode/config.json` and `.zcode/skills`; its project hooks are ignored by the host, so use the documented manual user-level setup. DSH receives `.dsh/project-context.cordis.yml` and `.agents/skills`. Start it from the repository root with `dsh web --patch "$PWD/.dsh/project-context.cordis.yml"`; the hook flag adds its explicit Codex bridge. Custom files are preserved; merge skipped configurations manually.

[ZCode setup](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/zcode.md) · [DeepSeek Harness setup](https://github.com/ukolov-dev/mcp-project-context-router/blob/main/docs/install/deepseek-harness.md). Automated MCP/hook subprocess tests do not prove connection in a live client session.

## Check the connection

Ask your agent: “Use project_context to get the project brief and build a context pack for this task.” A doctor check verifies configuration and local data, not attachment to your current chat. Confirm a real tool call works.

The CLI also works without an MCP client:

```bash
npx project-context pack "Update customer service" --modules app
npx project-context reuse-scan "CustomerService" --modules app
```

Continue with [project configuration](configuration.html) to select the correct source paths and verification commands.
