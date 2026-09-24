# Model routing for Shipyard issue 81

Researched 24 September 2026. This note supports [issue 81](https://github.com/snappedly/shipyard/issues/81).

## Existing behavior

Shipyard already accepts an `AgentProvider` on each `run()` call. Its bundled Codex workflows use `CODEX_MODELS.routine` for implementation and `CODEX_MODELS.strong` for triage, planning, review, conflict resolution, and integration. The two role defaults are `gpt-5.6-luna` and `gpt-5.6-sol`; both use `max` reasoning effort. Host environment variables override each role's model and effort. `shipyard init --model` with a nondefault model replaces all generated role references with that single model. These facts follow from [`src/run.ts`](../../src/run.ts), [`src/modelConfig.ts`](../../src/modelConfig.ts), the [bundled templates](../../src/templates), and [`rewriteMainTs`](../../src/InitService.ts).

This is partial routing, not a complete cost policy. The templates assign the strong role to every triage and planner invocation, including routine cases. Generated Claude Code workflows lose the two-role distinction because initialization rewrites every factory call to the selected model. Shipyard records per-iteration token usage where providers report it, but the generated workflows do not aggregate usage by phase, model, or issue. See [`src/AgentProvider.ts`](../../src/AgentProvider.ts), [`src/InitService.ts`](../../src/InitService.ts), and [`docs/content/docs/configuration.mdx`](../content/docs/configuration.mdx).

## External evidence

- [OpenAI's model selection guide](https://developers.openai.com/api/docs/guides/model-selection) places scoped edits and simple extraction with a low-cost model, everyday coding with a middle model, and demanding analysis with a high-capability model. It recommends comparing representative tasks and keeping the least costly setting that meets the quality bar. That supports a task policy, not a fixed brand or model name.
- [OpenAI's model and provider guidance](https://developers.openai.com/api/docs/guides/agents/models) recommends explicit per-agent models when specialists need different cost or quality profiles. The [multi-agent guide](https://developers.openai.com/api/docs/guides/responses-multi-agent) warns that subagents can increase token use and are a poor fit for short or dependent tasks. Its hosted Responses API subagents share the request model, so that API's native fan-out does not itself establish mixed-model savings.
- [OpenAI's current pricing](https://developers.openai.com/api/docs/pricing) shows a large per-token gap between GPT-6 Astra and Luna, but total cost depends on input, cached input, output, cache writes, retries, and task completion. API rates are not a measure of subscription consumption. The [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) says lower effort favors speed and token use, so Shipyard's `max` defaults deserve measurement rather than automatic preservation.
- The [Astra Flash Orchestrator](https://github.com/ethanplusai/astra-flash-orchestrator) uses a strong planner and reviewer around a cheaper implementation worker. Its [benchmark](https://github.com/ethanplusai/astra-flash-orchestrator/blob/main/docs/BENCHMARK.md) is one field build with different task mixes and an API-equivalent cost estimate. It is a useful workflow example, not a transferable savings forecast.

## Recommended policy

Keep two configurable roles, `routine` and `strong`, rather than naming specific models in workflow logic. Resolve the selected agent provider, model identifier, and supported reasoning effort before dispatch. Reuse the existing `AgentProvider` interface. Preserve current Codex environment overrides and explicit `codex(model, options)` calls. Generated workflows should retain role assignments for both Codex and Claude Code, and `init --model` needs a documented meaning that does not silently flatten them.

| Procedure                                                                                | Initial role | Escalate when                                                          |
| ---------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------- |
| Repository discovery, factual extraction, duplicate search, and evidence formatting      | Routine      | Evidence conflicts or a decision changes scope or authorization        |
| Triage of a clear request                                                                | Routine      | Acceptance criteria, security, policy, or product intent are ambiguous |
| Scoped implementation, focused tests, debugging, and repair of review findings           | Routine      | A bounded attempt fails or the change crosses a high-risk boundary     |
| Whole-spec scope and dependency decisions, architecture, and risky implementation design | Strong       | Already strong; stop for a missing product decision                    |
| Independent review of substantial or risky changes and final acceptance                  | Strong       | Already strong; deterministic checks remain authoritative              |
| Nontrivial conflict resolution and integration decisions                                 | Strong       | Already strong; ordinary clean integration needs no model call         |

Risk and uncertainty matter more than phase names alone. A low-risk change needs local review under [`docs/agents/workflow.md`](../agents/workflow.md); do not pay for a strong review call simply because a reviewer phase exists. Conversely, a small edit touching credentials or data integrity warrants stronger judgment. A failed routine worker may escalate once with a concise handoff, its attempted commands, and the exact blocker. Repeated retries without new evidence waste tokens. The coordinator retains routing and budget authority; an agent does not promote itself or silently spawn expensive descendants.

Begin with explicit Shipyard `run()` phases. Native subagents inside a provider have separate controls and accounting. Do not claim that a mixed-model policy covers them until that provider can select their model and report their usage. Bound or disable nested delegation where supported; otherwise report its cost as unknown. [`docs/adr/0018-fork-is-session-only.md`](../adr/0018-fork-is-session-only.md) also requires distinct branches for concurrent writing forks.

[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference) exposes `agents.enabled=false`, and [Claude Code's CLI](https://docs.anthropic.com/en/docs/claude-code/cli-usage) exposes `--disallowedTools Agent`. Generated workflows use these controls to disable built-in subagents. This does not meter an agent that launches another CLI process through a shell command.

Measure cost per accepted task on the same representative issues, along with required-check success, review findings, repair count, elapsed time, and manual intervention. Record actual usage by issue, phase, resolved provider/model/effort, and child run. Calculate estimated API cost only when an operator supplies a price table that matches the billing path; keep missing usage or price data unknown. Compare with a single-model baseline before changing defaults.
