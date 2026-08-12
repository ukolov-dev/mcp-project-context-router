# Portable Agent Workflow Bootstrap

Use this file when copying the PPM context workflow into a new repository. The
goal is a small, reviewable day-1 setup, not full automation.

## Day-1 Route

1. Copy the mandatory files into the target repository.
2. Fill `.project-context/project.yaml` with the real project name, modules,
   playbooks, and verification commands.
3. Delete modules, commands, and playbooks that do not exist in the target
   project.
4. Rewrite `AGENTS.md` so it describes the target repository, not PPM.
5. Rewrite one or two focused playbooks for the highest-traffic modules.
6. Replace every `CHANGE_ME` marker.
7. Run YAML/JSON/frontmatter validation or the closest available lint command.
8. Run one small pilot task manually using Task Contract -> Context Pack ->
   implementation -> Verification Record.
9. Enable hooks only after the pilot task proves the workflow fits the project.

## Mandatory Day 1

- `AGENTS.md`
- `.project-context/project.yaml`
- `.project-context/README.md`
- `playbooks/testing.md`
- At least one module playbook
- `task-contract.md` or `task-contract.full.md`
- `verification-record.md`
- `SOURCE_OF_TRUTH.md`
- `TRANSFER-CHECKLIST.md`

## Optional Later

- Codex hooks
- Strict JSON schema validation
- Context-pack automation
- Extra module playbooks
- Backlog automation
- Source archive importers
- Draft promotion automation

## Pilot Task Rule

Run the first task by hand. If the agent cannot answer these questions without
guessing, keep the workflow in bootstrap mode:

- Which module is in scope?
- Which playbooks apply?
- Which source-of-truth document wins during a conflict?
- Which checks are required and which are best-effort?
- What behavior is protected from change?
- What will the final response report?

## Dirty Worktree Rule

Agents must inspect the working tree before edits, preserve unrelated user
changes, and never revert files they did not intentionally change. If an
unrelated dirty file blocks the task, stop and ask for direction instead of
cleaning it silently.
