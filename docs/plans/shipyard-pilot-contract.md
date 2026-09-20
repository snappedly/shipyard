# Shipyard pilot contract

- Contract revision: `0.2`
- Evidence baseline: `2026-09-18`
- Shipyard baseline: `dde659b4fa2fa29db9a7b2ccd4e8f8fbaec2bd27`
- Status: **NO-GO / not activated**

This is the versioned repository-side decision record for a first Shipyard
representative trial. It is a contract and evidence ledger, not activation
authority. It keeps the Shipyard policy target-agnostic: a target repository
must supply its own identity, repository policy, deployment settings, and
activation evidence. The inspected target's canonical identity is therefore
not copied into this document; the target owner must record it in the
target-owned activation record before activation.

No credentials, infrastructure, secrets, labels, workflows, deployments, or
activation settings were changed while collecting this record. No agent was
launched.

## Revision 0.2 refresh

This revision refreshes the read-only target evidence after the previous
contract was merged. The configured pilot alias resolved to a different
private canonical repository; its identity remains intentionally omitted here
and must be recorded in the target-owned activation record. The target still
uses `staging` as its default branch and has a separate `production` branch.

The target's earlier Cloudflare Worker deployment path failed because the
generated `dist/server/wrangler.json` was absent. That path was subsequently
removed in target PR #31. The current target snapshot has no checked-in
deployment workflow or selected hosting provider. The current staging CI run
is therefore evidence of repository checks only, not a staging deployment.
The explicit trigger for this decision ticket authorizes this record refresh;
it does not approve a provider, model, sandbox, budget, credential scope, or
release activation.

## Disposition terms

- **Configured** means an explicit contract value or safety invariant exists.
- **Observed** means read-only evidence was seen in a repository or GitHub
  control surface. It is not proof that the setting is enforced everywhere.
- **Unresolved** means a value, decision, or evidence is still required. The
  named owner must record it before the affected path is activated.
- **Activation blocker** means the unresolved item blocks the affected worker,
  target integration, or release path. It does not authorize a workaround.

A branch name, workflow name, deployment notification, successful check, or
agent completion signal never proves that a release gate or environment is
enforced.

## Ownership and scope

### Shipyard-owned concerns

- Shipyard owns its execution source, package history, workflow contracts,
  coordinator state, and versioned skills integration.
- Shipyard's integration branch is `main`. Its issue closure point is merge to
  `main` plus required CI success. A decision or implementation issue is not
  closed by a commit or completion signal.
- Shipyard's standard check is `npm run check`, which runs formatting checks,
  typechecking, the package build, and the full test suite. Shipyard's current
  repository at the pinned `dde659b4…` evidence baseline had no package-publish
  command, production environment, or production deployment workflow. That is
  historical evidence, not a claim about later Shipyard revisions.
- A Shipyard package build is not a deployment of the target application.
  Shipyard may later observe or request target CI/deployment actions through a
  permitted coordinator integration, but target credentials and deployment
  authority remain outside Shipyard workers.

### Target-coordinated concerns

- The target repository owns its base/release branches, issue closure point,
  required checks, environment and domain mapping, runtime, data stores,
  deployment provider, release workflow, recovery process, and launch review.
- Target issue state and Shipyard workflow state are distinct. A target issue
  remains open until the target's configured completion point; a Shipyard
  issue follows Shipyard's `main`/CI closure rule.
- The first proposed slice is one maintainer-approved standalone target issue
  through an isolated task branch, required checks, independent review,
  bounded repair, draft PR, and human handoff. It does not authorize
  unattended implementation, whole-spec orchestration, merge automation, or
  production approval.

## Read-only evidence ledger

The following evidence was collected through `gh` against the candidate target
repository and its GitHub control surfaces. The repository alias used for the
inspection resolved to a different canonical repository; that identity is
intentionally omitted here to preserve the current target-agnostic policy.

