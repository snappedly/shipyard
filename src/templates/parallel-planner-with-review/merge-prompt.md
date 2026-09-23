# Final validation for issue #{{TASK_ID}}: {{ISSUE_TITLE}}

On branch `{{BRANCH}}`, inspect the issue and final diff from `{{TARGET_BRANCH}}`. The selected template has already run an independent `/code-review`; preserve its result and perform only final integration cleanup and checks needed after those changes. Reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit any authorized correction, report its affected checks and preserve the existing review evidence when unchanged.

Do not close the issue, merge into the target, publish the PR, or start another review chain. If checks remain unresolved, explain why without completion. After verified final content, report commands/results and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>
