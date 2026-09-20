# Additional built-in agent providers

Shipyard does not grow the set of **built-in** agent providers on request. The shipped list (Claude Code and Codex) is deliberately curated.

## Why this is out of scope

Every built-in provider is a standing maintenance commitment: its CLI surface, JSON stream format, auth model, and session-capture behaviour all have to be tracked as that tool evolves, and each one is covered by tests in the repo. Expanding the built-in list to cover every agent CLI in the ecosystem grows that surface faster than it can be kept correct.

Built-in providers must support non-interactive run mode, prompts via stdin, a bypass-permissions flag, environment-based authentication, and line-delimited JSON stream events. These capabilities let Shipyard drive agents unattended inside a sandbox and display their output live.

Crucially, **a built-in provider is not required to use an agent with Shipyard.** `AgentProvider` is a public, exported interface (`src/AgentProvider.ts`, re-exported from `src/index.ts`). Anyone who wants to run another agent can implement that interface in their own project and pass it as the `agent` — no change to Shipyard is needed. The long tail of agent CLIs lives there, behind the public seam, rather than in the curated built-in set.

This applies equally to routing variants of an already-supported CLI. Pointing the `claude` binary at a different backend (Vertex, Bedrock, a gateway) is environment/config plumbing the user can supply through their own `AgentProvider` wrapper or env injection; it does not need a dedicated built-in factory.