| Source                       | Observed evidence                                                                                                                                                                                                                                                                             | What it does not establish                                                                           |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Shipyard checkout            | The current integrated revision is `dde659b4…`; the worktree was clean. The current workflow and acceptance records keep target repositories configurable.                                                                                                                                    | That Shipyard is deployed or that any target is activated.                                           |
| Target metadata              | The private target reports `staging` as its default branch and has a separate `production` branch. Branch-protection and ruleset endpoints returned a GitHub-plan `403`.                                                                                                                      | Effective organization rules, deployment filters, or approval enforcement.                           |
| Target repository contents   | `AGENTS.md`, a package manifest, `.github/workflows/ci.yml`, native Next.js build scripts, runtime/deployment documentation, `scripts/smoke.ts`, and `scripts/verify-release.ts` are present. The former Worker workflow/configuration is absent.                                             | That checked-in instructions, scripts, or route declarations have succeeded in a live environment.   |
| Target verification workflow | Current CI runs typecheck, lint, tests, synthetic smoke, native build, and `git diff --check`. The target package exposes `npm run check`, `npm run smoke`, `npm run build`, `npm run db:migrate`, and `npm run release:verify`; `release:verify` is not invoked by current CI.               | That every listed command is a required branch gate or that it has passed for the current candidate. |
| Target deployment workflow   | No deployment workflow is present at the refreshed staging revision. Target documentation says hosting and domain transfer remain pending; no provider is selected by the current source.                                                                                                     | That any staging or production environment is deployable or that a provider is authorized.           |
| GitHub environments          | Read-only metadata exposes both `staging` and `production` environments with no visible protection rules. Branch-protection and ruleset endpoints returned a GitHub-plan `403`.                                                                                                               | Organization-level rules, deployment-provider gates, approvers, or settings hidden by the API plan.  |
| Recent target runs           | Staging checks passed at `fb887e1…`, while its former deployment failed on missing `dist/server/wrangler.json`; the path was removed by target PR #31 at `37cea7a…`. Production checks passed at `5e3d249…`, while its release gate failed because approved SHA/digest variables were absent. | A stable staging deployment, a healthy target endpoint, or production readiness.                     |
| Candidate gate code          | `scripts/verify-release.ts` still compares the candidate full commit SHA and artifact digest and fails on missing or mismatched values, but no current workflow invokes it.                                                                                                                   | That a production environment invokes the script or prevents bypass.                                 |
| Target release documentation | The target documents `staging.aimasterhub.com` and `aimasterhub.com`, smoke, health, backup/restore, privacy, deliverability, and recovery expectations. Its closed release issue retains older `hub-staging.snappedly.com` and `hub.snappedly.com` criteria.                                 | Which domain mapping is authoritative, whether DNS is attached, or whether launch review occurred.   |
| Target issue inventory       | The closed MVP0 release issue provides source context but does not authorize Shipyard work. No separate confirmed bug or enhancement issue was selected for this pilot; the scenario IDs and owners remain unresolved.                                                                        | That a proposed scenario has an issue ID, maintainer priority, or authorization.                     |

The target observations are retained only to justify the dispositions below.
They do not change Shipyard policy or grant access to the target.

## Contract fields and decisions

Every field required for activation is either configured below or has an
explicit unresolved owner. `Unresolved` values are not defaults.

