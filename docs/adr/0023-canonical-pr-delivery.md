# Canonical coordinator-owned pull-request delivery

## Context

Shipyard has several bundled workflows that can implement issues, review
changes, and hand work back to a maintainer. A worker-owned branch or a local
merge cannot provide durable identity or recover safely after a process
interruption. Planning specs add another ownership boundary: sibling issues
must be integrated into one candidate rather than producing competing pull
requests.

## Decision

Use one coordinator-owned delivery group for each standalone issue or planning
spec. A standalone delivery has one deterministic branch and one draft pull
request. A planning-spec delivery has one integration branch and one draft pull
request; child workers return commits, while the coordinator integrates them
serially after dependency-safe parallel execution.

The coordinator is the authority for delivery identity, leases, publication,
checks, review, repairs, labels, and evidence. GitHub is the source of truth
for the current branch, pull-request, check, and merge state. Pull requests
target the configured base branch (`staging` in this repository's delivery
workflow) and remain draft until the exact candidate passes the required
checks and read-only review. A new candidate invalidates prior review and
handoff evidence.

Shipyard may create a linked repair issue for bounded pre-merge work, but a
completed child remains closed and a merged delivery is immutable. Infrastructure
failures use finite automatic recovery; exhausted work is projected with the
red `shipyard-blocked` label and sanitized evidence. Re-adding the lowercase
`shipyard` activation label explicitly resumes the existing delivery. Existing
triage labels retain their meanings and are not renamed.

Only a maintainer may merge a pull request. Shipyard observes the exact merged
candidate and closes a planning-spec parent only after all scoped children and
repair issues are resolved and required merged-candidate checks pass. Shipyard
never calls a merge operation.

Local-only branches, worktrees, and recovery artifacts are not delivery
identity and are ignored after interruption. Reconciliation uses durable
coordinator records and GitHub metadata/effects instead of creating a new
delivery from an orphan branch.

## Alternatives

- **Worker-owned PRs and local merges:** rejected because they allow competing
  candidates, hide state from the coordinator, and make interruption recovery
  ambiguous.
- **One PR per planning-spec child:** rejected because sibling changes require
  one reviewed integration candidate and one aggregate closure record.
- **Bot-controlled merge:** rejected because merge authority belongs to the
  maintainer and the repository's protected-branch rules.
- **Labels as the durable state:** rejected because labels are a GitHub
  projection; delivery identity, leases, budgets, and evidence belong in the
  coordinator record.

## Consequences

Workers return commits and evidence but cannot publish, merge, or close source
issues. The coordinator needs durable delivery and effect records plus
reconciliation adapters. A planning spec may take longer to integrate because
dependency waves run in parallel but their shared branch is updated serially.
The resulting pull request and closure evidence are unambiguous and replayable.
