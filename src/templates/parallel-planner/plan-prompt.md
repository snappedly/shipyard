# Activated issue scopes

<issues-json>
!`node .shipyard/select-issues.mjs`
</issues-json>

Use exactly these resolved scopes as the ready frontier. Their complete parent and child bodies, native dependencies, and deterministic branches are included. For planning specs, follow `/implement-spec` when planning the whole scope, honoring child dependencies and overlapping files. The surrounding template will run ready child tickets in parallel with scoped `/implement` workers, integrate each dependency wave into one spec branch, then perform whole-spec cleanup, review, and one PR handoff. Do not omit linked tickets, invent scope IDs, create PRs, merge to target, or close issues.

Emit each selected scope once, by its parent or standalone ID. If no scope is ready, emit an empty array:

<plan>{"issues":[{"id":"42"}]}</plan>
