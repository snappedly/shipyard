# Releasing Shipyard

Package versioning starts automatically after a change reaches `main`.
Publication also starts automatically after the exact production candidate is
verified.

## One-time setup

1. Confirm that the `snappedly-tools` npm organization owns the
   `@snappedly-tools/shipyard` package scope.
2. Configure npm trusted publishing for:
   - GitHub organization: `snappedly`
   - repository: `shipyard`
   - workflow: `release.yml`
   - environment: `production`
   - allowed action: `npm publish`
3. Configure the GitHub `production` environment, restrict it to `main`, and
   leave it without required reviewers or wait timers.
4. Allow GitHub Actions to create pull requests in the repository Actions
   settings.
5. Enable GitHub private vulnerability reporting and branch protection for
   `main`.

Keep the `ci` status check required on `main`, and do not require a human
approval for the generated version pull request; the release workflow merges it
after that check passes.

Trusted publishing uses short-lived OIDC credentials, so the workflow does not
need an npm write token.

## Prepare a change

Every user-facing change pull request includes a changeset for
`@snappedly-tools/shipyard`:

- bug fix: `patch`
- feature or breaking change: `minor` while the package is pre-1.0

Changes that do not affect the published package do not need a changeset.

## Automated release

Every push to `main` runs the **Release npm package** workflow after the full
repository check:

1. If pending changesets exist, the workflow creates or updates the
   **Version Packages** pull request and runs CI for its exact head commit.
2. After CI passes, the workflow publishes a passing `ci` commit status for
   that exact head commit, enables auto-merge, waits for the version pull
   request to merge, and dispatches a release run for the resulting `main`
   commit. No manual review or merge of the generated version pull request is
   required.
3. The release run identifies the unpublished version and creates the exact
   tarball and checksum that the publish job will consume.
4. The publish job verifies the exact candidate and artifact, then publishes
   automatically through the `production` environment.

The publish job rejects a candidate superseded by a newer `main`, verifies the
artifact checksum and version, publishes that tarball with public access and
provenance, then creates a matching `v<version>` tag and GitHub release with
generated notes. Repository credentials are not persisted into the checkout
used by package scripts.

If no changesets or unpublished versions exist, the workflow does nothing.

## Verify

Verify the published version and install path:

```sh
npm view @snappedly-tools/shipyard version dist.integrity
npm install --save-dev @snappedly-tools/shipyard
npx shipyard --help
```

Confirm that the matching tag and release are visible on the repository's
Releases page. If package publication succeeds but release creation fails,
create the GitHub release manually from the same commit; do not
publish the package version again.

If publication fails before npm accepts the package, fix the cause and rerun
the failed workflow or merge a correction that produces a new `main` run. If
the published package is broken, do not overwrite the version. Deprecate it if
needed and release a corrected patch version.
