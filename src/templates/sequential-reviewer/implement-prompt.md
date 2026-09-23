# Assigned issue scope

Implement scope #{{TASK_ID}} ({{ISSUE_TITLE}}) on branch `{{BRANCH}}`.
Read it with `gh issue view {{TASK_ID}} --comments`. Read `AGENTS.md`, `CONTEXT.md`, `docs/agents/workflow.md`, and relevant ADRs.

Follow {{SKILL}} in this sequential-reviewer workflow. For a planning spec, deliver only tickets in `SCOPE.tickets` in dependency order and integrate them on this one branch. Other linked tickets are context; do not implement them. Do not create separate child PRs. Use `/tdd` for changed logic and local `/code-cleanup`. Run required focused checks and typechecking, reinstalling candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit and self-check the implementation. The next stage owns independent `/code-review`; do not start another reviewer, orchestration chain, PR, merge, or issue closure.

If incomplete, report the blocker without a completion marker. After a verified commit, report scope, `Checks: <commands and results>`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

## Resolved scope

```json
{{SCOPE}}
```

Read the complete parent and child issue bodies and comments with `gh issue view`, including repository guidance and dependency links.
