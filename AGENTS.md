Shipyard is an independent Snappedly project. See `docs/plans/shipyard-automation.md` for the planned workflow.

Use `npm run check` for the repository feedback loop. It runs formatting, typechecking, and tests. Use `npm run build` when package output changes.

Check [./CONTEXT.md](./CONTEXT.md) for terminology questions.

For user-facing changes, add a changeset to `.changeset`. Check all changesets there first to see if there are duplicates. We use `@changesets/cli`, but you can create/edit the file manually. Make all bugfixes `patch`, all new features or breaking changes `minor` (since we're pre-1.0). Use `package.json#name` for the name.

When changing public-facing behavior, check `README.md` to see if the documentation needs updating.

## Reporting

When reporting information to me, be extremely concise, sacrificing grammar for concision.

# Tool Context Guide

## IMPORTANT: System Rules Injection

Always read and strictly adhere to the rules, tech stack details, and coding standards defined in the root folder file:
[AGENTS.md](./AGENTS.md)

Before executing any development tasks, internalize the constraints inside `./AGENTS.md`. It serves as the primary source of truth for this codebase. The instructions below only supplement it.

## Tool-Specific Overrides

- Run tests using the tool's native execution environment when available.

## Agent skills

### Work tracker

GitHub Issues in `snappedly/shipyard`, operated with `gh`; PRs are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Team workflow

Small clear changes use focused verification and local review; planned work uses issue-backed implementation, cleanup, review, and PR delivery to `staging`; future releases require human approval of the exact `production` candidate. See `docs/agents/workflow.md`.

### Domain docs

Single-context layout: `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
