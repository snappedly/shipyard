# Releasing Shipyard

Package publication is automated from `main` and requires human approval of
the exact production candidate.

## One-time setup

1. Confirm that the `snappedly-tools` npm organization owns the
   `@snappedly-tools/shipyard` package scope.
2. Configure npm trusted publishing for:
   - GitHub organization: `snappedly`
   - repository: `shipyard`
   - workflow: `release.yml`
   - environment: `production`
   - allowed action: `npm publish`
3. Configure the GitHub `production` environment with required reviewers and
   restrict it to `main`.
4. Allow GitHub Actions to create pull requests in the repository Actions
   settings.
5. Enable GitHub private vulnerability reporting and branch protection for
   `main`.

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
   **Version Packages** pull request and starts CI for its exact head commit.
2. Review and merge the version pull request when its version, changelog, and
   CI results are correct.
3. The resulting push to `main` identifies the unpublished version and queues
   an unprivileged build job. That job creates the exact tarball and checksum
   that the publish job will consume.
4. Review the workflow run, candidate commit, and built artifact, then approve
   the publish job through the protected `production` environment.

The publish job rejects a candidate superseded by a newer `main`, verifies the
approved artifact checksum and version, publishes that tarball with public
access and provenance, then creates a matching `v<version>` tag and GitHub
release with generated notes. Repository credentials are not persisted into
the checkout used by package scripts.

The repository currently has one administrator. Production therefore permits
that maintainer to approve the environment deployment; requiring a different
reviewer would deadlock releases. Add a second trusted maintainer before
disabling self-review or requiring a separate pull-request approval.

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
create the GitHub release manually from the same approved commit; do not
publish the package version again.

If publication fails before npm accepts the package, fix the cause and rerun
the failed workflow or merge a correction that produces a new `main` run. If
the published package is broken, do not overwrite the version. Deprecate it if
needed and release a corrected patch version.
