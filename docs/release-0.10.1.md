# Project Context Router 0.10.1

This patch release fixes task-aware module routing and context ranking. It includes all 0.10.0 client setup features and requires Node.js 22.13 or newer. Distribution uses GitHub releases, not the npm registry.

## Install or upgrade

Download the package and `SHA256SUMS` from the [release](https://github.com/ukolov-dev/mcp-project-context-router/releases/tag/v0.10.1):

```bash
shasum -a 256 -c SHA256SUMS
npm install --save-dev --save-exact ./mcp-project-context-router-0.10.1.tgz
npx project-context index
npx project-context doctor --json
```

Commit the manifest and lockfile, then reconnect the MCP client. Existing running servers do not reload their code automatically. A vendored installation should merge the upstream changes into its own Router directory, preserve project-specific changes, reinstall dependencies and rebuild.

## Changes

- Exact task/backlog keys from IDs, titles, tags or `task_key` can select modules before the configured fallback. Prefixes and incidental body mentions do not create links; explicit module/file scope retains priority.
- Short module aliases also match hyphenated words. Explicit `taskId` routing no longer keeps unrelated fallback modules.
- Default `current` retrieval prioritizes exact work keys and links to supplied files. Update instants, including timezone offsets, and task activity break relevance ties.
- Completed tasks/backlog requested by an exact key may appear with historical provenance; general queries retain history exclusions. A historical result is not proof of current runtime behavior.
- Malformed optional `task_key` values are ignored rather than crashing retrieval. Previous pack caches are invalidated automatically.

## Verification and limits

Build, full tests, package contents, clean installed consumer CLI/MCP checks, bilingual website checks and doctor are required before release. CI covers Node 22.13.0 and 22.23.2. Consumer routing/retrieval probes run in isolated project snapshots; product deployments are outside this release.

Experimental FTS5 retains its BM25 ranking. No memory migration, hook activation or client-settings replacement is required. Existing transitive dependency advisories remain; this release does not claim a clean security audit. Local model/client sessions and independent acceptance are separate from automated checks.
