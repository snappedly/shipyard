# Docker-only sandbox execution

## Context

Shipyard runs agents in Docker with a sandbox-owned Git repository. The older bind-mount and host-execution paths still shaped provider contracts, runner setup, tests, and package exports. They included a runner sandbox mask that hid runner files from bind-mounted workspaces. Docker's Git bundle sync already excludes those files.

## Decision

Support Docker as the sole process sandbox. Keep the isolated filesystem provider contract used by Docker and Git sync. Remove the no-sandbox and Vercel providers, bind-mount provider contracts and Git mount repair, the `head` branch strategy, and runner sandbox mask management. Explicit user mounts remain available for Docker and cannot replace the sandbox workspace.

This supersedes ADR 0015 and the worktree Git mount implementation in ADR 0006. Their historical rationale remains recorded there.

## Consequences

- `run()`, `interactive()`, `createSandbox()`, and `createWorktree()` require a Docker-style isolated provider.
- `merge-to-head` and `branch` remain the branch strategies. The default is `merge-to-head`.
- Worktree contents enter Docker through Git sync; selected untracked or ignored files require `copyToWorktree`.
- Package subpath exports contain only Docker.
