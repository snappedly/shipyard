Triage GitHub issue #{{TASK_ID}} before Shipyard implementation.

Follow `/triage` and the repository's `docs/agents/triage.md` label mapping. Read the full issue and comments, verify its claim against the codebase, then apply the appropriate category and state label and post the brief or triage notes required by the skill. The maintainer has authorized Shipyard to apply an evidence-based recommendation during this unattended intake. If a decision requires maintainer judgment, use `needs-triage` and record the question. Do not implement the issue or start a PR in this phase.

This pass uses the routine model. If the request changes credentials, permissions, security boundaries, data integrity, or migrations, leave it in `needs-triage` and end with `<risk>strong-review</risk>`. A strong-model triage pass will assess whether the stated requirements are clear enough for implementation. If the evidence conflicts, the scope is unclear, or a decision requires maintainer judgment, leave it in `needs-triage` and state the question. Do not guess an authorization or mark those cases ready for implementation.

Report the applied state and evidence. Shipyard will independently re-read GitHub labels and implement only an open issue carrying both `shipyard` and the sole triage state `ready-for-agent`.
