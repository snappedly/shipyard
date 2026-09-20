# Shipyard operations runbook

This runbook describes the operator boundary. It is not an activation grant and does not
select a worker, model, sandbox, GitHub identity, host, deployment system, or production
credential.

## Start-up checklist

1. Confirm the repository policy revision, base branch, required checks, worker/skill revisions,
   authorization rule, and finite phase/repair budgets.
2. Confirm the durable coordinator database and its migration have been backed up and that the
   configured service identity has only the intended repository scopes.
3. Confirm the worker sandbox and artifact retention policy before accepting implementation work.
4. Run `npm run check` for Shipyard changes. It includes typechecking, the package build, and the
   full test suite. A green process or label does not replace the coordinator evidence or human
   approval gate.

## Status and intervention

Use the `WorkflowOperator` boundary to inspect a job, then pause a job for investigation, cancel
it when the source or authorization is invalid, or resume a paused job after the owner decision.
Stop a repository during an incident; resume it only after the operator records the reason and
checks the durable queue, leases, and uncertain effects.

Status intentionally reports cost as `unknown` until measured telemetry is supplied. It reports
queue age, attempts, waiting reason, checks, artifacts, and interventions without returning
retained source bodies or credentials. Treat worker output and source prose as untrusted data.

## Recovery

- Restart: reconcile pending/expired dispatches and coordinator effects before retrying a write.
- Lease expiry: do not reuse a stale writer; acquire a new fenced lease and re-fetch the candidate.
- Stale base, brief, or review: supersede the old work and rerun the affected phase. A previous
  green result is not valid for a new head or brief hash.
- Provider failure: retain stdout/stderr/artifact references, classify the phase as failed or
  infrastructure-retryable, and keep semantic repair budgets unchanged.
- Uncertain external write: search by the stable Shipyard marker before retrying; never blindly
  create a second PR, issue, comment, or check.
- Failed post-merge verification: keep the source issue open and use the repository's approved
  revert or roll-forward procedure. Database changes require a forward-compatible recovery plan.

## Credentials, retention, and rotation

Credentials are resolved only through the phase allowlist and never passed as source text or
worker policy. Rotate them in the owning secret manager, revoke the old value, verify the new
value with a least-privilege read-only smoke, and record the rotation without copying secrets to
logs or issues. Retain delivery, phase, review, check, and artifact metadata only for the
approved retention period; delete or expire raw bodies/artifacts according to the owner-approved
policy rather than an agent instruction.

## Pilot decision

Continuous intake and production release remain disabled until the pilot owner records the exact
bug/enhancement cases, worker and host settings, required checks, candidate identity, human
approval enforcement, smoke/restore evidence, and recovery authority. See the acceptance report
for the current evidence and explicit go/no-go state.
