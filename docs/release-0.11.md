# Project Context Router 0.11.0

Tree docs is now the primary navigation approach: project map → document → section → implementation and checks. This release adds local directory browsing, Markdown outlines and section reading through both CLI and MCP, while preserving the routing, hooks, client setup and website features of 0.10.1.

## Install or upgrade

Download the tarball and `SHA256SUMS` from the [release](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.11.0):

```bash
shasum -a 256 -c SHA256SUMS
npm install --save-dev --save-exact ./mcp-project-context-router-0.11.0.tgz
npx project-context index
npx project-context doctor --json
```

Requires Node.js 22.13 or newer. Commit the updated manifest and lockfile, then reconnect the MCP client so it loads the three new tools. Distribution remains through GitHub releases; this release does not publish to the npm registry.

## Tree docs

```bash
npx project-context docs tree docs --depth 2 --json
npx project-context docs outline docs/guide.md --json
npx project-context docs read docs/guide.md --section install --max-chars 4000 --json
```

Choose an existing document from the tree and a section ID returned by its outline. MCP equivalents are `get_document_tree`, `get_document_outline` and `read_document_section`, available in `core` and every extended profile. The operations share one implementation and work without a retrieval index or configured modules.

Results include relative paths, unique heading IDs and source line ranges. Reading a section includes its subsections and stops at the next sibling or ancestor heading. Use `nextOffset` to continue a truncated response. Detected secrets are redacted before section selection while preserving line positions.

## Compatibility and limits

- Existing context-pack, routing, client setup and hook APIs retain their behavior. No document or memory migration is required.
- Files must be repository-relative UTF-8 `.md` or `.markdown`, at most 1 MiB. Symlinks and private/generated/Git-ignored paths are excluded. Active `.project-context` documents remain readable.
- Heading extraction supports ATX and single-line Setext outside fenced code and frontmatter. It is not a complete Markdown/HTML/MDX renderer.
- The file tree is built from disk; authors maintain the semantic map and cross-links. Sources may change between paginated reads, so restart reading after an edit.
- Verification covers unit and CLI/MCP regressions, package contents, a clean installed consumer and both website languages. CI checks Node 22.13.0 fallback and Node 22.23.2 FTS5 behavior on Linux. Native Windows and live client sessions are not part of these automated checks.

See the [Tree docs guide](tree-docs.md) and [repository map](context-map.md).