| Field                                 | Contract value or unresolved decision                                                                                                                                                                                                                                      | Owner / activation condition                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Target repository identity            | **Unresolved.** Record the canonical owner/name, visibility, and immutable inspection revision in the target-owned activation record.                                                                                                                                      | Target maintainer; required before any target mutation.                                     |
| Target integration branch             | Observed `staging`; treat as a candidate value only.                                                                                                                                                                                                                       | Target maintainer; confirm as the base branch and record the exact candidate SHA.           |
| Target release branch                 | Observed `production`; treat as a candidate value only.                                                                                                                                                                                                                    | Target maintainer; prove the branch-to-environment mapping.                                 |
| Branch/environment mapping            | **Unresolved.** Branch names and documentation disagree on the public domain mapping, and the current target has no deployment workflow.                                                                                                                                   | Target release owner; required before staging or production activation.                     |
| Target issue closure                  | **Unresolved.** Record whether closure is merge, staging verification, production verification, or a separate release item.                                                                                                                                                | Target maintainer; do not close from a commit or agent signal.                              |
| Shipyard issue closure                | Configured: merge to `main` and required Shipyard CI success.                                                                                                                                                                                                              | Shipyard coordinator; applies only to Shipyard issues.                                      |
| Intake trigger and deduplication      | **Unresolved.** Choose manual dispatch, an explicit maintainer action, or another authenticated trigger and record replay/deduplication behavior.                                                                                                                          | Shipyard maintainer; no intake activation before decision.                                  |
| Implementation authorization          | Configured policy: maintainer-approved standalone work only. Triage may be bounded; implementation requires an explicit `ready-for-agent` authorization.                                                                                                                   | Shipyard coordinator and target maintainer; no auto-start before approval.                  |
| Agent provider and model              | **Unresolved.** Pin the provider, model, reasoning/profile setting, and fallback. Shipyard's default provider is not pilot authorization.                                                                                                                                  | Shipyard maintainer; required before a worker starts.                                       |
| Sandbox and host                      | **Unresolved.** Choose a disposable sandbox and host environment; record mounts, network policy, image/runtime revision, and prerequisites.                                                                                                                                | Shipyard maintainer; required before a worker starts.                                       |
| Skills revision                       | **Unresolved.** Pin the exact skills revision loaded by triage, implementation, review, and repair.                                                                                                                                                                        | Shipyard maintainer; required for reproducibility.                                          |
| GitHub identity and scopes            | **Unresolved.** Select the coordinator identity and minimum repository permissions. Workers must not receive merge, signing, or deployment authority.                                                                                                                      | Shipyard maintainer; required before any external write.                                    |
| Phase budgets                         | **Unresolved.** Record finite triage, implementation, review, repair, wall-time, iteration, model, and per-issue cost limits. Unknown telemetry is not zero cost.                                                                                                          | Shipyard maintainer; required before a worker starts.                                       |
| Provider/model failure handling       | **Unresolved.** Record bounded infrastructure retries, semantic budget exhaustion, escalation/fallback behavior, and telemetry that distinguishes provider failure from workflow failure.                                                                                  | Shipyard maintainer; required before intake activation.                                     |
| Convergence policy                    | Configured recommendation: one implementation, one independent review, one normal fix batch, and one follow-up. A missing check or review result is not a pass.                                                                                                            | Shipyard coordinator; exhaustion requires maintainer disposition.                           |
| Target runtime/provider               | Observed native Next.js build and a managed EU Postgres runtime contract. The hosting provider, project/account, environment URLs, and runtime proof remain **unresolved**.                                                                                                | Target runtime owner; required before target deployment.                                    |
| Target deployment automation          | **Unresolved.** The current target snapshot has no checked-in deployment workflow. The earlier Worker path failed on a missing generated manifest before publication.                                                                                                      | Target release owner; choose and verify a provider-specific path before staging activation. |
| Target credentials and data isolation | **Unresolved.** Verify separate staging/production database, email, anti-abuse, hosting credentials, lists, access policies, and secret scopes. Do not inspect or copy secret values into Shipyard.                                                                        | Target runtime/release owners; required before live data or deployment.                     |
| Credential rotation and retention     | **Unresolved.** Record secret rotation/revocation ownership and schedule, event/job/artifact retention, deletion authority, and evidence that redaction is applied before operator or provider publication.                                                                | Shipyard and target maintainers; required before live intake or deployment.                 |
| Required target checks                | Candidate set observed: typecheck, lint, tests, synthetic smoke, native build, and diff check. The exact-candidate script exists but is not wired into current CI; required/gating status is **unresolved**.                                                               | Target maintainer; prove a failed required check blocks readiness.                          |
| Staging verification                  | Required: page/health response, synthetic signup, invalid anti-abuse input, duplicate submission, referral capture, provider failure/recovery, unsubscribe, removal, privacy/terms, accessibility, backup/restore, and monitoring. No complete live evidence was observed. | Target release owner; required before production approval.                                  |
| Production candidate                  | Configured invariant: identify the exact full commit SHA and immutable artifact digest; any change invalidates approval. The target script implements comparison logic, but current workflow enforcement is absent.                                                        | Target release owner; record the approval and prove enforcement.                            |
| Production approval                   | Configured policy: a human approves the exact candidate after staging evidence. Actual production environment/approver enforcement is **unresolved**.                                                                                                                      | Target maintainer; required before production deployment.                                   |
| Production verification               | Required: candidate identity, deployment result, health/smoke checks, logs/error signals, and domain response. No production deployment or verification is claimed.                                                                                                        | Target release owner; required to mark the pilot complete.                                  |
| Recovery                              | Required: last approved candidate, authorized operator, stop-promotion path, backup/restore evidence, and migration-compatible rollback or forward-fix procedure. Actual authority/RTO/RPO are **unresolved**.                                                             | Target maintainer; required before release activation.                                      |
| Legal/privacy and deliverability      | **Unresolved.** Record reviewers and approval for privacy/terms/consent/retention wording, rights process, sender/provider configuration, and accessibility.                                                                                                               | Target maintainer and named reviewers; required before launch.                              |
| Completion definition                 | Recommended decision: production verification is the product outcome; merge and staging verification remain separately recorded.                                                                                                                                           | Shipyard and target maintainers; explicit sign-off required.                                |
| Repair tracking                       | **Unresolved.** Decide whether a bounded PR repair needs a linked follow-up issue; repairs must update the original candidate and invalidate affected evidence.                                                                                                            | Shipyard maintainer; required before review automation.                                     |
| Current activation scope              | Configured: read-only discovery and contract reconciliation only. This refresh authorizes no worker, intake, target write, deployment, merge automation, or release promotion.                                                                                             | Coordinator; remains in force while status is NO-GO.                                        |

