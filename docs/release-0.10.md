# Project Context Router 0.10.0

This release adds setup support for **ZCode (Z.ai)** and the official **DeepSeek Harness**. Router runtime requires Node.js 22.13 or newer; each client has its own runtime requirements. Distribution uses GitHub releases, not the npm registry.

## Install or upgrade

Download `mcp-project-context-router-0.10.0.tgz` and `SHA256SUMS` from the [release](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.10.0):

```bash
shasum -a 256 -c SHA256SUMS
npm install --save-dev --save-exact ./mcp-project-context-router-0.10.0.tgz
```

Then choose your client from the consumer repository root:

```bash
# ZCode
npx project-context init --client zcode --with-skills

# Official DeepSeek Harness
npx project-context init --client deepseek-harness --with-skills --with-hooks
dsh web --patch "$PWD/.dsh/project-context.cordis.yml"
```

Install DSH separately; the router does not install clients, authenticate models or edit global settings. Run `npx project-context index` and `npx project-context doctor --json`, review/commit the lockfile and shared settings, then reconnect your client.

## Changes

- `init --client zcode` creates `.zcode/config.json` for the core stdio MCP server; optional skills go to `.zcode/skills`.
- `init --client deepseek-harness` creates an explicit `.dsh/project-context.cordis.yml` overlay and uses `.agents/skills`. Optional hooks are loaded through DSH's official `@deepseek-ai/dsh-hooks-codex` bridge and `.dsh/project-context-hooks.json`.
- ZCode does not run project-level hooks: that flag combination is rejected before writes. A manual user-level hook template and Stop adapter support reviewed desktop/CLI integration.
- An explicit `--client codex` copies the existing MCP template. Plain init and existing Codex hook/skill flags keep their prior behavior.
- Existing client files, skills and project configuration are preserved; unsafe escaping destinations are rejected. The website and guides provide English/Russian setup instructions.

## Migration and activation

No memory-record migration is introduced. Existing indexes remain disposable. If a client file is reported in `skipped`, merge the bundled template manually. Adding DSH hooks to an existing overlay also needs the separate bridge row merged; creating a hooks file does not activate it. Keep DSH's working directory bound to the consumer root. ZCode hooks belong in reviewed user configuration, not workspace settings.

[ZCode guide](install/zcode.md) · [ZCode на русском](install/zcode.ru.md) · [DSH guide](install/deepseek-harness.md) · [DSH на русском](install/deepseek-harness.ru.md).

## Verification and limits

Build, full tests, package contents, clean installed consumer CLI/MCP/client configurations, hook subprocesses, bilingual site checks and doctor are required before publishing. CI checks both Node 22.13.0 and 22.23.2. UI validation covers English/Russian home pages at desktop/mobile widths, copy controls and navigation.

Native ZCode/DSH model sessions, DSH's live plugin loader and Windows are not verified. DSH is developer preview; its Codex bridge currently requires a POSIX shell for these commands and ignores `commandWindows`. ZCode desktop caps repeated Stop continuation. Hooks validate reported evidence, not actual test execution or independent acceptance. Existing transitive dependency advisories and experimental FTS5 limits remain; no clean security-audit claim is made.
