# Changelog

## 0.5.0

### Minor Changes

- 24936fc: Organize default run logs into `.shipyard/logs/YYYY-MM-DD/` folders by local calendar date.
- 24936fc: Add `shipyard runner purge` for manual removal of all managed run logs and automatic eight-day retention.
- dac16eb: Add the Apple Silicon macOS repository runner for immediate GitHub label and manual wake-ups, with foreground lifecycle commands, safe finite backlog draining, protected runner state, and the fixed lowercase `shipyard` activation label.

### Patch Changes

- 24936fc: Reject NUL bytes consistently when building agent commands.
- 24936fc: Default interactive repository-runner installation to Yes during `shipyard init`,
  show determinate terminal progress while the runner is installed, and print
  concise init next steps with subscription login commands. Include `GH_REPO` in
  the generated `.env.example`.
- 24936fc: Document the bundled workflow templates and their default scheduling limits in the README.
- 24936fc: Create `.shipyard/.env` from the generated example during `shipyard init` and
  direct users to fill in their credentials there.
- 24936fc: Keep repository-runner workflow validation on the host's administrative GitHub
  login instead of the issue-agent token, and explain denied workflow access.
- 24936fc: Rewrite the README around Shipyard's autonomous, Docker-protected workflow
  value proposition and streamline installation guidance.
- 24936fc: Prevent parallel issue workflows from retrying completed branches indefinitely when a run creates no new commit.
- 24936fc: Allow `shipyard runner stop` to stop a live recorded controller from another
  terminal when its stored process identity is stale.

## 0.4.4

### Patch Changes

- f8f4f64: Fix the release smoke check so it checks out the candidate repository before running the package smoke script.

## 0.4.3

### Patch Changes

- a1dcb11: Allow blank declared environment placeholders to fall back to host process environment variables, so GitHub CLI authentication can be forwarded with `GH_TOKEN="$(gh auth token)" npx shipyard run` without storing the token.

## 0.4.2

### Patch Changes

- c6a4446: Ask Codex users to choose ChatGPT sign-in or API-key authentication during interactive init.

## 0.4.1

### Patch Changes

- f53943b: Verify the automated package version bump and release flow.

## 0.4.0

### Minor Changes

- f61b3a9: Remove Beads and custom issue-tracker choices from `shipyard init`.

## 0.3.1

### Patch Changes

- b434341: Clarify `shipyard init` authentication next steps, including subscription login and API-key fallbacks for Codex and Claude Code.

## 0.3.0

### Minor Changes

- 2f331a8: Require Node.js 20.18.1 or newer and harden interactive cancellation, synchronization, workflow coordination, review authorization, release verification, and package/release validation.

## 0.2.0

### Minor Changes

- 642b428: Publish Shipyard from the `snappedly-tools` npm organization.
