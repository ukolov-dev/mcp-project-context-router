# Project Context Router

[![CI](https://github.com/ukolov-dev/mcp-project-context-router/actions/workflows/ci.yml/badge.svg)](https://github.com/ukolov-dev/mcp-project-context-router/actions/workflows/ci.yml)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/Model_Context_Protocol-server-5A67D8)](https://modelcontextprotocol.io/)

A local-first CLI and [Model Context Protocol](https://modelcontextprotocol.io/)
server that gives coding agents structured project memory, task contracts, compact
context packs, backlog workflows, and verification evidence.

The router keeps durable knowledge in reviewable Markdown and YAML inside the
consumer repository. A disposable SQLite index makes retrieval fast without
turning an external service into the source of truth.

> Status: active development. The current package is
> `vincenzo-mcp-context@0.4.0`, requires Node.js 22.13 or newer, and is distributed
> from source or a versioned tarball. It is not currently published to an npm
> registry.

## Why use it?

- Keep project memory versioned beside the code that it describes.
- Give agents a focused context pack instead of an unbounded repository dump.
- Validate and confirm a Task Contract before implementation begins.
- Search existing capabilities before adding duplicate code.
- Track backlog state, dependencies, decisions, and verification evidence.
- Expose the same workflow through a human-friendly CLI and MCP tools.
- Keep generated drafts and indexes out of version control and package artifacts.

## Quick start

Install directly from GitHub in the repository that should own the project
context:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router
npx project-context init --name "Example Project" --module app:src
npx project-context index
npx project-context doctor --json
```

`init` is non-destructive: it does not overwrite an existing configuration.
Review `.project-context/project.yaml` after generation and replace the example
modules, source globs, playbooks, and verification commands with real project
values.

A typical agent workflow then looks like this:

```bash
npx project-context validate-task "Add CSV export" --mode feature
npx project-context pack "Add CSV export" --workflow standard --explain
npx project-context reuse-scan "CSV export"
npx project-context verify-task "CSV export"
```

Run `npx project-context --help` for the complete CLI surface.

## Connect the MCP server

Add a project-scoped Codex configuration at `.codex/config.toml` in the consumer
repository:

```toml
[mcp_servers.project_context]
command = "node"
args = ["node_modules/vincenzo-mcp-context/bin/project-context-mcp"]
cwd = ".."
startup_timeout_sec = 20
tool_timeout_sec = 60
env = { PROJECT_CONTEXT_TOOL_PROFILE = "core" }
```

The server supports scoped tool profiles:

| Profile | Intended use |
| --- | --- |
| `core` | Task contracts, context packs, reuse scans, verification, refactor review, and finalization |
| `developer` | `core` plus assigned-work acceptance and implementation reports |
| `analyst` | `core` plus requirements, source traceability, analyst packs, and Confluence publishing |
| `admin` | `core` plus backlog lifecycle, promotion, retention, and decision management |
| `full` | The complete compatibility surface |

`core` is the default. The legacy `PPM_CONTEXT_TOOL_PROFILE` variable remains
supported for compatibility.

## How data is laid out

```text
.project-context/
├── project.yaml       # routing, modules, commands, and project identity
├── active/            # reviewed, durable project records
├── drafts/            # reviewable generated proposals (ignored)
├── indexes/           # rebuildable SQLite/cache data (ignored)
└── templates/         # Task Contract and Verification Record templates
```

Project data belongs to the consumer repository, not to this package. The
configuration routes queries to modules and playbooks; the index adds fast
retrieval; the CLI and MCP server apply the same workflow and repository-boundary
checks.

## Safety model

- Repository-boundary and symlink-escape checks reject paths outside the project.
- Secret-like values are redacted from generated excerpts.
- Credentials are read from environment variables or supported native credential
  stores and are never written into exported project context.
- Indexes, drafts, trash, build outputs, and local environment files are ignored.
- The npm package allowlist excludes source-project records, credentials, source
  TypeScript, tests, and generated SQLite databases.
- Network integrations such as Confluence and Context Hub are optional and require
  explicit project configuration and credentials.

See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Develop locally

```bash
git clone https://github.com/ukolov-dev/mcp-project-context-router.git
cd mcp-project-context-router
npm ci
npm run build
npm test
npm run package:check
node bin/project-context doctor --json
```

To exercise the installable artifact locally:

```bash
mkdir -p artifacts
npm pack --pack-destination ./artifacts
```

The tarball contains compiled runtime code, launchers, hooks, credential helper
scripts, consumer templates, and this README. It excludes `.project-context`,
`.codex`, tests, source TypeScript, generated indexes, and `node_modules`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. The required
handoff checks are `npm run build`, `npm test`, `npm run package:check`, and
`node bin/project-context doctor --json`.

## License

No open-source license has been granted yet. The package is marked `UNLICENSED`;
public availability of the source does not grant permission to copy, modify, or
redistribute it.
