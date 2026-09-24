# Final integration for scope #{{TASK_ID}}: {{ISSUE_TITLE}}

On branch `{{BRANCH}}`, inspect the issue and final diff from `{{BASE_BRANCH}}`. Follow `/code-cleanup` on the complete integrated change, including a planning spec and all scoped tickets. The selected template has already run an independent `/code-review`; perform final integration checks and preserve its result when content is unchanged. Reinstall candidate dependencies with `bash .shipyard/setup.sh` after manifest changes. Commit any authorized correction and report its affected checks. The surrounding workflow repeats `/code-review` when this stage makes commits.

Do not close the issue, merge into the target, publish the PR, or start another review chain. If checks remain unresolved, explain why without completion. After verified final content, report `Checks: <commands and results>`, the prior `Review: APPROVED` result, and limitations:

<handoff>...</handoff>
<promise>COMPLETE</promise>

For a planning spec, follow `/implement-spec` for whole-spec integration, cleanup, and final checks on the one spec branch. Read parent and all scoped child bodies and comments, inspect dependency order and merged commits, and resolve gaps before completion. Never merge the target branch or close issues.

```json
{{SCOPE}}
```
