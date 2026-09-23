# TASK

Repair the reviewed candidate for `{{REVIEW_SCOPE}}` in delivery
`{{DELIVERY_ID}}`. This is the single bounded fix batch. Work only on the
reported findings and their direct consequences.

Inspect the installed catalog at `~/.agents/skills` (shared by Codex and Claude Code).
Read `/implement` from `implement/SKILL.md`, `/tdd` for changed behavior, and
`/code-cleanup` before committing. Read linked guidance and use other installed
skills when relevant. The coordinator owns follow-up `/code-review` and delivery.

## Findings

{{FINDINGS}}

Read issue #{{TASK_ID}} and the relevant spec context. Inspect the current
candidate, make the fixes, run affected repository checks, and commit the
result. Report the commit and verification evidence. Do not publish a pull
request, merge, close an issue, or start another review.

Once complete, output <promise>COMPLETE</promise>.