## Selected representative scenarios

These scenarios are selected for a future Phase 0 exercise from observed target
evidence. They are not currently authorized work items. The target maintainer
must assign or confirm source issue IDs and acceptance ownership before either
implementation scenario starts.

| Class             | Selected scenario                                                                                                                                                                                                                                                       | Measurable expected outcome                                                                                                                                                                                               | Disposition                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bug               | **Staging deployment path is unavailable.** The former Worker deployment failed before publication because `dist/server/wrangler.json` was missing, then the target removed that workflow.                                                                              | The target owner selects one provider, records the environment mapping, and demonstrates a clean staging deployment plus health check; any preflight/credential failure stops before publication and is recorded.         | Defensible failure evidence; target maintainer must confirm/assign the bug item and provider-specific remedy. Blocks the bug trial until confirmed. |
| Small enhancement | **Make the native synthetic smoke path cover the release boundary.** The current script covers signup, duplicate handling, referral-code creation/use, delivery, unsubscribe, and erasure, but does not assert referral attribution or a live health/recovery boundary. | One deterministic, synthetic-only verification command asserts referral attribution, health, and provider failure/retry at the selected staging boundary, exits non-zero on failure, and leaves no real credentials/data. | Defensible bounded enhancement from current script/docs; target maintainer must approve the brief.                                                  |
| Ambiguous request | **A planning/specification request without a bounded executable outcome.** The target issue contract explicitly distinguishes planning from executable work.                                                                                                            | Triage preserves the source context, asks for one concrete outcome, acceptance criteria, owner, and verification path, and dispatches no implementation until answered.                                                   | Selected needs-information/no-dispatch case; safe to use only after intake authorization.                                                           |

The scenario set does not claim that the target has approved these items, that
the bug has been repaired, or that the enhancement is on its roadmap.

## Decisions required before activation

The following decisions remain open and keep the record at NO-GO:

1. The target owner must record canonical repository identity, branch and
   environment mapping, authoritative domains, selected hosting provider,
   required-check enforcement, and the target issue IDs for the two executable
   scenarios. The current target's domain mismatch and absent deployment path
   are unresolved, not defaults.
2. The Shipyard maintainer must pin the agent/model, sandbox/host, skills
   revision, GitHub identity/scopes, trigger, and finite budgets.
3. The target release owner must select and demonstrate a passing staging
   candidate, isolated credentials/data, backup/restore evidence, monitoring,
   and the exact-candidate production gate with human approval.
4. The maintainers must decide the closure/completion point and recovery
   authority. Merge, staging success, and production verification must remain
   distinguishable.

Until those decisions and evidence are recorded, do not enable continuous
intake, implementation auto-start, merge automation, target deployment, or
release promotion. Shipyard's own package build/check remains independent of
those target decisions.

## Go/no-go decision

**NO-GO / not activated.** The record is sufficient for read-only discovery and
for planning a bounded representative trial, but not for execution or release.
The failed and then removed staging deployment path, missing target production
gate enforcement, unresolved branch/domain/provider mapping, unknown worker
configuration and budgets, unverified data/credential isolation, and missing
live smoke/restore evidence are material blockers. Unknown cost, quality,
intervention, recovery, and deployment telemetry remains **unknown**, not zero.
