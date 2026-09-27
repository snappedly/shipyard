# Independent review of issue #{{TASK_ID}}

Review the complete scope on branch `{{BRANCH}}` against `{{BASE_BRANCH}}`, the issue requirements, repository policy, and `.shipyard/CODING_STANDARDS.md`. Follow `/code-review`. Inspect the exact diff, correctness, security, and relevant tests. For small, low-risk changes, complete the review in this agent; start separate review axes only when repository policy or change risk requires them. Use the implementation evidence below when it applies to the reviewed commit. Run checks only when the evidence is missing, stale, or a finding needs verification. For a standalone issue, approved review goes directly to PR handoff.

Resolve authorized findings on this branch, run affected checks, and commit fixes. Do not close the issue, create a PR, merge to target, or start another orchestration chain. If required findings remain open or checks are missing, report them and omit approval.

Only when review permits handoff, report `Review: APPROVED`, its findings, dispositions, `Checks: <commands and results>` for changed checks, and limitations:

<handoff>...</handoff>
<review>APPROVED</review>
<promise>COMPLETE</promise>

For a planning spec, review the integrated parent and all scoped children together. Read all issue bodies and comments. Resolved scope:

```json
{{SCOPE}}
```

## Implementation evidence

{{IMPLEMENTATION_EVIDENCE}}
