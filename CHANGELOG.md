# Changelog

## 0.9.0

### Minor Changes

- b8b8950: Make GitHub Issues the fixed init tracker, build the Docker image automatically,
  and require repository-runner installation before init completes.
- b8b8950: Add `shipyard uninstall` to remove repository setup, the optional runner, and the package dependency.
- b8b8950: Require atomic triage-store writes and reclaim started dispatches without an expiry.
- b8b8950: Add dedicated workflow and integration package entrypoints, PostgreSQL-backed durable triage and repair stores, and shared prompt and sandbox run preparation.
- b8b8950: Offer to commit and push generated Shipyard setup during init. Pass the
  detected GitHub repository directly to sandbox setup.
- b8b8950: Show one progress bar across Shipyard initialization, advancing through setup stages and pausing while prompts are active.

## 0.8.0

### Minor Changes

- c10ce96: Show phase progress while scaffolding the `.shipyard/` configuration directory.
- c10ce96: Support Docker-only sandbox execution. Remove the no-sandbox and Vercel providers, host and bind-mount execution paths, and obsolete runner sandbox mask management.
- c10ce96: Parallel planner workflows use the routine model for ticket work and the strong model for planning, integration, and spec review.
- c10ce96: Ask before removing existing GitHub repository runner registrations during interactive installs, then retry installation.
- c10ce96: Remove the blank init template and default to the simple-loop workflow.
- c10ce96: Run bundled standalone and spec issue workflows with Snappedly skills in Docker. Provision GitHub workflow labels, mark selected tickets pending until completion or a block, and integrate their work into one spec pull request. Derive spec and PR status from child tickets, include tickets linked through the PR, block invalid selected relationships, allow a cleared blocked ticket to retry independently, and avoid rerunning completed standalone issues.
- c10ce96: Select routine and strong models from repository policy for coordinator phase attempts.
- c10ce96: Generated simple-loop and sequential-reviewer workflows can select routine and strong models for Codex or Claude Code.
- c10ce96: Run triage when Shipyard takes an activated ticket, require both activation and agent-ready labels before implementation, and block non-ready triage outcomes.

### Patch Changes

- c10ce96: Make the README quick start easier to follow, correct the Snappedly skills setup command, and link to the detailed issue-runner guide.
- c10ce96: Apply Codex role models and reasoning effort values from generated workflow
  environment files. Reject persisted agent selections that do not match trusted
  policy.
- c10ce96: Clarify automated runner use in the README and fix its Markdown formatting.
- c10ce96: Handle local branch namespace conflicts in parallel planner templates, offering a stable alternate branch or safe deletion of merged, unused conflicting refs.

## 0.7.0

### Minor Changes

- 0a7542c: Run bundled standalone and spec issue workflows with Snappedly skills in Docker. Provision GitHub workflow labels, mark selected tickets pending until completion or a block, and integrate their work into one spec pull request. Derive spec and PR status from child tickets, include tickets linked through the PR, block invalid selected relationships, allow a cleared blocked ticket to retry independently, and avoid rerunning completed standalone issues.
- 5a2b8be: Run triage when Shipyard takes an activated ticket, require both activation and agent-ready labels before implementation, and block non-ready triage outcomes.

### Patch Changes

- cf9001f: Make the README quick start easier to follow, correct the Snappedly skills setup command, and link to the detailed issue-runner guide.

## 0.6.0

### Minor Changes

- 0a7542c: Run bundled standalone and spec issue workflows with Snappedly skills in Docker. Provision GitHub workflow labels, mark selected tickets pending until completion or a block, and integrate their work into one spec pull request. Derive spec and PR status from child tickets, include tickets linked through the PR, block invalid selected relationships, allow a cleared blocked ticket to retry independently, and avoid rerunning completed standalone issues.
- 5a2b8be: Run triage when Shipyard takes an activated ticket, require both activation and agent-ready labels before implementation, and block non-ready triage outcomes.

### Patch Changes

- cf9001f: Document the Snappedly skills setup prerequisite in the README.

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
