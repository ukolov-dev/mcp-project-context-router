# Contributing

Thanks for helping improve Project Context Router. The project is in active
development, so please open an issue before a large change to confirm the intended
contract and avoid duplicated work.

## Set up the repository

Project Context Router requires Node.js 22.13 or newer.

```bash
git clone https://github.com/ukolov-dev/mcp-project-context-router.git
cd mcp-project-context-router
npm ci
```

## Work on a change

1. Create a focused branch from `main`.
2. Validate the task and inspect the relevant context before implementation.
3. Keep runtime changes in `src/`, tests in `test/`, and consumer templates in
   `templates/`.
4. Add or update focused tests when behavior changes.
5. Do not commit credentials, consumer-project records, generated SQLite indexes,
   build output, tarballs, or `node_modules`.

Useful project workflow commands:

```bash
node bin/project-context validate-task "Describe the change" --mode feature
node bin/project-context pack "Describe the change" --workflow standard --explain
node bin/project-context reuse-scan "Describe the capability"
```

## Verify the change

Run the complete handoff suite before opening a pull request:

```bash
npm run build
npm test
npm run package:check
node bin/project-context doctor --json
```

Packaging changes also require installing the generated tarball in a temporary
consumer repository and exercising `init`, `index`, and `doctor` there.

## Open a pull request

Keep commits and the pull request scoped to one concern. In the description,
explain:

- what changed and why;
- user or developer impact;
- compatibility, data, or security implications;
- checks run and any checks intentionally skipped.

Generated `.project-context/drafts/` and `.project-context/indexes/` content is
local workflow state and must not be included in the pull request.

## Licensing note

The repository is currently marked `UNLICENSED`. Do not assume that public source
availability grants permission to reuse or redistribute the project. Discuss any
licensing-dependent contribution with the maintainer first.
