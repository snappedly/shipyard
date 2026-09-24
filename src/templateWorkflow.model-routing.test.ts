import { describe, expect, it } from "vitest";
import {
  getCalls,
  loadEnvFile,
  runGeneratedWorkflow,
} from "./templateWorkflow.test-support.js";

const calls = getCalls();

describe("generated workflow model routing", () => {
  it("simple-loop uses the routine role for triage and implementation", async () => {
    await loadEnvFile(
      "SHIPYARD_ROUTINE_MODEL=file-routine\nSHIPYARD_STRONG_MODEL=file-strong\n",
      "SHIPYARD_ROUTINE_MODEL=root-file-model\n",
    );
    process.env.SHIPYARD_ROUTINE_MODEL = "host-routine";

    await import("./templates/simple-loop/main.mts" as string);

    expect(calls.agentInvocations).toEqual([
      {
        name: "triage #42",
        provider: "codex",
        model: "host-routine",
        effort: undefined,
      },
      {
        name: "implementer",
        provider: "codex",
        model: "host-routine",
        effort: undefined,
      },
    ]);
  });

  it("sequential-reviewer uses file role values unless the host overrides one", async () => {
    await loadEnvFile(
      "SHIPYARD_ROUTINE_MODEL=file-routine\nSHIPYARD_STRONG_MODEL=file-strong\n",
    );
    process.env.SHIPYARD_ROUTINE_MODEL = "host-routine";

    await import("./templates/sequential-reviewer/main.mts" as string);

    expect(calls.agentInvocations).toEqual([
      {
        name: "triage #42",
        provider: "codex",
        model: "host-routine",
        effort: undefined,
      },
      {
        name: "implementer",
        provider: "codex",
        model: "host-routine",
        effort: undefined,
      },
      {
        name: "reviewer",
        provider: "codex",
        model: "file-strong",
        effort: undefined,
      },
    ]);
  });

  it("runs a generated Claude workflow with its selected provider and model roles", async () => {
    process.env.SHIPYARD_STRONG_MODEL = "host-review-model";

    await runGeneratedWorkflow(
      "sequential-reviewer",
      "claude-code",
      "claude-opus-4-8",
      false,
      "SHIPYARD_ROUTINE_MODEL=sonnet\nSHIPYARD_STRONG_MODEL=opus\n",
    );

    expect(calls.agentInvocations).toEqual([
      {
        name: "triage #42",
        provider: "claude-code",
        model: "sonnet",
        effort: undefined,
      },
      {
        name: "implementer",
        provider: "claude-code",
        model: "sonnet",
        effort: undefined,
      },
      {
        name: "reviewer",
        provider: "claude-code",
        model: "host-review-model",
        effort: undefined,
      },
    ]);
  });

  it("does not load model values from the repository-root .env", async () => {
    await loadEnvFile("", "SHIPYARD_ROUTINE_MODEL=root-only-model\n");

    await import("./templates/simple-loop/main.mts" as string);

    expect(
      calls.agentInvocations.slice(0, 2).map((call) => call.model),
    ).toEqual(["routine-default", "routine-default"]);
  });

  it("uses Codex default effort for a new role model unless an effort is set", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "routine-default";

    await import("./templates/simple-loop/main.mts" as string);

    expect(calls.agentInvocations[0]).toEqual({
      name: "triage #42",
      provider: "codex",
      model: "routine-default",
      effort: undefined,
    });
  });

  it("applies an explicitly selected Codex effort to a role model", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "new-routine";
    process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "high";

    await import("./templates/simple-loop/main.mts" as string);

    expect(calls.agentInvocations[0]).toMatchObject({
      model: "new-routine",
      effort: "high",
    });
  });

  it("keeps existing Codex role model and effort overrides as fallbacks", async () => {
    process.env.SHIPYARD_CODEX_ROUTINE_MODEL = "legacy-routine";
    process.env.SHIPYARD_CODEX_STRONG_MODEL = "legacy-strong";
    process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "high";
    process.env.SHIPYARD_CODEX_STRONG_REASONING_EFFORT = "low";

    await import("./templates/sequential-reviewer/main.mts" as string);

    expect(calls.agentInvocations).toEqual([
      {
        name: "triage #42",
        provider: "codex",
        model: "legacy-routine",
        effort: "high",
      },
      {
        name: "implementer",
        provider: "codex",
        model: "legacy-routine",
        effort: "high",
      },
      {
        name: "reviewer",
        provider: "codex",
        model: "legacy-strong",
        effort: "low",
      },
    ]);
  });

  it("passes an unknown nonempty model value to the selected provider unchanged", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "future-alias:variant/unknown";

    await import("./templates/simple-loop/main.mts" as string);

    expect(
      calls.agentInvocations.slice(0, 2).map((call) => call.model),
    ).toEqual(["future-alias:variant/unknown", "future-alias:variant/unknown"]);
  });

  it("does not invoke another model after the provider rejects a configured value", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "unavailable-model";
    calls.providerFailureModel = "unavailable-model";

    await import("./templates/simple-loop/main.mts" as string);

    expect(calls.agentInvocations).toEqual([
      {
        name: "triage #42",
        provider: "codex",
        model: "unavailable-model",
        effort: undefined,
      },
    ]);
    expect(calls.blocked[0]?.reason).toContain(
      "Provider rejected model unavailable-model",
    );
  });

  it("rejects an empty configured role before any provider invocation", async () => {
    await loadEnvFile("SHIPYARD_STRONG_MODEL=   \n");

    await expect(
      import("./templates/sequential-reviewer/main.mts" as string),
    ).rejects.toThrow("SHIPYARD_STRONG_MODEL must not be empty");
    expect(calls.agentInvocations).toEqual([]);
  });

  it("routes reviewed spec work to the selected model roles", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "routine-choice";
    process.env.SHIPYARD_STRONG_MODEL = "strong-choice";
    calls.spec = true;

    await import("./templates/parallel-planner-with-review/main.mts" as string);

    expect(
      calls.agentInvocations.map(({ name, provider, model }) => [
        name,
        provider,
        model,
      ]),
    ).toEqual([
      ["planner", "codex", "strong-choice"],
      ["triage #43", "codex", "routine-choice"],
      ["implementer", "codex", "routine-choice"],
      ["reviewer", "codex", "strong-choice"],
      ["spec-integrator", "codex", "strong-choice"],
      ["triage #44", "codex", "routine-choice"],
      ["implementer", "codex", "routine-choice"],
      ["reviewer", "codex", "strong-choice"],
      ["spec-integrator", "codex", "strong-choice"],
      ["reviewer", "codex", "strong-choice"],
      ["merger", "codex", "strong-choice"],
    ]);
  });

  it("routes dependency-wave integration to the strong model without reviews", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "routine-choice";
    process.env.SHIPYARD_STRONG_MODEL = "strong-choice";
    calls.spec = true;

    await import("./templates/parallel-planner/main.mts" as string);

    expect(
      calls.agentInvocations.map(({ name, provider, model }) => [
        name,
        provider,
        model,
      ]),
    ).toEqual([
      ["planner", "codex", "strong-choice"],
      ["triage #43", "codex", "routine-choice"],
      ["implementer", "codex", "routine-choice"],
      ["spec-integrator", "codex", "strong-choice"],
      ["triage #44", "codex", "routine-choice"],
      ["implementer", "codex", "routine-choice"],
      ["spec-integrator", "codex", "strong-choice"],
      ["merger", "codex", "strong-choice"],
    ]);
  });

  it("reviews a changed integrated spec with the strong model before handoff", async () => {
    process.env.SHIPYARD_ROUTINE_MODEL = "routine-choice";
    process.env.SHIPYARD_STRONG_MODEL = "strong-choice";
    calls.spec = true;
    calls.finalChanges = true;

    await import("./templates/parallel-planner-with-review/main.mts" as string);

    const invocations = calls.agentInvocations.map(({ name, model }) => [
      name,
      model,
    ]);
    expect(invocations.filter(([name]) => name === "reviewer")).toEqual([
      ["reviewer", "strong-choice"],
      ["reviewer", "strong-choice"],
      ["reviewer", "strong-choice"],
      ["reviewer", "strong-choice"],
    ]);
    expect(invocations.slice(-3)).toEqual([
      ["reviewer", "strong-choice"],
      ["merger", "strong-choice"],
      ["reviewer", "strong-choice"],
    ]);
    expect(calls.events.lastIndexOf("reviewer")).toBeLessThan(
      calls.events.indexOf("handoff"),
    );
  });

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s preserves Claude role choices across a spec workflow",
    async (templateName) => {
      calls.spec = true;
      process.env.SHIPYARD_STRONG_MODEL = "host-strong";

      await runGeneratedWorkflow(
        templateName,
        "claude-code",
        "claude-opus-4-8",
        false,
        "SHIPYARD_ROUTINE_MODEL=sonnet\nSHIPYARD_STRONG_MODEL=opus\n",
      );

      expect(calls.agentInvocations.length).toBeGreaterThan(0);
      for (const invocation of calls.agentInvocations) {
        expect(invocation.provider).toBe("claude-code");
        expect(invocation.model).toBe(
          invocation.name.startsWith("triage #") ||
            invocation.name === "implementer"
            ? "sonnet"
            : "host-strong",
        );
      }
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s preserves Codex role overrides and init model fallback",
    async (templateName) => {
      calls.spec = true;
      process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "high";

      await runGeneratedWorkflow(
        templateName,
        "codex",
        "single-model",
        true,
        "SHIPYARD_ROUTINE_MODEL=host-routine\n",
      );

      expect(calls.agentInvocations.length).toBeGreaterThan(0);
      for (const invocation of calls.agentInvocations) {
        expect(invocation.provider).toBe("codex");
        const routine =
          invocation.name.startsWith("triage #") ||
          invocation.name === "implementer";
        expect(invocation.model).toBe(
          routine ? "host-routine" : "single-model",
        );
        if (routine) expect(invocation.effort).toBe("high");
        else expect(invocation.effort).toBeUndefined();
      }
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s keeps Codex role overrides when new role models are unset",
    async (templateName) => {
      process.env.SHIPYARD_CODEX_ROUTINE_MODEL = "legacy-routine";
      process.env.SHIPYARD_CODEX_STRONG_MODEL = "legacy-strong";
      process.env.SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT = "high";
      process.env.SHIPYARD_CODEX_STRONG_REASONING_EFFORT = "low";
      calls.spec = true;

      await import(`./templates/${templateName}/main.mts` as string);

      for (const invocation of calls.agentInvocations) {
        const routine =
          invocation.name.startsWith("triage #") ||
          invocation.name === "implementer";
        expect(invocation.provider).toBe("codex");
        expect(invocation.model).toBe(
          routine ? "legacy-routine" : "legacy-strong",
        );
        expect(invocation.effort).toBe(routine ? "high" : "low");
      }
    },
  );
});
