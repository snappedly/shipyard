# Assigned standalone issue

Implement issue #{{TASK_ID}} ({{ISSUE_TITLE}}) on branch `{{BRANCH}}`.
Read it with `gh issue view {{TASK_ID}} --comments`, including acceptance criteria, and read `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, and relevant ADRs. This issue has already been checked for planning-spec or linked-child scope by the selector.

Follow the installed `/implement` skill as the standalone implementer. Use `/tdd` for changed logic, then `/code-cleanup` and `/code-review` as the skill and repository policy require. Run candidate dependency installation again after changing manifests: `bash .shipyard/setup.sh`. Complete the required checks, resolve review findings, and commit all task work. Do not close the issue, merge into the target branch, or publish the PR; the surrounding workflow handles handoff.

If requirements, checks, or review are unresolved, describe the blocker and stop without the completion marker. Only after the verified commit, finish with a concise evidence packet containing changed scope, exact check commands and results, review outcome, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>
