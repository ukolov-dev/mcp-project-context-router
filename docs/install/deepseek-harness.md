# Install for DeepSeek Harness

This guide targets the official [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness), not similarly named third-party projects. DSH is a developer preview; follow its runtime/setup requirements. Client support is included in router **0.10.0** and newer.

## Install and launch

From the consumer Git repository root:

```bash
npm install --save-dev --save-exact https://github.com/ukolov-dev/mcp-project-context-router/releases/download/v0.10.1/mcp-project-context-router-0.10.1.tgz
npx project-context init --client deepseek-harness --with-skills
npx project-context index
npx project-context doctor --json
dsh web --patch "$PWD/.dsh/project-context.cordis.yml"
```

Install DSH separately using its official instructions; for an npx launch replace `dsh` with `npx @deepseek-ai/dsh`. The router does not install or authenticate the client. Launch DSH from this repository root: the overlay uses `cwd: .` and a local package entrypoint. Later shell `cd` calls do not rebind the MCP server to another project. Do not reuse this process-level overlay across unrelated workspaces.

The `.dsh/project-context.cordis.yml` overlay inserts one `@deepseek-ai/dsh-mcp-client` with the server name `project_context` and profile `core`. DSH exposes its tools as `mcp__project_context__<tool>`. Passing `--patch` is explicit: creating a file does not load it automatically. A standard DSH composition already provides shared MCP resources. For a custom composition, consult the DSH MCP documentation.

## Skills and connection check

`--with-skills` copies `project-context-workflow` and `context-research` into `.agents/skills/`, which DSH's filesystem skill provider scans by default. Custom compositions must mount their skill registry/provider; duplicate names in `.dsh/skills` take priority. Set `planning` in the MCP row's `PROJECT_CONTEXT_TOOL_PROFILE` if research tools are needed.

Start a new session and ask the agent to call `mcp__project_context__get_project_brief`, then build a context pack. Confirm the returned project matches your repository and inspect the actual calls. Doctor does not prove DSH attachment.

## Optional lifecycle hooks

```bash
npx project-context init --client deepseek-harness --with-skills --with-hooks
dsh web --patch "$PWD/.dsh/project-context.cordis.yml"
```

On a fresh setup, `--with-hooks` also writes `.dsh/project-context-hooks.json` and adds `@deepseek-ai/dsh-hooks-codex` to the overlay. This explicit DSH bridge loads the existing prompt/tool/Stop hooks. No Codex client is required. Hook commands currently require a POSIX shell and Git; DSH's bridge ignores `commandWindows`.

Existing project files, skills, hooks and overlays are never overwritten. If the overlay already exists (including when adding hooks later), merge the separate [hook-bridge row](../../templates/client-configs/deepseek-harness-hooks.cordis.yml) into it manually. Preserve existing patches and avoid duplicate plugin IDs/server names. Review hook commands, restart DSH and inspect its hook logs: the bridge can log a load/execution failure and continue without hooks.

Stop requires fresh task-scoped verification followed by finalization, or explicit partial/blocked reasons for unresolved checks. It does not run tests or grant independent acceptance. The bridge reduces some tool inputs and always reports `stop_hook_active: false`; source-content fingerprints still detect Git changes. It has no consecutive Stop cap: resolve evidence errors or report an honest partial result to avoid repeated continuation.

## Boundaries and sources

Tests cover installed MCP config execution, consumer identity, skill delivery, actual hook subprocesses and custom-file preservation. Native DSH model sessions, its live plugin loader and Windows are not verified. Developer-preview changes may require updating the overlay.

Official sources checked 2026-10-16: [MCP client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md), [overlay usage](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md), [skills](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/skill/skill-filesystem/README.md), [Codex hook bridge](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/experimental/hooks-codex/README.md).
