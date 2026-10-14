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
> `mcp-project-context-router@0.8.0`, requires Node.js 22.13 or newer, and is distributed
> from source or a versioned tarball. It is not currently published to an npm
> registry.

See the [changelog](CHANGELOG.md) and [GitHub releases](https://github.com/ukolov-dev/mcp-project-context-router/releases)
for versioned changes and installable tarballs.

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
npx project-context hooks install
```

`init` is non-destructive: it does not overwrite an existing configuration.
Review `.project-context/project.yaml` after generation and replace the example
modules, source globs, playbooks, and verification commands with real project
values.

`hooks install` creates a managed `.githooks/pre-commit`, configures the local
clone's `core.hooksPath`, and records that wiring in `project.yaml`. The hook runs
`doctor --commit` before every commit and blocks the commit when mappings are
invalid or context records reference missing, non-file, or out-of-repository
paths. Existing custom pre-commit hooks are never overwritten; merge the doctor
command manually when one is already present.

A typical agent workflow then looks like this:

```bash
npx project-context validate-task "Add CSV export" --mode feature
npx project-context pack "Add CSV export" --workflow standard --explain
npx project-context reuse-scan "CSV export"
npx project-context verify-task "CSV export"
```

Run `npx project-context --help` for the complete CLI surface.

## Connect your coding agent

The package includes client-specific setup guides and copy-ready configuration
templates:

| Client | Setup guide | Configuration template |
| --- | --- | --- |
| Codex desktop, CLI, and IDE | [Install for Codex](docs/install/codex.md) | [`templates/client-configs/codex.toml`](templates/client-configs/codex.toml) |
| OpenCode stable | [Install for OpenCode](docs/install/opencode.md) | [`templates/client-configs/opencode.json`](templates/client-configs/opencode.json) |
| OpenCode V2 preview | [OpenCode V2 notes](docs/install/opencode.md#opencode-v2-preview) | [`templates/client-configs/opencode-v2.json`](templates/client-configs/opencode-v2.json) |

A complete Russian-language OpenCode guide is also available:
[Использование в OpenCode](docs/install/opencode.ru.md). The Russian
[workflow and artifact guide](docs/workflow.ru.md) explains what is created at
each task stage and what an agent receives before implementation.

All three configurations start the same local stdio MCP server from the consumer
repository. They contain no credentials or workstation-specific absolute paths.
Codex uses `.codex/config.toml`; OpenCode uses `opencode.json` at the repository
root. The two OpenCode schemas are intentionally separate because stable and V2
currently use different MCP nesting and enablement fields.

The server supports scoped tool profiles:

| Profile | Intended use |
| --- | --- |
| `core` | Task contracts, context packs, reuse scans, verification, refactor review, and finalization |
| `planning` | `core` plus research history, research-to-backlog handoff, and backlog lifecycle |
| `developer` | `core` plus assigned-work acceptance and implementation reports |
| `analyst` | `core` plus research, requirements, source traceability, analyst packs, and Confluence publishing |
| `admin` | `core` plus research, backlog lifecycle, promotion, retention, and decision management |
| `full` | The complete compatibility surface |

`core` is the default. The legacy `PPM_CONTEXT_TOOL_PROFILE` variable remains
supported for compatibility.

Research preserves idea discussions, findings, status changes and conclusions separately
from implementation tasks, then creates linked backlog drafts. See the
[research workflow](docs/research.ru.md) and the portable
[Codex skill](templates/skills/context-research/SKILL.md).

Local search and context packs also support an **experimental**, opt-in `fts5` engine with a
partial-identifier reserve. The existing `current` engine remains the default.
FTS5 requires a runtime compiled with SQLite FTS5 (verified with Node.js 22.23.2);
Node.js 22.13.0 supports the default mode and falls back with a pack warning.
Use `project-context pack "quick_valid" --search-engine fts5 --max-tokens 4000`
or pass `searchEngine: "fts5"` to `build_context_pack`. See the
[SQLite search modes](docs/sqlite-index.md#optional-fts5-search-mode) and
[evaluation](docs/search-evaluation.md).

## Configure your project stack

There is no language switch: discovery runs automatically for files selected by
`modules.*.source_globs` in `.project-context/project.yaml`. Project memory, task
contracts and context packs work independently of the application stack. The
router itself requires Node.js 22.13+ and npm, even when the application uses
another language.

For a repository without `package.json`, run `npm init -y` before
the install command in Quick start. This adds the router's Node tooling beside
your existing application build; keep the resulting package manifest and lockfile
in the consumer repository.

To update an existing GitHub installation to the current `main` code:

```bash
npm install --save-dev --save-exact github:ukolov-dev/mcp-project-context-router#main
```

Review the changed lockfile and restart any running router MCP server so it loads
the updated package. Versioned release tarballs contain the code from their tag;
updating to `main` may include changes published after the latest release.

After installing the router, initialize from the consumer repository root:

```bash
npx project-context init --name "My Project" --module backend:src
```

Choose the initial module for the example layout you use:

| Stack | `--module` |
| --- | --- |
| C# / .NET | `backend:src` |
| Java / Spring or Node.js backend | `backend:backend` |
| Frontend | `frontend:frontend` |
| Python, Go or Rust examples | `app:.` |

`init` preserves existing configuration.
Add or update the relevant blocks below in `.project-context/project.yaml`; keep
other project settings and replace example paths and commands with your own.
Explicit `source_globs` replace the module's defaults, so include every source
path you need. Choose `routing.default_modules` for your project's default area.

### C# / .NET

The default globs already include `.cs`. This example assumes solution projects
under `src/` and a solution at the repository root:

```yaml
routing:
  default_modules: [backend]
modules:
  backend:
    path: src
    aliases: [backend, api, csharp, dotnet]
    source_globs:
      - "src/**/*.cs"
      - "!src/**/obj/**"
      - "!src/**/bin/**"
    playbooks: [AGENTS.md]
commands:
  backend_build:
    run: dotnet build
    required_for: [backend]
    context_pack: true
  backend_tests:
    run: dotnet test
    required_for: [backend]
    context_pack: true
```

Discovery recognizes common class, struct, record, interface and enum
declarations, constructors, methods and properties, including multiline
declarations. ASP.NET Core controller routes support literal `Route`, `HttpGet`,
`HttpPost`, `HttpPut`, `HttpPatch`, `HttpDelete`, `HttpHead` and `HttpOptions`
attributes, `[controller]` / `[action]` tokens, and absolute action routes.
Computed templates and non-public, static or `NonAction` methods are skipped.

This is a text heuristic, not Roslyn. It does not resolve inheritance,
conditional compilation, custom routing conventions, every C# declaration form,
or Minimal API endpoints. Raw/interpolated route strings and complex attribute
combinations are outside this basic coverage.

### Java / Spring

Maven and Gradle use the same source module configuration. The examples below
assume the application/build files are under `backend/` and the selected wrapper
is at the repository root; adjust both paths to match your layout.

#### Maven

```yaml
routing:
  default_modules: [backend]
modules:
  backend:
    path: backend
    aliases: [backend, api, java, spring]
    source_globs:
      - "backend/src/**/*.java"
    playbooks: [AGENTS.md]
commands:
  backend_verify:
    run: ./mvnw -f backend/pom.xml verify
    required_for: [backend]
    context_pack: true
```

#### Gradle

Keep the Java module above and replace its `commands` block with:

```yaml
commands:
  backend_verify:
    run: ./gradlew -p backend build
    required_for: [backend]
    context_pack: true
```

This also works with Kotlin DSL `build.gradle.kts`; the selected source files in
this example remain Java. For a Gradle multi-project build rooted at the
repository root, use its actual task path, for example `./gradlew :backend:build`,
instead of treating the subproject as a separate build. On Windows, use
`mvnw.cmd` or `gradlew.bat` in place of the shell wrapper. See the official
[Gradle CLI](https://docs.gradle.org/current/userguide/command_line_interface.html)
and [wrapper guide](https://docs.gradle.org/current/userguide/gradle_wrapper.html).

Discovery recognizes class, record, interface and enum declarations, plus simple
Spring MVC `RequestMapping` and `Get/Post/Put/Patch/DeleteMapping` annotations
with literal routes. It does not provide Java method discovery, compiler-level
analysis, or complete Spring routing resolution.

### Frontend / TypeScript / JavaScript

This example assumes a frontend package under `frontend/` with `build` and
`test` scripts. It includes `src/` and root-level Next.js `app/` or `pages/`
directories when present:

```yaml
routing:
  default_modules: [frontend]
modules:
  frontend:
    path: frontend
    aliases: [frontend, web, react, next, ui]
    source_globs:
      - "frontend/src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"
      - "frontend/{app,pages}/**/*.{ts,tsx,js,jsx}"
    playbooks: [AGENTS.md]
commands:
  frontend_build:
    run: npm --prefix frontend run build
    required_for: [frontend]
    context_pack: true
  frontend_tests:
    run: npm --prefix frontend test
    required_for: [frontend]
    context_pack: true
```

Use your project's non-interactive test command and package manager. Discovery
recognizes function, constant, type and interface declarations using text rules;
it classifies common `use*` functions as hooks and capitalized functions as
components. It does not resolve imports, infer framework routes, or fully parse
JSX, Vue/Svelte components or TypeScript semantics.

### Node.js backend / TypeScript / JavaScript

This example assumes a Node.js service in `backend/` with sources in `src/` and
existing `build` and `test` npm scripts:

```yaml
routing:
  default_modules: [backend]
modules:
  backend:
    path: backend
    aliases: [backend, api, node, nodejs, javascript, typescript]
    source_globs:
      - "backend/src/**/*.{ts,js,mjs,cjs,mts,cts}"
    playbooks: [AGENTS.md]
commands:
  backend_build:
    run: npm --prefix backend run build
    required_for: [backend]
    context_pack: true
  backend_tests:
    run: npm --prefix backend test
    required_for: [backend]
    context_pack: true
```

Node.js uses the same TS/JS discovery rules as the frontend example; Express,
Fastify and other framework routes are not automatically resolved. For plain
JavaScript without a build script, omit `backend_build`. If the service is at the
repository root, use `path: .`, `src/**/*.{ts,js,mjs,cjs,mts,cts}` globs and
commands without `--prefix`. Use the project's actual scripts and package manager.

### Python

This example assumes sources in `src/`, tests in `tests/`, and pytest already
installed in the active Python environment:

```yaml
routing:
  default_modules: [app]
modules:
  app:
    path: .
    aliases: [app, backend, api, python]
    source_globs:
      - "src/**/*.py"
      - "tests/**/*.py"
    playbooks: [AGENTS.md]
commands:
  python_syntax:
    run: python -m compileall -q src tests
    required_for: [app]
    context_pack: true
  python_tests:
    run: python -m pytest tests
    required_for: [app]
    context_pack: true
```

Use the interpreter/environment and test runner already used by your project;
replace `python` with `python3` where appropriate. `compileall` checks syntax and
writes bytecode caches, so keep `__pycache__/` and `*.pyc` out of Git. It does not
replace linting, type checks or tests. Command references:
[compileall](https://docs.python.org/3/library/compileall.html) and
[pytest](https://docs.pytest.org/en/stable/how-to/usage.html).

Python discovery recognizes `def` / `async def` functions, class methods and
classes, including decorated and multiline headers and generic type parameters.
Explicit aliases declared with `type Name = ...` or `Name: TypeAlias = ...` are
indexed as types. Leading underscores are treated as private by convention;
`__all__`, decorator effects and inferred assignment aliases are not resolved.

### Go

This example assumes `go.mod` at the repository root:

```yaml
routing:
  default_modules: [app]
modules:
  app:
    path: .
    aliases: [app, backend, api, go, golang]
    source_globs:
      - "**/*.go"
      - "!vendor/**"
    playbooks: [AGENTS.md]
commands:
  go_build:
    run: go build ./...
    required_for: [app]
    context_pack: true
  go_tests:
    run: go test ./...
    required_for: [app]
    context_pack: true
```

For multiple Go modules, configure their actual source paths and run checks from
each module directory. The commands above target the module rooted in the current
directory. See the official [Go command reference](https://pkg.go.dev/cmd/go).

Go discovery recognizes named functions, methods with receivers, generic
functions/types, struct/interface declarations, named types and aliases,
including `type (...)` groups. Names beginning with an uppercase letter are
marked exported. Interface member signatures and compiler/build-tag semantics
are outside this basic declaration coverage.

### Rust

This example assumes a Cargo package with `Cargo.toml` at the repository root:

```yaml
routing:
  default_modules: [app]
modules:
  app:
    path: .
    aliases: [app, backend, rust, cargo]
    source_globs:
      - "**/*.rs"
      - "!target/**"
    playbooks: [AGENTS.md]
commands:
  rust_check:
    run: cargo check --all-targets
    required_for: [app]
    context_pack: true
  rust_tests:
    run: cargo test
    required_for: [app]
    context_pack: true
```

`cargo check` checks the package without producing the final executable. For a
workspace, add `--workspace` to both commands when all members must be checked.
See the official [cargo check](https://doc.rust-lang.org/cargo/commands/cargo-check.html)
and [cargo test](https://doc.rust-lang.org/cargo/commands/cargo-test.html) references.

Rust discovery recognizes functions and methods in `impl` / `trait` blocks,
structs, enums, traits, unions and type aliases. Common generics, lifetimes, raw
identifiers and function qualifiers are accepted. Visibility reflects explicit
`pub` and public trait items; restricted `pub(crate)` / `pub(super)` items are
not marked externally exported. `macro_rules!` definitions and macro invocations are skipped.

All three languages have dedicated declaration extractors, selected automatically
for `.py`, `.go` and `.rs` sources. Comments and string literals are masked before
discovery; symbols feed the same SQLite index, reuse scans and context packs as
other languages. Existing consumer indexes refresh after this extractor upgrade.
These are bounded text parsers, not compiler frontends: they do not resolve
imports, inheritance, generated symbols, macro expansion, conditional compilation,
framework endpoints or the entire language grammar. A missing `reuse-scan` result
does not prove that an implementation is absent; inspect the code and use reviewed
context records or `pack --file` hints when needed.

For a monorepo, combine the relevant module/command blocks under one
`modules` and one `commands` mapping. Use distinct module names and actual service
paths when multiple examples would otherwise share `app` or `backend`. Add a
separate module or globs for tests and documentation if they live outside the
selected source paths. Use `AGENTS.md`
in `playbooks` only when that file exists in the consumer repository; otherwise
use your actual instruction files or `playbooks: []`.

### Index and check the configuration

From the consumer repository root, after editing the configuration:

```bash
npx project-context index
npx project-context doctor --json
npx project-context reuse-scan "CustomerService" --modules backend
npx project-context pack "Update customer API" --modules backend
```

For frontend-only projects, use `--modules frontend` and a component or hook
name. For Python, Go or Rust, use `--modules app` and your function/type names.
An explicit source path can also be supplied, for example:

```bash
npx project-context pack "Update customer service" --modules app --file src/customer.py
```

Replace that path with an existing `.py`, `.go` or `.rs` file in your repository.
Source edits and discovery-rule upgrades refresh the index automatically;
`index` also lets you rebuild it explicitly. Configured build/test commands are
verification guidance; indexing does not compile or execute the application.

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

## Supported memory records

The router supports 13 record types: `task`, `bug`, `decision`, `backlog`,
`research`, `verification-evidence`, `agent-run`, `acceptance-review`, `project`,
`requirement`, `open_question`, `source`, and `source_chunk`.

Task acceptance criteria stay inside the Task Contract. `finalize_work` saves
`last_result` on that same task; it no longer creates a separate run summary.
Requirement traces match exact task IDs or explicit `task_key` / `task_keys`
metadata. Portal work preserves its source document, revision and task code.

Current source retires the unused integration/API/data-entity/meeting/acceptance
and module/pattern/runbook/refactor/summary record types. Existing files remain
readable and archivable. Module routing and playbooks are project configuration.
See [migration and removed commands](docs/record-model.md) before updating consumers.

## Task execution

Confirmed tasks can have execution manifests, evidence-gated states, and a
separate acceptance review. An optional `project-context run TASK-ID --adapter
execution-adapter.json` command previews external implementation and review
commands; `--execute` runs the workflow in the current checkout. See the
[execution guide](docs/execution.md) for the adapter protocol, CLI/MCP tools,
verification gates, and retry behavior.

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
scripts, installation guides, consumer templates, and this README. It excludes
`.project-context`, `.codex`, tests, source TypeScript, generated indexes, and
`node_modules`.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a change. The required
handoff checks are `npm run build`, `npm test`, `npm run package:check`, and
`node bin/project-context doctor --json`.

## License

No open-source license has been granted yet. The package is marked `UNLICENSED`;
public availability of the source does not grant permission to copy, modify, or
redistribute it.

### Upgrading to 0.7

See the [0.7 migration guide](docs/upgrade-0.7.md) for configured routing, lifecycle-aware retrieval, actionable diagnostics, required verification and scoped review. Existing records are preserved. The [sanitized audit plan](docs/reliability-audit.md) maps findings to regression coverage.
