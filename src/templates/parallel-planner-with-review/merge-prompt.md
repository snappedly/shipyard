# Final integration for scope #{{TASK_ID}}: {{ISSUE_TITLE}}

On branch `{{BRANCH}}`, inspect the issue and final diff from `{{TARGET_BRANCH}}`. The selected template has already run an independent `/code-review`; preserve its result and perform only final integration cleanup and checks needed after those changes. Reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit any authorized correction, report its affected checks and preserve the existing review evidence when unchanged.

Do not close the issue, merge into the target, publish the PR, or start another review chain. If checks remain unresolved, explain why without completion. After verified final content, report `Checks: <commands and results>`, the prior `Review: APPROVED` result, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

For a planning spec, follow `/implement-spec` for whole-spec integration, cleanup, and final checks on the one spec branch. Read parent and all scoped child bodies and comments, inspect dependency order and merged commits, and resolve gaps before completion. If final corrections change reviewed content, repeat `/code-review` and record a new approval before completion. Never merge the target branch or close issues.

```json
{{SCOPE}}
```
