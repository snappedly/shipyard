# Final integration for scope #{{TASK_ID}}: {{ISSUE_TITLE}}

On branch `{{BRANCH}}`, inspect its complete diff from `{{TARGET_BRANCH}}` and the source issue. This is the planner's final integration stage and ends in one PR for this scope. Follow `/code-cleanup` and local `/code-review` appropriate to the issue, using the worker's existing valid check evidence. Run required integrated checks and reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Resolve findings, commit corrections and inspect the final branch.

Do not close the issue, merge into the target, or publish the PR. If checks or review remain unresolved, explain why without completion. After a verified final commit, report `Checks: <commands and results>`, `Review: APPROVED`, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

For a planning spec, follow `/implement-spec` for whole-spec integration, cleanup, and final checks on the one spec branch. Read parent and all scoped child bodies and comments, inspect dependency order and merged commits, and resolve gaps before completion. Run `/code-review` here when this template has no separate reviewer stage. Never merge the target branch or close issues.

```json
{{SCOPE}}
```
