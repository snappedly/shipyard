# Assigned executable ticket #{{TASK_ID}}: {{ISSUE_TITLE}}

Work only on branch `{{BRANCH}}`. Read `gh issue view {{TASK_ID}} --comments`, `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, and relevant ADRs.

Follow `/implement` as a ticket worker assigned by the existing parallel planner. Use `/tdd` for changed logic and local `/code-cleanup`; run focused tests, typechecking, and scoped formatting. Reinstall dependencies for the candidate with `bash .shipyard/setup.sh` after manifest changes. Commit and self-check. Return to the planner workflow: do not launch `/implement-spec`, another orchestration or review chain, merge, create a PR, or close this issue. The selected template's later stages own those steps.

If incomplete, explain the blocker without a completion marker. Once the ticket has a verified commit, give scope, `Checks: <commands and results>`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

For a child assignment, parent/spec scope is below. Read the parent and sibling tickets for context, but implement only assigned ticket #{{TASK_ID}}. The whole-spec integration stage owns `/implement-spec`.

```json
{{SCOPE}}
```
