# Resolve a spec ticket integration conflict

Ticket #{{TASK_ID}} has a cherry-pick conflict while integrating commits `{{COMMITS}}` into spec branch `{{BRANCH}}`.

Follow `/implement-spec` as the assigned integrator. Read the parent and every scoped ticket, inspect `git status` and the conflicted files, and resolve the conflict while preserving both the ticket's requirements and changes already integrated into the spec branch. Continue the cherry-pick; do not abort or skip the ticket. If the cherry-pick includes multiple commits, continue until the sequence finishes. Run affected checks, commit the resolution, and leave the worktree clean. The selected workflow will then run its normal whole-spec integration and review stages.

The Git failure was:

```text
{{CONFLICT}}
```

If the conflict cannot be resolved or checked, explain why and stop without a completion marker. After resolution, report `Checks: <commands and results>` and the integrated ticket:

<handoff>...</handoff>
<promise>COMPLETE</promise>

## Resolved spec scope

```json
{{SCOPE}}
```
