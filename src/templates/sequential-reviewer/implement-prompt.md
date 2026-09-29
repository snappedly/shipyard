# Assigned issue scope

Implement scope #{{TASK_ID}} ({{ISSUE_TITLE}}) on branch `{{BRANCH}}`.
Read it with `gh issue view {{TASK_ID}} --comments` and follow `AGENTS.md`. Use the resolved scope below for relationships. Read linked guidance, `CONTEXT.md`, and ADRs when relevant to the change; inspect affected files and nearby tests.

Use {{SKILL}} if it appears in the provided skill catalog; otherwise follow this prompt and repository policy. For a planning spec, deliver only tickets in `SCOPE.tickets` in dependency order and integrate them on this one branch. Read parent or sibling details only when a selected ticket needs them. Other linked tickets are context; do not implement them. Do not create separate child PRs.

Use `/tdd` for changed logic and local `/code-cleanup`. For presentation-only changes, inspect the affected UI at representative viewports with an available preview. Install browser or system dependencies only when required by acceptance criteria or repository policy. Run the repository's required checks plus focused checks for changed behavior; stop when those checks pass. Reinstall candidate dependencies with `bash .shipyard-v1/setup.sh` after manifest changes. Commit and self-check the implementation. The next stage owns independent `/code-review`; do not start another reviewer, orchestration chain, PR, merge, or issue closure.

If incomplete, report the blocker without a completion marker. After a verified commit, report scope, `Checks: <commands and results>`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

## Resolved scope

```json
{{SCOPE}}
```
