# Read-only candidate review

Review issue #{{TASK_ID}} — {{ISSUE_TITLE}} on branch `{{BRANCH}}`.

Inspect exactly base `{{BASE_SHA}}` and head `{{HEAD_SHA}}`. Run
`git diff {{BASE_SHA}} {{HEAD_SHA}}` and
`git log {{BASE_SHA}}..{{HEAD_SHA}} --oneline`. Read
`~/.agents/skills/code-review/SKILL.md`, `.shipyard/CODING_STANDARDS.md`, and
the relevant repository guidance. Review correctness, acceptance criteria,
security, and interface compatibility.

Do not edit files, create commits, publish, merge, close issues, or run GitHub
commands. Return review findings and evidence for the coordinator; do not
attempt repairs.

Return a JSON object in `<review-report>` with this shape:

```json
{
  "outcome": "passed",
  "axes": ["standards", "spec", "interface"],
  "findings": [],
  "evidence": ["Inspected the exact base and head revisions."]
}
```

The host requires `<promise>COMPLETE</promise>` with the structured review
report before it records review completion.
