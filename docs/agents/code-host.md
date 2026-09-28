# Code host: GitHub

Repository: https://github.com/snappedly/shipyard. Work items live in GitHub Issues; see `docs/agents/issue-tracker.md`.

## Connection and operations

Use authenticated `gh` and Git with the `snappedly/shipyard` remote. The current connection has repository admin access.

- Branches: `git fetch origin`, `git push origin <branch>`, and `gh api repos/snappedly/shipyard/branches/<branch>`.
- Pull requests: `gh pr create --repo snappedly/shipyard --base staging --draft`, `gh pr view <number> --repo snappedly/shipyard --comments`, `gh pr diff <number> --repo snappedly/shipyard`, `gh pr edit <number> --repo snappedly/shipyard`, and `gh pr list --repo snappedly/shipyard`.
- Checks and review: `gh pr checks <number> --repo snappedly/shipyard` and `gh pr view <number> --repo snappedly/shipyard --json reviewDecision,statusCheckRollup,headRefOid`.
- Readiness: `gh pr ready <number> --repo snappedly/shipyard` after required review.
- Merge: a human uses `gh pr merge <number> --repo snappedly/shipyard --squash --delete-branch --match-head-commit <head-sha>` to merge task PRs to `staging` after the required checks and review. A human merges the promotion PR to `production` after staging verification. The release workflow merges its generated version PR after exact-head CI. See `docs/agents/workflow.md`.
- Links: use `Refs snappedly/shipyard#<issue>` in task PRs. Do not use an automatic closing keyword; issue closure follows the configured CI and acceptance events.

## Request surface

External PRs are not a triage request surface. An explicitly named PR can still be reviewed through the operations above. GitHub issues and PRs share a number space, so qualify ambiguous references.
