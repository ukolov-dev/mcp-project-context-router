# Source Of Truth Map

Fill this file during transfer. Keep it short enough for agents to read before
work starts.

## Product And Domain

- Product contract: `CHANGE_ME`
- Domain rules: `CHANGE_ME`
- Acceptance criteria: `CHANGE_ME`

## Architecture

- Architecture overview: `CHANGE_ME`
- Module boundaries: `CHANGE_ME`
- API contracts: `CHANGE_ME`
- Data model and migrations: `CHANGE_ME`
- Auth, access, and security rules: `CHANGE_ME`

## Delivery

- Deployment runbook: `CHANGE_ME`
- Environment setup: `CHANGE_ME`
- Release process: `CHANGE_ME`
- Rollback process: `CHANGE_ME`

## Verification

- Testing playbook: `playbooks/testing.md`
- Backend checks: `CHANGE_ME`
- Frontend checks: `CHANGE_ME`
- Infra checks: `CHANGE_ME`
- Manual smoke checks: `CHANGE_ME`

## Conflict Rule

When two sources disagree, prefer the newest reviewed task contract or decision,
then the active product contract, then code behavior verified by tests. Create an
open question instead of guessing when the conflict affects API, data, security,
workflow, or acceptance criteria.
