# Issue tracker: GitHub

Work items and approved executable specs live at https://github.com/snappedly/shipyard-v1/issues. Use authenticated `gh` with `--repo snappedly/shipyard-v1` for every issue command. The current connection can read issues and has repository admin permission to create and update them. Code-host operations live in `docs/agents/code-host.md`. Planning notes, domain context, and ADRs remain in repository documentation.

## Conventions

- Create: `gh issue create --repo snappedly/shipyard-v1 --title "..." --body "..."`.
- Read: `gh issue view <number> --repo snappedly/shipyard-v1 --comments`.
- List: `gh issue list --repo snappedly/shipyard-v1 --state open --json number,title,body,labels,comments`.
- Comment: `gh issue comment <number> --repo snappedly/shipyard-v1 --body "..."`.
- Edit: `gh issue edit <number> --repo snappedly/shipyard-v1 --title "..." --body "..."`.
- Apply or remove a label: `gh issue edit <number> --repo snappedly/shipyard-v1 --add-label "..."` or `--remove-label "..."`.
- Close after the event in `docs/agents/workflow.md`: `gh issue close <number> --repo snappedly/shipyard-v1 --comment "..."`.

Before publishing, verify the destination with a known issue, such as `gh issue view 73 --repo snappedly/shipyard-v1`. Issue identifiers are `snappedly/shipyard-v1#<number>` or issue URLs. Qualify bare numbers when a PR could be meant.

Triage states use `docs/agents/triage-labels.md`. Apply one of `bug` or `enhancement` to each executable issue with the label command above. A planning spec is a parent issue; executable tickets are its sub-issues. Only executable tickets receive `ready-for-agent`.

## When a skill publishes work

Create a GitHub issue unless the calling skill says to update an existing issue.

## When a skill fetches work

Run the scoped issue view command above. Fetch PRs through `docs/agents/code-host.md`.

## Blocking relationships

Use GitHub's native sub-issues and dependencies. Read children with `gh api repos/snappedly/shipyard-v1/issues/<parent>/sub_issues` and a child's parent with `gh api repos/snappedly/shipyard-v1/issues/<child>/parent`. Add a child with `gh api --method POST repos/snappedly/shipyard-v1/issues/<parent>/sub_issues -F sub_issue_id=<child-database-id>`. Read blockers with `gh api repos/snappedly/shipyard-v1/issues/<blocked>/dependencies/blocked_by`; add one with `gh api --method POST repos/snappedly/shipyard-v1/issues/<blocked>/dependencies/blocked_by -F issue_id=<blocker-database-id>`. Obtain database IDs with `gh api repos/snappedly/shipyard-v1/issues/<number> --jq .id`. If an API operation is unavailable, put `Parent: snappedly/shipyard-v1#<number>` or `Blocked by: snappedly/shipyard-v1#<number>` in the issue body.
