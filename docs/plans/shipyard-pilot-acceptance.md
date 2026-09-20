# Shipyard pilot acceptance record

Status: **NO-GO / not activated** as of 17 September 2026.

This record reports what is implemented locally and what remains unknown. It deliberately does
not claim a live pilot, measured provider cost, deployment success, or production readiness.

## Local contract evidence

- Versioned work briefs, policy validation, durable coordinator state, fenced leases, bounded
  execution, authenticated GitHub intake/publication, triage resumption, immutable independent
  review, bounded repair, and handoff gates have focused scenario coverage.
- The operator boundary exercises pause, cancel, resume, repository stop/resume, redacted status,
  queue age, and explicit unknown-cost reporting.
- The local verification target is `npm run check`, which covers formatting, typechecking, the
  package build, and the full test suite.

## Operational prerequisites

The pilot remains blocked until a maintainer records these target-specific values in the
activation contract:

- Host setup: disposable image/runtime revision, mounts, network policy, prerequisites, and
  worker permissions.
- Backup and recovery: backup owner, restore exercise, retention window, recovery authority, and
  migration-safe roll-forward or rollback limits.
- Credential rotation and retention: secret scopes, rotation/revocation procedure, event/job and
  artifact retention, deletion owner, and redaction checks. Shipyard must not receive secret
  values.
- Model/provider failure handling: pinned provider/model and skill revision, bounded retries and
  budgets, escalation/fallback policy, and the measured telemetry fields. Unknown cost remains
  unknown.
- Operator evidence durability: the current operator adapter keeps intervention history in
  process memory; restart durability is not claimed and must be supplied before continuous intake.

The repository currently records these as unresolved activation decisions; no default host,
provider, credentials, retention period, or budget is implied by the local fixtures.

The target-agnostic lifecycle and release adapters are therefore implementation evidence only.
They do not resolve #6's maintainer decisions, authorize a dependent pilot, or close the decision
ticket; affected activation and live-trial work remains blocked at this boundary.

## Release adapter evidence

The generic release adapter is configured by its caller; it does not select a target provider,
branch topology, credentials, or environment. Its local provider contract is covered in
`src/integrations/releases/index.test.ts`:

- The candidate binds source SHA, reviewed head SHA, brief hash, artifact digest, artifact
  reference, and version. A changed field cannot reuse staging evidence or human approval.
- Missing or failed configured staging checks, smoke, or health evidence leave promotion blocked.
  Production requests also require a human owner/maintainer approval for the exact candidate.
- Staging and production requests use stable candidate-scoped idempotency keys and reconcile a
  pending intent before retrying a provider request. Deployment calls receive the configured
  environment name and complete candidate rather than a Shipyard-owned default.
- Failed production verification stops further promotion. `recordRecovery` records the configured
  `rollback`, `roll-forward`, or `owner-decision` action and authorization; it does not execute
  recovery or imply that application rollback reverses a database migration.

These are deterministic adapter/provider-contract tests, not a live deployment or recovery trial.
The target owner must still attach non-production recovery evidence and prove the deployment
system's exact-candidate gate before the pilot can leave **NO-GO**.

## Representative scenario evidence

These are local representative inputs and safety seams, not completed pilot outcomes. A future
maintainer-approved trial must attach real issue IDs, authorization, measured results, and the
exact candidate before claiming either implementation reached human handoff.

| Input                                               | Expected lifecycle outcome                                                                                         | Local evidence seam                                                                                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug-shaped report with explicit acceptance criteria | Triage classifies it without authorizing from prose; approved work reaches a current, check-backed human handoff.  | `src/workflow/triage/index.test.ts` — clear bug classification; `src/workflow/implementation/index.test.ts` — verified draft; `src/workflow/handoff/index.test.ts` — current candidate handoff. |
| Enhancement-shaped report with bounded scope        | It follows the same authorization, check, review, and handoff gates; no release is implied.                        | `src/workflow/triage/index.test.ts` — enhancement classification; `src/workflow/handoff/index.test.ts` — exact human approval and post-merge checks.                                            |
| Unclear intake with unresolved acceptance           | One clarification request is retained; the item waits and resumes without an unauthorized implementation dispatch. | `src/workflow/triage/index.test.ts` — clarification/resumption; `src/workflow/coordinator/coordinator.test.ts` — authorization withdrawal and budget convergence.                               |

The representative cases demonstrate contract behavior only. They do not establish live provider,
worker, sandbox, deployment, quality, cost, or recovery results.

## Not measured

No live bug or enhancement was run through a provisioned worker, sandbox, GitHub App, database,
staging deployment, release workflow, smoke check, restore test, or production gate in this
change. Provider/model cost, intervention rate, quality rate, and recovery time are therefore
**unknown**, not zero.

## Go/no-go decision

Do not enable continuous intake, implementation auto-start, merge automation, or release
promotion. Before a maintainer changes that decision, record the pilot issue IDs and measurable
acceptance outcomes, exact worker/model/sandbox and finite budgets, GitHub identity/scopes,
required checks, branch/ruleset enforcement, staging/production candidate mapping, isolated data
and credentials, smoke/restore evidence, human approval, and recovery authority. These are the
activation blockers that belong in the selected repository's activation contract.
