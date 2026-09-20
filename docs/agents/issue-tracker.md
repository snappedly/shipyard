# Issue tracker: GitHub

Work items and approved executable specs for `snappedly/shipyard` live in GitHub Issues. Use the `gh` CLI for tracker operations. Planning notes, domain context, and ADRs remain in repository documentation.

## Conventions

- Create an issue with `gh issue create --title "..." --body "..."`.
- Read an issue with `gh issue view <number> --comments`, including labels when needed.
- List issues with `gh issue list --state open --json number,title,body,labels,comments` and filter by the labels and states the calling skill needs.
- Comment with `gh issue comment <number> --body "..."`.
- Apply or remove labels with `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close with `gh issue close <number> --comment "..."`.

Infer the repository from `git remote -v`; `gh` uses the current clone automatically.

## Pull requests as a request surface

**PRs as a request surface: no.** External PRs are not included in triage request discovery. Maintainer-owned PRs remain part of implementation and review workflows.

GitHub shares one number space across issues and PRs. Resolve a bare `#42` with `gh pr view 42` and fall back to `gh issue view 42` when the calling workflow permits either surface.

## When a skill publishes work

Create a GitHub issue unless the calling skill says to update an existing issue.

## When a skill fetches work

Run `gh issue view <number> --comments` for an issue reference. Fetch a PR with `gh pr view <number> --comments` and `gh pr diff <number>` when PR work is in scope.

## Blocking relationships

When the workflow supports parent and child work, prefer GitHub's native sub-issue and issue-dependency relationships. If unavailable, record the parent or blocker in the issue body using the convention named by the calling skill.
