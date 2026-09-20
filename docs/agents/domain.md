# Domain docs

How Snappedly skills consume this repository's shared vocabulary and architectural decisions.

## Before exploring

- Read `CONTEXT.md` at the repo root.
- Read ADRs in `docs/adr/` that touch the area being changed.
- This is a single-context repository; no `CONTEXT-MAP.md` or context-scoped ADR directory is used.

If these files do not exist, proceed with the repository's available context. The domain-modeling workflow creates them when a term or decision needs to be recorded.

## File structure

```text
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-per-step-timeouts.md
│   └── 0002-cwd-option.md
└── src/
```

## Use the glossary

When an output names a domain concept, use the term defined in `CONTEXT.md`. Keep the project's chosen term when the glossary avoids a synonym. If the needed concept is missing, flag the gap for the domain-modeling workflow instead of inventing a competing term.

## Respect ADRs

When a proposed change conflicts with an ADR, surface the conflict explicitly and identify the ADR. Continue only after deciding whether to follow or reopen it.
