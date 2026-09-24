# Apple Silicon repository runner validation

This checklist validates the supported GitHub.com deployment on an Apple
Silicon Mac. It intentionally requires an operator-owned test repository and
credentials. Automated tests use fakes and do not register a live runner,
mutate GitHub, start Docker, or incur model cost.

## Trial record

Record the exact candidate before starting:

- Shipyard commit: _operator to record_
- Package/tarball version: _operator to record_
- macOS and Apple Silicon model: _operator to record_
- Test repository and default branch: _operator to record_
- Start time: _operator to record_
- Result: **not run in automated delivery; operator execution required**

Use a disposable private GitHub.com repository unless public-runner exposure is
the behavior under review. Configure a low-cost test agent and never paste the
one-time runner registration token into `.shipyard/.env` or this report.

## Installation and activation

- [ ] From the test repository root, run `npx shipyard init`; decline repository
      runner installation and confirm no `.shipyard/runner/` or
      `.github/workflows/shipyard-wake.yml` was created.
- [ ] Recreate the test scaffold, accept installation, and confirm a runner named
      `shipyard-{repository}-{mac-name}` appears under GitHub Settings > Actions > Runners with the `shipyard` label.
- [ ] Confirm `.shipyard/runner/` is ignored, mode-protected, and absent from
      `git status` and sandbox inputs.
- [ ] Commit and push `.github/workflows/shipyard-wake.yml` to the default branch.
- [ ] Run `npx shipyard runner start` and confirm startup validates Docker,
      GitHub.com access, credentials, lowercase `shipyard`, and the published
      workflow before listening.

## Backlog and wake delivery

- [ ] With the controller stopped, create an open issue and add exact label
      `shipyard`; start the controller and confirm startup backlog processing
      invokes `npx shipyard run`.
- [ ] While idle, label another issue and confirm the Actions run quickly delivers
      a wake-up without checking out the repository; separately verify the agent
      outcome in the foreground terminal or resulting repository state.
- [ ] Add a differently cased label and confirm the wake job is skipped.
- [ ] Manually dispatch **Shipyard wake-up** and confirm the idle controller
      preflights the backlog without starting an agent when no issue is eligible.
- [ ] Add enough eligible work for the repository's existing finite Shipyard
      limit. Confirm a changed remaining issue-number set causes another finite
      `npx shipyard run` invocation.
- [ ] Use a test workflow that exits successfully without changing eligible
      issues. Confirm the unchanged set records no progress, stops chaining, and
      leaves the controller idle; retry with a new label event or manual dispatch.

## Failure and recovery

- [ ] Make `npx shipyard run` exit nonzero. Confirm the error is shown, retained in
      `.shipyard/runner/.shipyard-last-failure.json`, and the controller goes
      offline rather than listening for more work.
- [ ] During active test work, close the foreground terminal. Confirm the listener
      and active child stop within the bounded shutdown path while Shipyard logs
      and worktrees remain available for inspection.
- [ ] Start again and confirm stale runner-owned work and abandoned transient
      state are cleaned, labelled backlog is found, and retained run evidence is
      not deleted.
- [ ] If safe for the test account, remove the GitHub runner registration to
      simulate extended-offline expiry, then start and confirm automatic
      re-registration uses the current administrative `gh` login.

## Removal

- [ ] Run `npx shipyard runner remove`; confirm the foreground process stops, the
      GitHub registration disappears, and protected local runner directories are
      deleted while config, environment, workflow, label, issues, logs, and
      worktrees remain.
- [ ] In a fresh disposable installation, temporarily make GitHub unregistration
      fail. Confirm normal removal preserves local state. Then run
      `npx shipyard runner remove --force`, confirm local deletion, and follow the
      printed instruction to remove the orphaned registration manually in GitHub.

## Automated evidence before the live trial

Run from the Shipyard source repository:

```sh
npm run check
npm pack --dry-run
```

The focused repository-runner suites cover installation, workflow generation,
controller draining, lifecycle recovery/removal, status, and sandbox credential
boundaries through fakes. Attach command output and any live-trial deviations to
the delivery issue.
