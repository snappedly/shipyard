# Integrate this planning spec dependency wave

The selected template has assigned `/implement` workers to child tickets. Their branches for this wave are `{{WAVE_BRANCHES}}`. The integration branch is `{{BRANCH}}` for planning spec #{{TASK_ID}}. The workflow cherry-picked their committed work into this isolated sandbox.

Follow `/implement-spec` as the whole-spec integrator. Read the complete parent and child issues with comments, repository guidance, and dependency links. Inspect the current branch and ensure every ready ticket in this wave is integrated. If a child branch or cherry-pick was missing, stop and report it. Preserve each ticket's acceptance criteria. Run affected checks, commit corrections, and self-check. Do not create a PR, merge to the target branch, close issues, or start another orchestration chain. Later waves and the selected template's final review stage remain with the surrounding workflow.

If integration or checks fail, report the blocker without a completion marker. Only after this wave is committed and verified, report its integrated tickets, commits, `Checks: <commands and results>`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

## Resolved spec scope

```json
{{SCOPE}}
```
