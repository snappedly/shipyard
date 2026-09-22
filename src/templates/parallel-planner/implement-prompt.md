# TASK

Implement the assigned child `{{TASK_ID}}` (`{{ISSUE_TITLE}}`) inside delivery
group `{{DELIVERY_ID}}`.

Pull in the issue using `{{VIEW_TASK_COMMAND}}`. If it has a parent PRD, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run tests. The parent delivery
coordinator owns integration into the `{{INTEGRATION_BRANCH}}` candidate.

# CONTEXT

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS

Before committing, read the repository's configured feedback-loop contract and run every applicable check for this change. Use the configured static check and focused behavior tests when they exist; include formatting, build, or broader checks when the contract or change requires them. Fix failures before committing.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not publish a branch or pull request, merge, close the issue, or start
another delivery. Return only the child commit and verification evidence to
the coordinator.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
