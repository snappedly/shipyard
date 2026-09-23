# Independent review of issue #{{TASK_ID}}

Review branch `{{BRANCH}}` against `{{TARGET_BRANCH}}`, the issue requirements, `AGENTS.md`, `docs/agents/workflow.md`, and `.shipyard/CODING_STANDARDS.md`. Follow `/code-review`. Inspect the exact diff, behavior tests, correctness and security; reuse valid worker checks. This explicit review stage must complete before the final integration stage.

Resolve authorized findings on this branch, run affected checks, and commit fixes. Do not close the issue, create a PR, merge to target, or start another orchestration chain. If required findings remain open or checks are missing, report them and omit approval.

Only when review permits handoff, report its findings, dispositions, check results, and limitations:

<handoff>...</handoff>
<review>APPROVED</review>
<promise>COMPLETE</promise>
