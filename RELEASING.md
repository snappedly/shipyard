# Releasing Shipyard V1

The default branch is `staging`, where changes are tested before they are
merged into the protected `production` branch. A push to `staging` publishes
an isolated npm prerelease; a push to `production` publishes the production
package.

## One-time setup

1. Confirm that the `snappedly-tools` npm organization owns the
   `@snappedly-tools/shipyard-v1` package scope.
2. After the first package publish described below, configure npm trusted
   publishing for:
   - GitHub organization: `snappedly`
   - repository: `shipyard-v1`
   - workflow: `release.yml`
   - environment: `production`
   - allowed action: `npm publish`
   - workflow: `staging.yml`
   - environment: `staging`
   - allowed action: `npm publish`
3. Configure the GitHub `production` environment and restrict deployments to
   the `production` branch. Configure the `staging` environment and restrict
   deployments to the `staging` branch. Leave both without required reviewers
   or wait timers.
4. Allow GitHub Actions to create pull requests in the repository Actions
   settings.
5. Enable GitHub private vulnerability reporting and branch protection for
   `production`.

Keep the `ci` status check required on `production`, and do not require a human
approval for the generated version pull request; the release workflow merges it
after that check passes.

Trusted publishing uses short-lived OIDC credentials, so the workflow does not
need an npm write token.

### Bootstrap the renamed npm package

`@snappedly-tools/shipyard-v1` is a new npm package. npm requires a package to
exist before it can have a trusted publisher. After the task PR merges to
`staging`, the first **Deploy staging** run can build and smoke-test the package
but cannot publish it through OIDC. An npm maintainer must:

1. Download `npm-staging-package-<staging commit>` from that run and verify
   `shipyard-v1-staging.tgz.sha256` against the tarball.
2. Publish that exact tarball with npm account authentication:

   ```sh
   NPM_CONFIG_PROVENANCE=false npm publish shipyard-v1-staging.tgz --access public --tag staging
   ```

3. Add trusted publishers for `staging.yml` and `release.yml` using the fields
   above, then dispatch a new **Deploy staging** run with
   `gh workflow run staging.yml --ref staging`. A new run ID gives the package a
   new prerelease version. Complete this before promotion to `production`.

The bootstrap publish lacks a provenance attestation. Later workflow publishes
use OIDC and provenance. See [npm's trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Prepare a change

Every user-facing change pull request includes a changeset for
`@snappedly-tools/shipyard-v1`:

- bug fix: `patch`
- feature or breaking change: `minor` while the package is pre-1.0

Changes that do not affect the published package do not need a changeset.

## Automated release

Every push to `staging` runs the **Deploy staging** workflow. It runs the full
repository check, publishes a unique prerelease such as
`0.4.4-staging.123456789`, and moves the npm `staging` dist-tag. It does not
move the `latest` dist-tag, create a GitHub release, or publish to the
production environment. Install it with:

```sh
npm install --save-dev @snappedly-tools/shipyard-v1@staging
```

Every push to `production` runs the **Release npm package** workflow after the
full repository check:

1. If pending changesets exist, the workflow creates or updates the
   **Version Packages** pull request and runs CI for its exact head commit.
2. After CI passes, the workflow publishes a passing `ci` commit status for
   that exact head commit, enables auto-merge, waits for the version pull
   request to merge, and dispatches a release run for the resulting `production`
   commit. No manual review or merge of the generated version pull request is
   required.
3. The release run marks the exact `production` revision's `ci` status as pending
   before the repository check starts. The Actions run exposes separate
   **Build npm package**, **Smoke exact package**, and **Publish npm package**
   checks, each with its own pending/success/failure state.
4. An always-running finalizer records the aggregate `ci` result, including
   failures during repository checks, versioning, build, smoke checks, or
   publication.

The publish job rejects a candidate superseded by a newer `production`, verifies the
artifact checksum and version, publishes that tarball with public access and
provenance, then creates a matching `v<version>` tag and GitHub release with
generated notes. Repository credentials are not persisted into the checkout
used by package scripts.

If no changesets or unpublished versions exist, the production workflow does
nothing. The staging workflow always publishes the tested staging candidate.

## Verify

Verify the published version and install path:

```sh
npm view @snappedly-tools/shipyard-v1 version dist.integrity
npm view @snappedly-tools/shipyard-v1 dist-tags
npm install --save-dev @snappedly-tools/shipyard-v1
npx shipyard-v1 --help
```

Confirm that the matching tag and release are visible on the repository's
Releases page. If package publication succeeds but release creation fails,
create the GitHub release manually from the same commit; do not
publish the package version again.

If publication fails before npm accepts the package, fix the cause and rerun
the failed workflow or merge a correction that produces a new `production` run.
If the published package is broken, do not overwrite the version. Deprecate it
if needed and release a corrected patch version.
