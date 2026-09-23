# Assigned standalone issue #{{TASK_ID}}: {{ISSUE_TITLE}}

Work only on branch `{{BRANCH}}`. Read `gh issue view {{TASK_ID}} --comments`, `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, and relevant ADRs.

Follow `/implement` as a ticket worker assigned by the existing parallel planner. Use `/tdd` for changed logic and local `/code-cleanup`; run focused tests, typechecking, and scoped formatting. Reinstall dependencies for the candidate with `bash .shipyard/setup.sh` after manifest changes. Commit and self-check. Return to the planner workflow: do not launch `/implement-spec`, another orchestration or review chain, merge, create a PR, or close this issue. The selected template's later stages own those steps.

If incomplete, explain the blocker without a completion marker. Once the ticket has a verified commit, give scope, exact checks/results and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>
