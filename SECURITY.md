# Security policy

## Supported versions

Project Context Router is in active development. Security fixes are applied to the
latest code on `main`; older versions are not currently maintained as separate
release lines.

## Report a vulnerability

Do not open a public issue containing exploit details, credentials, private project
records, or other sensitive information.

Use GitHub's private vulnerability reporting flow:

<https://github.com/ukolov-dev/mcp-context/security/advisories/new>

Include the affected version or commit, impact, reproduction steps, and any
suggested mitigation. If private reporting is unavailable, contact the repository
owner through their GitHub profile before sharing sensitive details.

You can expect an acknowledgement when the report has been reviewed. Remediation
timing depends on severity and the complexity of a compatible fix. Please allow a
reasonable remediation window before public disclosure.

## Scope

Reports are especially useful when they involve:

- repository-boundary or symlink-escape bypasses;
- secret leakage through excerpts, logs, context packs, or package artifacts;
- unsafe credential storage or optional network integrations;
- unintended writes, destructive lifecycle transitions, or authorization bypasses;
- command execution or path traversal in CLI, hook, or MCP inputs.

Do not include real third-party credentials or private consumer-project data in a
proof of concept. Use synthetic fixtures in a temporary repository.
