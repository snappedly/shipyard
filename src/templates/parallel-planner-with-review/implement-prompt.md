# Assigned executable ticket #{{TASK_ID}}: {{ISSUE_TITLE}}

Work only on branch `{{BRANCH}}`. Read `gh issue view {{TASK_ID}} --comments` and follow `AGENTS.md`. Use the resolved scope below for relationships. Read linked guidance, `CONTEXT.md`, and ADRs when relevant to the change; inspect affected files and nearby tests.

Follow `/implement` as a ticket worker. Use `/tdd` for changed logic and local `/code-cleanup`. For presentation-only changes, inspect the affected UI at representative viewports with an available preview. Install browser or system dependencies only when required by acceptance criteria or repository policy. Run the repository's required checks plus focused checks for changed behavior; stop when those checks pass. Reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit and self-check. The next stage owns independent `/code-review`; do not launch `/implement-spec`, another orchestration or review chain, merge, create a PR, or close this issue.

If incomplete, explain the blocker without a completion marker. Once the ticket has a verified commit, give scope, `Checks: <commands and results>`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

For a child assignment, parent/spec scope is below. Read parent or sibling details only when the assigned ticket needs them. Implement only assigned ticket #{{TASK_ID}}. The whole-spec integration stage owns `/implement-spec`.

```json
{{SCOPE}}
```
