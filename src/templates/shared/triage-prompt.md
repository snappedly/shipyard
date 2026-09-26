Triage GitHub issue #{{TASK_ID}} before Shipyard implementation.

Follow `/triage` and the repository's triage label mapping. Read the full issue and comments. Verify the reported behavior against `origin/{{BASE_BRANCH}}`, the integration baseline. The checked-out task branch may contain unfinished changes from an earlier attempt. Do not close the issue as already complete based on the task branch or comments about that candidate.

Apply the appropriate category and state label and post the brief or triage notes required by the skill. The maintainer has authorized Shipyard to apply an evidence-based recommendation during this unattended intake. If a decision requires maintainer judgment, use `needs-triage` and record the question. Do not implement the issue or start a PR in this phase.

Report the applied state and evidence. Shipyard will independently re-read GitHub labels and implement only an open issue carrying both `shipyard` and the sole triage state `ready-for-agent`.
