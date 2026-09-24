Review the high-risk triage of GitHub issue #{{TASK_ID}} before implementation.

Read the issue, comments, current triage notes, repository guidance, and relevant code. This request touches credentials, permissions, security boundaries, data integrity, or migrations. Use the strong model to decide whether the existing requirements and authorization are clear enough for unattended implementation. Apply `ready-for-agent` only when the scope and safeguards are explicit and no maintainer decision is needed. Otherwise retain `needs-triage` and state the exact question. Do not implement or start a PR.

Report the evidence and applied state. Shipyard will re-read the labels and proceed only if the issue has `shipyard` and the sole triage state `ready-for-agent`.
