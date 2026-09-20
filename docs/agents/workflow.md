# Team workflow

How work moves from an agreed request to a production-verified change.

## Source of truth

GitHub Issues are canonical for work items and approved executable specifications. `CONTEXT.md`, ADRs, and planning documents are supporting repository sources, not executable tickets.

A small, clear user request can serve as the implementation brief. Ticketed `/implement` work starts from an executable issue or agent brief. Planning specs and wayfinder decision tickets do not qualify as executable work. `/implement-spec` is the explicit path for delivering a complete planning spec through its child ticket graph.

## Ready to implement

Implementation may start when the request or executable issue has an agreed scope, acceptance criteria, verification expectations, and no unresolved question that changes the implementation. Small clear requests may proceed directly. Planned work requires the executable issue or brief.

## Verification scope

Use risk-proportional verification:

- Documentation and copy changes use direct inspection of the affected output and exercise affected static links.
- Changed logic, state transitions, validation, and behavioral regressions use focused tests at existing public boundaries.
- Mixed changes verify each part using its applicable method.
- Agents select established test seams autonomously; clarify only when the contract is unresolved.

## Feedback loops

Shipyard's feedback-loop contract is implemented by the package scripts, Git hooks, and CI workflow. Use the shortest applicable loop during development and report the command, result, and scope.

### Local and agent loop

- Formatting/autofix: `npx lint-staged` formats supported staged files before commit.
- Static feedback: `npm run typecheck` runs `tsgo --noEmit` against the configured TypeScript program.
- Focused behavior: `npm test -- <affected-test-file>` runs the relevant Vitest file; changed logic should be tested at an existing public boundary.
- Standard repository check: `npm run check` runs `npm run format:check`, `npm run typecheck`, `npm run build`, and the full `npm test` suite. It is self-contained on a clean checkout.
- Frontend feedback: not applicable to the root CLI/library package. The documentation site is a separate `docs/` package and should use its own preview contract when UI work begins.

The pre-commit hook runs staged formatting and then the cheap typecheck. The full test suite is not a commit-time hook because it is a broader check reserved for explicit local, agent, or release verification.

### Broader and release loop

- Package output: `npm run build`; this also copies templates and checks that public declaration files are free of Effect references. The standard check invokes it before tests.
- CI: pull requests and pushes to `main` run the package smoke test and documentation build.
- Package release: the push-triggered `release.yml` workflow maintains and automatically merges the Changesets version pull request after CI, then verifies and publishes its exact `main` commit automatically through the unprotected `production` environment.

## Required checks

- TypeScript changes: `npm run typecheck`.
- Local runtime logic: focused Vitest tests through `npm test -- <affected-test-file>`, plus typechecking.
- Public build or package-output changes: `npm run build`.
- Cross-cutting or release work: `npm run typecheck`, `npm run build`, and `npm test`.
- Formatting checks are required for the repository: `npm run format:check` (included in `npm run check`).

The active CI workflow runs the package smoke test and documentation build on pull requests and pushes to `main`. Full suites and production/deployment builds are not universal local defaults; `npm run check` remains the explicit full repository check when it is required.

Require cleanup and applicable verification before commit. After review fixes, rerun only affected checks and review the changed scope.

## Review findings

Small, low-risk changes receive local review of the diff against the request and applicable standards. Independent Standards and Spec review is reserved for substantial cross-module changes, security or data-integrity risks, or explicit requirements.

- Every applicable review axis must complete unless the user explicitly waives a missing axis under repository policy.
- A heuristic Standards concern may be fixed and re-reviewed, or explicitly accepted or deferred by the user.
- A Spec gap or documented-standard violation requires a fix or an explicit user change to the source requirement or standard.

## Pull or merge request

The base branch is `main`. Changes intended for integration land through a pull request; small changes may perform local review inline but still use the same delivery path. The recommended merge strategy is squash merge. The agent may push the task branch and create or update its pull request after applicable checks pass.

Issues close when the change is merged to `main` and required CI passes. A future release task may remain open until its release verification completes.

No preview deployment is configured today. If a future non-production preview exists, it may run before production approval.

## Production release

Package publication is automated by `release.yml`. Pending changesets create or update a version pull request, and the workflow automatically merges it after its exact-head CI passes. The workflow then dispatches a publish run for the resulting `main` commit, reruns `npm run check`, inspects the package manifest, and publishes through npm trusted publishing via the unprotected `production` environment. See `RELEASING.md`.

The repository has no hosted production environment or deployment workflow. Publishing the npm package does not deploy an always-on Shipyard service.

If a separate production service deployment is added, the candidate must be identified by its exact `main` commit plus immutable version/artifact where available. A changed candidate invalidates prior approval, and any deployment-system approval gate must prevent an unapproved service candidate from deploying. The npm package release is intentionally unattended after its exact-candidate checks.

## Verification and recovery

Production verification is currently not applicable. For repository changes, evidence is the applicable PR checks and review. For any future release, verify the exact artifact/version, package or CLI smoke behavior, deployment result, and relevant health signals.

Recovery is by revert or roll-forward through a new pull request. No production migrations exist in this repository. Future migrations must document whether rollback is unsafe and require a forward-compatible recovery plan.

## Handoff

A handoff reports the changed scope, issue and pull request, required check results, skipped checks and reasons, review axes and finding dispositions, merged revision, release candidate and approval state when applicable, deployment and verification evidence when applicable, and open recovery or follow-up work.
