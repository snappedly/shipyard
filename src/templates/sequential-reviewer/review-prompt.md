# Independent review of issue #{{TASK_ID}}

Review branch `{{BRANCH}}` against `{{TARGET_BRANCH}}`, the issue requirements, repository policy, and standards in `.shipyard/CODING_STANDARDS.md`. Follow `/code-review`. Inspect the exact diff, tests, security and correctness; use existing check evidence where valid. This template deliberately has a separate reviewer stage.

Resolve findings on this branch when authorized, run affected checks, and commit fixes. Do not close the issue, create a PR, merge to the target, or start another review chain. If any required finding remains open or checks are missing, report it and omit approval.

Only when review permits handoff, summarize the axis result, findings and dispositions, changed checks, and limitations:

<handoff>...</handoff>
<review>APPROVED</review>
<promise>COMPLETE</promise>
