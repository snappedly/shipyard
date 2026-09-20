# Security evaluation — 2026-09-19

Scope: Shipyard CLI/library and documentation package at `aa7fa54`, plus the
patches tracked in [issue #32](https://github.com/snappedly/shipyard/issues/32).
Assessment combines source review, independent security reviews, dependency
advisories, and regression tests at existing public boundaries. It is not a
production penetration test or a guarantee that no vulnerabilities remain.

## Trust boundaries reviewed

- CLI/configuration, prompt substitution/expansion, host command execution,
  environment resolution, logs, worktree copies and lifecycle.
- Docker/Podman mounts, isolated-provider sync-in/sync-out, agent sessions and
  filesystem path validation.
- GitHub HMAC authentication, payload limits, delivery deduplication, intake
  authorization, coordinator leases, publication, handoff and release gates.
- Root and docs dependency lockfiles, CI token permissions, and the docs search
  route. The docs site delegates search to Fumadocs and renders repository MDX;
  no application-owned login/session or user-upload endpoint was found.

## Confirmed findings and remediation

Severity describes impact under the stated preconditions, not a formal CVSS score.

| Finding                                                      | Severity / prerequisite                                                 | Remediation and regression evidence                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Copied session symlink follows a host path                   | High; compromised sandbox controls its session file                     | `AgentProvider.ts` rejects nonregular artifacts and opens with `O_NOFOLLOW`, checking the descriptor before reading. A provider that copies a symlink to a host sentinel now fails.                                                                                                                                                                                                                                                                 |
| Untracked sync-out can write Git metadata                    | High; compromised sandbox forges its Git output                         | `syncOut.ts` rejects administrative paths before saving/applying artifacts; includes case, trailing-dot, NTFS short-name/stream and HFS aliases. Tests cover `.git/config`, `.GIT/config`, nested `.git`, trailing-dot and short-name paths. Git retains its own patch-path validation.                                                                                                                                                             |
| Log replacement redirects subsequent host writes             | High; agent can replace a bind-mounted log path during a run            | `FileDisplay` holds one scoped file descriptor, opens without following a final symlink, checks regular-file type, and applies permissions through that descriptor. Replacing the path with a symlink no longer changes the target of subsequent writes.                                                                                                                                                                                            |
| Unauthenticated webhook reserves a delivery ID               | Medium; public webhook intake                                           | Invalid signatures and oversized requests no longer enter the authoritative delivery store; JSON parsing follows authentication. A valid delivery after a forged same-ID request is accepted. This also prevents retaining unauthenticated attacker payloads.                                                                                                                                                                                       |
| Cancellation during reconciliation fails to stop publication | High; control changes while remote reconciliation is awaited            | Coordinator rechecks job control, repository stop, candidate binding, lease and effect claim immediately before publication. Cancel, pause and repository-stop regressions prove the publisher stays uncalled.                                                                                                                                                                                                                                      |
| Release approval reused across repositories or environments  | High; integrations share a release store                                | Release-state and deployment idempotency keys bind candidate, repository, staging/production names and gate policy. Policy is cloned on construction. Tests block cross-repository, cross-environment, changed approval-role and changed required-check reuse. Existing candidate-only records intentionally require fresh evidence.                                                                                                                |
| Vulnerable docs transitive dependency                        | Moderate upstream advisory; application exploitability not demonstrated | Updated `baseline-browser-mapping` from 2.10.10 to 2.11.25. The [advisory](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv) identifies process termination on invalid input and fixes versions from 2.11.0.                                                                                                                                                                                                                                       |
| Writable Git metadata shared by Docker/Podman                | High; malicious sandbox agent                                           | Built-in providers now use sandbox-owned Git storage and validated sync-back. Live Docker tests plant malicious hooks/config, verify unchanged host metadata and no host sentinel execution, transfer committed/dirty/untracked changes, and exercise default merge-back cleanup. Provider tests assert no automatic mounts; isolated session capture/resume and private copy-in are covered. User approved the compatibility change; see ADR 0021. |
| Synced tracked files activate host Git callbacks             | High; host repository config points hooks/drivers into mutable files    | All internal host Git calls override hooks, fsmonitor, editors, signing, pagers, maintenance and submodule recursion. Configured filter, diff and merge driver names are discovered and replaced with inert or fail-closed commands. Exploit tests cover `post-applypatch`, `post-checkout`, fsmonitor, clean/smudge/process filters, merge drivers and worktree creation.                                                                          |

Each behavioral regression was observed failing on the vulnerable implementation
before its fix. The existing security changeset was extended to avoid a duplicate.

## Remaining trust requirements and limits

1. Built-in Docker/Podman now isolate Git metadata. **Custom bind-mount providers
   still require trusted agents/repositories**: writable shared Git metadata can
   alter host hooks/config. Explicit host mounts, Docker sockets and devices
   remain operator-granted capabilities; do not grant them to hostile agents.
2. Host hooks, TypeScript entrypoints, no-sandbox commands, templates and shell
   expressions are operator-authorized code. Prompt arguments interpolated inside
   a template shell expression are shell source; do not supply untrusted values
   there. Argument values outside shell expressions cannot introduce new ones.
3. Credentials granted to an agent are readable by that agent, even through a
   read-only mount. Mounts, Docker sockets, devices, network access and historical
   repository contents broaden access. Isolated sync-in currently bundles all
   refs; do not store secrets in repository history.
4. Stop/cancel checks prevent the demonstrated reconciliation race, but cannot
   retract a remote request already in flight. Transports must enforce fencing,
   current candidate identity, idempotency and deployment approval at the remote
   boundary. Approval actors and verification records are trusted adapter inputs;
   callers must authenticate them. No production adapter/deployment was exercised.
5. Symlink checks on multi-component paths do not provide a universal defense
   against a hostile process concurrently replacing parent directories. Keep host
   roots private. Descriptor pinning closes the demonstrated log replacement;
   the sandbox transfer temporary directory is private. Resource exhaustion by
   permitted agent workloads still requires sandbox/host quotas and ingress
   rate/body limits before buffering webhook bodies.
6. Live Docker was exercised with a purpose-built Git image. No live Podman,
   cloud sandbox, PostgreSQL service, Windows filesystem, or deployed
   documentation endpoint was exercised. Other tests use local Git and provider/storage seams. The nested `cp -R` symlink concern did not reproduce on
   macOS and is not reported as a confirmed vulnerability.

## Validation

The initial seven fixes passed `npm run check` (70 test files, 1,582 passed,
two Windows-only skips), the docs build, both dependency audits, and independent
Standards/Spec review. The user then approved isolated Docker/Podman Git storage.
Final validation covers that additional implementation, including opt-in live
Docker tests in `src/sandboxes/container-isolation.test.ts`.

To run the real engine checks, supply `SHIPYARD_TEST_DOCKER_IMAGE` or
`SHIPYARD_TEST_PODMAN_IMAGE` naming a local image with Git, an agent home at
`/home/agent` owned by UID/GID 1000, and a long-running default command (for Docker).
Then run `npm test -- src/sandboxes/container-isolation.test.ts`.

The final `npm run check`, with the live Docker image enabled, passed 72 test
files and 1,598 tests with four platform/Podman skips. The documentation build
and both package audits passed with zero known vulnerabilities. Independent
Standards and Spec re-review reported no blocking findings. Infrastructure
limits above remain regardless of passing checks.
