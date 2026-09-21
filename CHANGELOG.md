# Changelog

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
