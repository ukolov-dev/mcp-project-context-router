# Project configuration

There is no language switch. Discovery runs for files selected by `modules.*.source_globs`. The application can use any stack; the router itself runs on Node.js.

## Define modules and checks

Edit `.project-context/project.yaml`. Use repository-relative paths and the commands already used by your team.

```yaml
project:
  name: My project
routing:
  default_modules: [app]
modules:
  app:
    path: src
    aliases: [app, backend, customer]
    source_globs: ["src/**/*.{ts,tsx,js,jsx}"]
    playbooks: [AGENTS.md]
commands:
  app_tests:
    run: npm test
    required_for: [app]
    context_pack: true
```

Explicit globs replace defaults. Include tests and configuration files when they belong in project context. Playbooks are existing repository instructions selected for the relevant module; they are not a separate memory record type.

## Choose your stack

| Stack | Example source globs | Example check |
| --- | --- | --- |
| TypeScript / frontend / Node.js | `src/**/*.{ts,tsx,js,jsx,mjs,cjs,mts,cts}` | `npm test`, `npm run build` |
| C# / .NET | `src/**/*.cs` | `dotnet build`, `dotnet test` |
| Java / Maven | `src/**/*.java` | `./mvnw verify` |
| Java / Gradle | `src/**/*.java` | `./gradlew check` |
| Python | `src/**/*.py` | `python -m pytest` |
| Go | `**/*.go` | `go test ./...` |
| Rust | `src/**/*.rs`, `tests/**/*.rs` | `cargo test` |

These paths and commands are examples. Point them at the actual application and installed build tooling. For a monorepo, create separate modules and run each service's checks from its directory.

Python discovery recognizes functions, async functions and classes. Go includes functions, methods, structs, interfaces and named types. Rust includes functions, structs, enums, traits and type aliases. C# includes common types, methods, properties and literal ASP.NET controller routes.

Discovery is a lexical heuristic, not a compiler or language server. It does not resolve all inheritance, macros, conditional compilation or computed routes. C# Minimal API endpoints are outside basic route coverage. The [README stack guide](https://github.com/ukolov-dev/mcp-project-context-router#configure-your-project-stack) contains fuller configurations and limits.

## Select a tool profile

Set `PROJECT_CONTEXT_TOOL_PROFILE` in the MCP server environment, preserving other existing variables.

| Profile | Tools for |
| --- | --- |
| `core` | Task contracts, context packs, reuse, verification, refactor review and finalization |
| `planning` | Core plus research and the backlog lifecycle |
| `analyst` | Core plus research, requirements, source traceability, analyst packs and Confluence publishing |
| `developer` | Core plus execution/review records and portal assignment/report tools |
| `admin` | Core plus execution, research, backlog, promotion, retention and decision management |
| `full` | All registered tools |

`core` is the default. Profiles are tool selections, not permission grants. Restart the MCP connection after changes. Research needs a profile such as `planning`; installing a skill does not change the profile.

## Verify the setup

```bash
npx project-context index
npx project-context doctor --json
npx project-context pack "Update customer service" --modules app --file src/customer.ts
```

Use real paths. For specific work, pass concrete modules and files instead of relying on broad text matching. Continue with the [agent workflow](workflow.html).
