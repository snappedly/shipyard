# TASK

Clean and validate the integrated candidate for delivery `{{DELIVERY_ID}}`.
Inspect the installed catalog at `~/.agents/skills` (shared by Codex and Claude Code). Read `/code-cleanup` from `code-cleanup/SKILL.md` and linked guidance. Use other installed skills when relevant. Apply cleanup to the complete diff from `{{BASE_SHA}}` to `{{HEAD_SHA}}`. Read the repository workflow contract and run its required integrated checks. If cleanup changes content, commit it on the integration branch. Return checks, final commit, and gaps to the host. Do not publish a pull request, merge, or close any issue.

## Integrated diff

!`git diff {{BASE_SHA}} {{HEAD_SHA}}`

Once complete, output <promise>COMPLETE</promise>.
