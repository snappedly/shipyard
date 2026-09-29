# Apple Silicon repository runner validation

This checklist validates the supported GitHub.com deployment on an Apple
Silicon Mac. It intentionally requires an operator-owned test repository and
credentials. Automated tests use fakes and do not register a live runner,
mutate GitHub, start Docker, or incur model cost.

## Trial record

Record the exact candidate before starting:

- Shipyard V1 commit: _operator to record_
- Package/tarball version: _operator to record_
- macOS and Apple Silicon model: _operator to record_
- Test repository and default branch: _operator to record_
- Start time: _operator to record_
- Result: **not run in automated delivery; operator execution required**

Use a disposable private GitHub.com repository unless public-runner exposure is
the behavior under review. Configure a low-cost test agent and never paste the
one-time runner registration token into `.shipyard-v1/.env` or this report.

## Installation and activation

- [ ] From the test repository root, run `npx shipyard-v1 init`; decline repository
      runner installation and confirm no `.shipyard-v1/runner/` or
      `.github/workflows/shipyard-v1-wake.yml` was created.
- [ ] Recreate the test scaffold, accept installation, and confirm a runner named
      `shipyard-v1-{repository}-{mac-name}` appears under GitHub Settings > Actions > Runners with the `shipyard-v1` label.
- [ ] Confirm `.shipyard-v1/runner/` is ignored, mode-protected, and absent from
      `git status` and sandbox inputs.
- [ ] Commit and push `.github/workflows/shipyard-v1-wake.yml` to the default branch.
- [ ] Run `npx shipyard-v1 runner start` and confirm startup validates Docker,
      GitHub.com access, credentials, lowercase `shipyard-v1`, and the published
      workflow before listening.

## Backlog and wake delivery

- [ ] With the controller stopped, create an open issue and add exact label
      `shipyard-v1`; start the controller and confirm startup backlog processing
      invokes `npx shipyard-v1 run`.
- [ ] While idle, label another issue and confirm the Actions run quickly delivers
      a wake-up without checking out the repository; separately verify the agent
      outcome in the foreground terminal or resulting repository state.
- [ ] Add a differently cased label and confirm the wake job is skipped.
- [ ] Manually dispatch **Shipyard V1 wake-up** and confirm the idle controller
      preflights the backlog without starting an agent when no issue is eligible.
- [ ] Add enough eligible work for the repository's existing finite Shipyard V1
      limit. Confirm a changed remaining issue-number set causes another finite
      `npx shipyard-v1 run` invocation.
- [ ] Use a test workflow that exits successfully without changing eligible
      issues. Confirm the unchanged set records no progress, stops chaining, and
      leaves the controller idle; retry with a new label event or manual dispatch.

## Failure and recovery

- [ ] Make `npx shipyard-v1 run` exit nonzero. Confirm the error is shown, retained in
      `.shipyard-v1/runner/.shipyard-v1-last-failure.json`, and the controller goes
      offline rather than listening for more work.
- [ ] During active test work, close the foreground terminal. Confirm the listener
      and active child stop within the bounded shutdown path while Shipyard V1 logs
      and worktrees remain available for inspection.
- [ ] Start again and confirm stale runner-owned work and abandoned transient
      state are cleaned, labelled backlog is found, and retained run evidence is
      not deleted.
- [ ] If safe for the test account, remove the GitHub runner registration to
      simulate extended-offline expiry, then start and confirm automatic
      re-registration uses the current administrative `gh` login.

## Removal

- [ ] Run `npx shipyard-v1 runner remove`; confirm the foreground process stops, the
      GitHub registration disappears, and protected local runner directories are
      deleted while config, environment, workflow, label, issues, logs, and
      worktrees remain.
- [ ] In a fresh disposable installation, temporarily make GitHub unregistration
      fail. Confirm normal removal preserves local state. Then run
      `npx shipyard-v1 runner remove --force`, confirm local deletion, and follow the
      printed instruction to remove the orphaned registration manually in GitHub.

## Automated evidence before the live trial

Run from the Shipyard V1 source repository:

```sh
npm run check
npm pack --dry-run
```

The focused repository-runner suites cover installation, workflow generation,
controller draining, lifecycle recovery/removal, status, and sandbox credential
boundaries through fakes. Attach command output and any live-trial deviations to
the delivery issue.
