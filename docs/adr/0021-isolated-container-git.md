# Docker and Podman own their Git storage

Docker and Podman now use the isolated sandbox provider contract: copy committed
history through a Git bundle, run against sandbox-owned Git storage, then apply
validated patches and untracked files on the host. Writable host Git metadata
allowed an agent to plant hooks/config that later host Git commands executed.
The user approved changing the shared-Git compatibility contract to close this
boundary during the security evaluation (#32, #33).

This supersedes automatic Git bind mounts for the built-in Docker/Podman
providers, including ADR 0006's Windows mount path. Custom bind-mount providers
retain that contract. The alternative of disabling selected Git hooks was
rejected because Git configuration supports additional execution paths.
Shipyard still disables hooks and other configurable Git command callbacks for
its own host-side sync, checkout, worktree, and merge operations. This is a
second boundary: isolated commits and attributes remain untrusted when Git
applies them to a host worktree.

Docker/Podman default to `merge-to-head` and reject `head`. Input history must be
committed; `copyToWorktree` transfers selected additional files from the original
repository. Explicit mounts cannot overlap the sandbox workspace or its
ancestors. Images are still named from the original host repository. Agent
session storage remains provider-owned (ADR 0012), using an adapter from isolated
file transfers to the existing session interface. Copy-in assigns container-user
ownership without relaxing private file modes. Failed initialization closes its
sandbox; merge-back detaches the host worktree before deleting its source branch.
