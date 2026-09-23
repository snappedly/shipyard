# Assigned standalone issue

Implement issue #{{TASK_ID}} ({{ISSUE_TITLE}}) on branch `{{BRANCH}}`.
Read it with `gh issue view {{TASK_ID}} --comments`. Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, and relevant ADRs.

Follow `/implement` as an assigned worker in this sequential-reviewer workflow. Use `/tdd` for changed logic and local `/code-cleanup`. Run required focused checks and typechecking, reinstalling candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit and self-check the implementation. The next stage owns independent `/code-review`; do not start another reviewer, orchestration chain, PR, merge, or issue closure.

If incomplete, report the blocker without a completion marker. After a verified commit, report scope, commands/results, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>
