import { afterEach, describe, expect, it, vi } from "vitest";

const ENV_NAMES = [
  "SHIPYARD_ROUTINE_REASONING_EFFORT",
  "SHIPYARD_STRONG_REASONING_EFFORT",
  "SHIPYARD_CODEX_ROUTINE_MODEL",
  "SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT",
  "SHIPYARD_CODEX_STRONG_MODEL",
  "SHIPYARD_CODEX_STRONG_REASONING_EFFORT",
] as const;

afterEach(() => {
  for (const name of ENV_NAMES) delete process.env[name];
  vi.resetModules();
});

describe("CODEX_MODELS", () => {
  it("uses shared role effort settings ahead of legacy Codex settings", async () => {
    process.env.SHIPYARD_ROUTINE_REASONING_EFFORT = "max";
    process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "low";
    process.env.SHIPYARD_STRONG_REASONING_EFFORT = "high";
    const { CODEX_MODELS } = await import("./modelConfig.js");

    expect(CODEX_MODELS.routine.effort).toBe("max");
    expect(CODEX_MODELS.strong.effort).toBe("high");
  });

  it("allows deployments to override model and effort per role", async () => {
    process.env.SHIPYARD_CODEX_ROUTINE_MODEL = "routine-override";
    process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "high";
    process.env.SHIPYARD_CODEX_STRONG_MODEL = "strong-override";
    process.env.SHIPYARD_CODEX_STRONG_REASONING_EFFORT = "xhigh";
    const { CODEX_MODELS } = await import("./modelConfig.js");

    expect(CODEX_MODELS).toEqual({
      routine: { model: "routine-override", effort: "high" },
      strong: { model: "strong-override", effort: "xhigh" },
    });
  });

  it("rejects an unsupported reasoning effort", async () => {
    process.env.SHIPYARD_CODEX_STRONG_REASONING_EFFORT = "turbo";
    await expect(import("./modelConfig.js")).rejects.toThrow(
      "SHIPYARD_CODEX_STRONG_REASONING_EFFORT must be one of low, medium, high, xhigh, max",
    );
  });
});
