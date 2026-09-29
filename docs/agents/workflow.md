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

Shipyard V1's feedback-loop contract is implemented by the package scripts, Git hooks, and CI workflow. Use the shortest applicable loop during development and report the command, result, and scope.

### Local and agent loop

- Formatting/autofix: `npx lint-staged` formats supported staged files before commit.
- Static feedback: `npm run typecheck` runs `tsgo --noEmit` against the configured TypeScript program.
- Focused behavior: `npm test -- <affected-test-file>` runs the relevant Vitest file; changed logic should be tested at an existing public boundary.
- Standard repository check: `npm run check` runs formatting, typechecking, build, package validation, and the full test suite. Run it before submitting a PR.
- Docs site: run `npm --prefix docs run dev` for visual inspection and `npm --prefix docs run build` when docs package output changes. No docs-specific test runner or CI check is configured.

For unstaged edits, use `npx prettier --write <files>` or `npm run format` for the whole repository. The pre-commit hook uses `npx lint-staged` and `npm run typecheck`.

The full test suite is not a commit-time hook. `npm run check` is the PR feedback loop; use focused tests while developing.

### Broader and release loop

- Package output: `npm run build`; this also copies templates and checks that public declaration files are free of Effect references. The standard check invokes it before tests.
- CI: pull requests and pushes to `staging` and `production` run the package smoke test.
- Staging deployment: the push-triggered `staging.yml` workflow runs the full check and publishes the exact `staging` commit as an npm prerelease under the `staging` dist-tag.
- Package release: the push-triggered `release.yml` workflow maintains and automatically merges the Changesets version pull request after CI, then verifies and publishes its exact `production` commit automatically through the unprotected `production` environment.

## Required checks

- TypeScript changes: `npm run typecheck`.
- Local runtime logic: focused Vitest tests through `npm test -- <affected-test-file>`, plus typechecking.
- Public build or package-output changes: `npm run build`.
- Cross-cutting or release work: `npm run typecheck`, `npm run build`, and `npm test`.
- Formatting checks are required for the repository: `npm run format:check` (included in `npm run check`).

The active CI workflow runs the package smoke test on pull requests and pushes to `staging` and `production`. The staging deployment runs the full repository check; `npm run check` remains the explicit full repository check when it is required locally.

Require cleanup and applicable verification before commit. After review fixes, rerun only affected checks and review the changed scope.

## Review findings

Small, low-risk changes receive local review of the diff against the request and applicable standards. Independent Standards and Spec review is reserved for substantial cross-module changes, security or data-integrity risks, or explicit requirements.

- Every applicable review axis must complete unless the user explicitly waives a missing axis under repository policy.
- A heuristic Standards concern may be fixed and re-reviewed, or explicitly accepted or deferred by the user.
- A Spec gap or documented-standard violation requires a fix or an explicit user change to the source requirement or standard.

## Pull or merge request

The default integration branch is `staging`. Use squash merge for task PRs. The agent may push a task branch and open a draft PR after cleanup and applicable checks. It may mark the PR ready after the required review is complete. A small change can open a ready PR after inline local review.

| Transition                           | Actor and event                                                                                                                                     | Evidence                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Task PR merge to `staging`           | Human merges after required checks and review pass for the current head.                                                                            | Merged PR and passing CI.                                                   |
| Executable issue closure             | Agent closes after the task PR is merged to `staging` and required CI passes. Do not use PR closing keywords.                                       | Merged PR, passing CI, closure comment.                                     |
| Parent spec closure                  | Human records acceptance on the parent after every child closes and the integrated behavior is verified on staging; agent then closes the parent.   | Closed children, staging verification, acceptance comment, closure comment. |
| Promotion to `production`            | Human approves the current promotion candidate after staging verification and merges the promotion PR. A changed candidate requires renewed review. | Promotion PR review and merge, staging evidence.                            |
| Version PR merge and npm publication | GitHub Actions merges the generated version PR after exact-head CI and publishes the resulting exact `production` commit.                           | Release workflow, artifact checksum, npm version, GitHub release.           |

A release-specific issue can remain open through production verification when its acceptance criteria require it.

The staging deployment is the non-production verification path. Testers install its npm prerelease with `@snappedly-tools/shipyard-v1@staging`; it never advances the production `latest` dist-tag.

## Production release

Package publication is automated by `release.yml`. Pending changesets create or update a version pull request, and the workflow automatically merges it after its exact-head CI passes. The workflow then dispatches a publish run for the resulting `production` commit, reruns `npm run check`, inspects the package manifest, and publishes through npm trusted publishing via the unprotected `production` environment. See `RELEASING.md`.

The production deployment publishes the npm package; it does not deploy an always-on Shipyard V1 service. The staging deployment publishes a prerelease of the same package for testing.

The human promotion merge authorizes the automatic npm release. The workflow verifies the exact resulting `production` commit and artifact before publishing; no separate post-merge approval is required. If a service deployment is added, define its candidate and deployment approval gate before enabling agent-controlled promotion.

## Verification and recovery

For staging, verify the exact prerelease version and `staging` dist-tag, install it in the test project, and run the relevant CLI smoke behavior. For production, check `npm view @snappedly-tools/shipyard-v1 version dist.integrity`, inspect the dist-tags, install the released package, run `npx shipyard-v1 --help`, and confirm the matching GitHub tag and release.

Before npm accepts a failed publication, fix the cause and rerun the workflow or merge a correction. After publication, deprecate a broken version if needed and release a corrected patch; do not overwrite the version. A code correction goes through a new PR. No production migrations exist. Future migrations must state when rollback is unsafe.

## Handoff

A handoff reports the changed scope, issue and pull request, required check results, skipped checks and reasons, review axes and finding dispositions, merged revision, release candidate and approval state when applicable, deployment and verification evidence when applicable, and open recovery or follow-up work.
