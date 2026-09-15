# Task execution and acceptance review

Execution records connect a confirmed Task Contract to a specific code snapshot,
verification results, and a separate review. They use the existing
`.project-context` storage and work in the current Git checkout, including an
existing Git worktree.

## Lifecycle

```text
confirmed → implementing → verifying → reviewing → ready_to_merge
     └──────────┴────────────┴───────────┴────────→ failed
```

Each attempt has its own ID, task digest, base commit, branch/worktree identity,
executor, attempt number, timestamps, and transition history. The Task Contract
remains the specification; execution states belong to attempts. A retry creates a
new attempt so the previous failure and its evidence remain inspectable.

To enter `reviewing`, the run needs successful evidence for every required check.
To enter `ready_to_merge`, it also needs a passing acceptance review covering
every criterion, with no findings and a reviewer identity different from the
executor. Evidence and reviews must match the task and code digests. Changing the
contract, verification plan, or source invalidates earlier evidence for later
transitions.

`ready_to_merge` records a successful gate at that point in time. It does not
merge a branch or grant deployment approval. Review any subsequent changes before
merging.

## Run through an external adapter

Create a confirmed Task Contract using `validate-task` and `confirm-task` as in
the existing workflow. Put the adapter configuration inside the consumer
repository, for example `execution-adapter.json`:

```json
{
  "executor": "implementation-session",
  "reviewer": "review-session",
  "implementation": {
    "command": "node",
    "args": ["scripts/implement-task.mjs"]
  },
  "review": {
    "command": "node",
    "args": ["scripts/review-task.mjs"]
  },
  "timeoutMs": 300000
}
```

The two scripts are integration points supplied by your project. They may call
your chosen coding agent. The router does not require a particular model or
install an agent client.

Inspect the plan, then execute it:

```bash
project-context run TASK-ID --adapter execution-adapter.json --json
project-context run TASK-ID --adapter execution-adapter.json --execute --json
```

The default command only validates and returns a plan. It creates no run and
starts no implementation, check, or reviewer process. `--execute` starts the
external implementation, runs the contract's verification commands, requests a
separate acceptance review, and applies the gated transitions. A failure produces
a nonzero CLI exit status and a failed run where a run has already been created.

Implementation and review commands receive JSON on stdin. The implementation
receives the task context and run details. The reviewer receives the acceptance
bundle with criteria, diff, snapshot identifiers, and verification records. The
review process must write one JSON object to stdout; send diagnostic messages to
stderr:

```json
{
  "verdict": "passed",
  "criteria": [
    {
      "criterionId": "AC-1",
      "status": "passed",
      "implementationEvidence": "src/search.ts handles an unknown email with an empty list",
      "verificationEvidence": "VERIFY-ID: the unknown-email regression test passed"
    }
  ],
  "findings": []
}
```

Use the real criterion and verification IDs from the bundle. The adapter fills
run, reviewer and digest provenance from the bundle it sent. A PASS requires
every criterion exactly once and concrete implementation and verification
descriptions. To reject the implementation, return `"verdict": "failed"` with
failed criteria and findings.

The automatic adapter sends up to 200,000 diff characters. If the complete diff
does not fit, execution fails before invoking the reviewer. Review that change
manually with access to the full repository diff, or split the task. The manual
bundle API exposes truncation explicitly and supports a configurable limit.

Commands use explicit executable/argument arrays. Verification commands are
shell commands from the confirmed task and project configuration; executing them
requires trusting that repository configuration. Processes have time and output
bounds. Configure the external reviewer with its client's read-only permissions.
The router checks that code did not change during review, but does not provide an
operating-system sandbox for arbitrary adapter executables. Distinct reviewer
identities are declarations, not authenticated identities.

## Drive each step through CLI or MCP

Execution MCP tools are available in the `developer`, `admin`, and `full`
profiles. The default `core` surface stays compact. MCP manages records and
reads Git snapshots; it does not execute the external adapter or test commands.

| CLI command | MCP tool | Purpose |
| --- | --- | --- |
| `create-agent-run TASK-ID --executor SESSION` | `create_agent_run` | Create an attempt |
| `agent-run RUN-ID` | `get_agent_run` | Inspect the manifest |
| `agent-runs [TASK-ID]` | `list_agent_runs` | Inspect attempts |
| `agent-run-snapshot RUN-ID` | `get_agent_run_snapshot` | Capture digests and diff |
| `transition-agent-run RUN-ID STATUS --input transition.json` | `transition_agent_run` | Apply a gated transition |
| `record-run-verification --input evidence.json` | `record_run_verification` | Record checks for the exact run |
| `acceptance-review-bundle RUN-ID` | `build_acceptance_review_bundle` | Prepare independent review |
| `record-acceptance-review --input review.json` | `record_acceptance_review` | Validate and store a verdict |
| `acceptance-review REVIEW-ID` | `get_acceptance_review` | Inspect a verdict |

For manual verification, capture the code digest **before** executing checks.
Pass it as `expectedCodeDigest` to `record_run_verification`, together with
`runId`, `summary`, and `checks` entries containing `command` and `status`.
The ordinary `record_verification_evidence` tool remains available for existing
workflows; an unbound historical record cannot satisfy an execution gate.

Keep CLI input payloads in the ignored `.project-context/drafts/` directory,
for example `--input .project-context/drafts/evidence.json`. Creating an input
file among source files after capturing the digest is itself a source change
and will correctly make that digest stale.

Supply `evidenceIds` when transitioning to `reviewing`, then `reviewId` when
transitioning to `ready_to_merge`. Use `expectedRevision` to reject a transition
based on an outdated manifest. A transition to `failed` needs a reason.

## Files and portability

```text
.project-context/active/
├── tasks/TASK-….md
├── agent-runs/AGENT-RUN-….md
├── verification/VERIFY-….md
└── acceptance-reviews/ACCEPT-….md
```

Records use Markdown with structured YAML frontmatter. Repository-relative
paths keep them portable. Generated context caches live in ignored indexes;
the short-lived `.project-context/active/agent-runs/.execution.lock` serializes
record writes and is also ignored. If a writer crashes, check the PID in that
file and remove only the stale lock once that writer has stopped. Ordinary
context packs hide execution history by default; request
history explicitly when investigating an earlier run.

The code snapshot includes the base-to-current diff and local staged, unstaged,
and untracked source changes. Generated context records do not invalidate their
own verification. Source and verification configuration changes do. Existing
Git ignores still define which untracked files are eligible; configure them for
build outputs and local secrets. A truncated or redacted review bundle must be
handled explicitly rather than treated as proof that omitted content is correct.

Local evidence is an auditable report, not cryptographic proof of execution or
an authentication boundary. Protect the repository and configure the runner's
permissions according to the environment where it runs.

This version rejects repositories containing Git submodules because it cannot
attest to source changes inside them. It also rejects source files marked
`assume-unchanged` or `skip-worktree` in the Git index: those flags can hide
modifications from the reviewed diff. Record lookup and attempt numbering use
active execution records; keep those records active while working with a task.
