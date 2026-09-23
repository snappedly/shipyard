# Final validation for issue #{{TASK_ID}}: {{ISSUE_TITLE}}

On branch `{{BRANCH}}`, inspect its complete diff from `{{TARGET_BRANCH}}` and the source issue. This is the existing planner's final integration stage, now ending in one PR per standalone issue instead of merging into the target branch. Follow `/code-cleanup` and local `/code-review` appropriate to the issue, using the worker's existing valid check evidence. Run required integrated checks and reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Resolve findings, commit corrections and inspect the final branch.

Do not close the issue, merge into the target, or publish the PR. If checks or review remain unresolved, explain why without completion. After a verified final commit, report checks, review outcome and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>
