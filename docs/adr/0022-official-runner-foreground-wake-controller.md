# Official runner with a foreground wake controller

## Context

A self-hosted deployment must react quickly when the lowercase `shipyard`
activation label is added, recover labelled tasks after the host was offline,
and preserve each repository's existing `npx shipyard run` behavior. The first
supported host is Apple Silicon macOS. The deployment must not require a public
inbound endpoint, third-party coordinator, always-on login service, or an
Actions job that remains alive for the complete agent lifecycle.

## Decision

Use GitHub's official repository-level self-hosted Actions runner to deliver
wake-up triggers to one foreground repository runner. The generated workflow
accepts only an exact lowercase label event or manual dispatch and signals the
foreground controller. It performs no checkout and starts no agent.

The controller performs a GitHub backlog preflight at startup and after every
wake-up. When work exists it invokes the repository's unchanged `npx shipyard
run` entrypoint outside the Actions job. After a successful invocation it
compares eligible issue-number sets: empty means idle, changed means another
finite invocation, and unchanged means no progress and idle. The Actions run
therefore proves wake delivery, not completion of Shipyard work.

The controller is deliberately foreground-only. Its terminal is the ownership
and observation boundary; Ctrl-C, terminal closure, and explicit stop share the
shutdown path. Each repository has its own registration and protected runtime
directory. Installation and recovery obtain one-time tokens through the current
administrative `gh` login, while repository and agent runtime credentials remain
separate. An operator-supplied one-time token can replace token issuance, but
not the administrative runner-list access used to enforce the one-runner
invariant.

## Alternatives

- **Custom webhook receiver:** rejected for this release because it requires an
  authenticated public ingress path, delivery persistence, and another network
  service to secure and operate.
- **Continuous polling daemon:** rejected because it adds idle GitHub traffic,
  slower detection or aggressive polling, and daemon lifecycle state. A startup
  preflight still provides missed-event recovery without making polling the
  wake mechanism.
- **Login service or launch daemon:** rejected because the operator wants manual
  foreground ownership. Shipyard must stop when its terminal closes and must not
  start automatically at login.
- **Actions-owned agent lifecycle:** rejected because an Actions job would own
  the long-running agent process and its timeout. It would also conflate wake
  delivery with the repository-defined Shipyard outcome. Actions remains a
  short-lived transport instead.

## Consequences

Wake-up latency follows GitHub Actions scheduling and requires the foreground
controller and Mac to be available. Startup preflight recovers labelled tasks
missed while offline, but there is no sleep detector; an operator must manually
dispatch or restart after GitHub's queue lifetime. GitHub may remove an extended
offline registration, so start repairs a missing registration using current
administrative authority.

The official runner retains its update behavior. GitHub does not charge Actions
minutes for the self-hosted wake job, but the brief `ubuntu-latest` exact-case
gate may consume hosted minutes for private repositories. Shipyard owns
controller state, no-progress safety, diagnostics, and cleanup. Public
repositories inherit GitHub's elevated self-hosted runner risk.
The design is intentionally repository-scoped and does not preclude a future
hosted coordinator.
