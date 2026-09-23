# Independent review of issue #{{TASK_ID}}

Review the complete scope on branch `{{BRANCH}}` against `{{TARGET_BRANCH}}`, the issue requirements, `AGENTS.md`, `docs/agents/workflow.md`, and `.shipyard/CODING_STANDARDS.md`. Follow `/code-review`. Inspect the exact diff, behavior tests, correctness and security; reuse valid worker checks. This explicit review stage must complete before the final integration stage.

Resolve authorized findings on this branch, run affected checks, and commit fixes. Do not close the issue, create a PR, merge to target, or start another orchestration chain. If required findings remain open or checks are missing, report them and omit approval.

Only when review permits handoff, report `Review: APPROVED`, its findings, dispositions, `Checks: <commands and results>` for changed checks, and limitations:

<handoff>...</handoff>
<review>APPROVED</review>
<promise>COMPLETE</promise>

For a planning spec, review the integrated parent and all scoped children together. Read all issue bodies and comments. Resolved scope:

```json
{{SCOPE}}
```
