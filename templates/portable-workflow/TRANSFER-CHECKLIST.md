# Portable Agent Workflow Transfer Checklist

Use this checklist before declaring the workflow ready in a new repository.

## Files

- [ ] `AGENTS.md` describes the target project and its module map.
- [ ] `.project-context/project.yaml` has the target project name and timezone.
- [ ] Every module path in `project.yaml` exists.
- [ ] Every playbook path in `project.yaml` exists.
- [ ] Mandatory templates are copied or intentionally replaced.
- [ ] Optional hooks are disabled until at least one pilot task passes.
- [ ] No `CHANGE_ME`, old product names, or old repository paths remain.

## Foreign Memory

- [ ] No old `active/tasks` records were copied.
- [ ] No old `active/decisions` records were copied unless reviewed and still
      true for the target project.
- [ ] No old verification records, run summaries, backlog items, or draft inbox
      records were copied.
- [ ] No domain documents from the source project were copied by accident.
- [ ] No secrets, raw transcripts, full logs, personal dumps, or provider
      credentials are present.

## Commands

- [ ] Every verification command has `run`.
- [ ] Commands specify `required_for` modules.
- [ ] Long commands specify `timeout_seconds`.
- [ ] Commands declare `network`.
- [ ] Commands declare `writes_to`, even if the value is `[]`.
- [ ] Commands either run locally or are marked unavailable with a reason.
- [ ] CI equivalents are documented when they exist.

## Pilot

- [ ] A small docs/config task used the short Task Contract.
- [ ] A risky task route was tested with `task-contract.full.md` or equivalent.
- [ ] Context Pack listed the expected playbooks, files, and commands.
- [ ] Verification Record captured passed and skipped checks.
- [ ] Final response reported changed files, checks run, skipped checks, and
      residual risk.
