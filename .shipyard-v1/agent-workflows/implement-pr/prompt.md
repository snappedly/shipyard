# TASK

Address unresolved review feedback on PR #{{PR_NUMBER}} on branch `{{BRANCH}}`.

PR title: {{PR_TITLE}}
Linked issue: #{{ISSUE_NUMBER}} {{ISSUE_TITLE}}

This is not a fresh review. Focus on the PR conversation and unresolved feedback.

# LINKED ISSUE

{{LINKED_ISSUE}}

# CURRENT DIFF TO STAGING

```diff
{{DIFF_TO_MAIN}}
```

# PR COMMENTS

```json
{{PR_COMMENTS_JSON}}
```

# PROCESS

For each actionable comment or unresolved thread:

- Change code when the reviewer is right.
- Reply when a reply adds useful context.
- Decline clearly when the requested change is wrong or out of scope.
- Ignore stale/context-only comments.

Before committing, read the repository's configured feedback-loop contract and run every applicable check for this change. Use the configured static check and focused behavior tests when they exist; include formatting, build, or broader checks when the contract or change requires them. Fix failures before committing.

If you change code, commit with a conventional commit message.

Do not push.
Do not edit labels.
Do not resolve review threads.
Do not create GitHub comments yourself.

When complete, output `<promise>COMPLETE</promise>`.
