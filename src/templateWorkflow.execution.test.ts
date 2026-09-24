import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent, scaffold } from "./InitService.js";

const initialRepository = process.env.GH_REPO;
const initialCwd = process.cwd();
const modelEnvironmentNames = [
  "SHIPYARD_ROUTINE_MODEL",
  "SHIPYARD_STRONG_MODEL",
  "SHIPYARD_CODEX_ROUTINE_MODEL",
  "SHIPYARD_CODEX_STRONG_MODEL",
  "SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT",
  "SHIPYARD_CODEX_STRONG_REASONING_EFFORT",
] as const;
const initialModelEnvironment = Object.fromEntries(
  modelEnvironmentNames.map((name) => [name, process.env[name]]),
);
let envDirectory: string | undefined;

const calls = vi.hoisted(() => ({
  events: [] as string[],
  pendingEdits: [] as string[],
  triaged: [] as Array<{ id: string; beforeEvents: number }>,
  verified: [] as string[],
  triageReady: true,
  envFileExists: false,
  providerFailureModel: "",
  agentInvocations: [] as Array<{
    name: string;
    provider: string;
    model: string;
    effort?: string;
  }>,
  selected: 0,
  spec: false,
  multi: false,
  commands: [] as string[],
  localBranches: [] as string[],
  creates: [] as Array<{
    branch: string;
    baseBranch?: string;
    specContent: string[];
  }>,
  specContent: [] as string[],
  cherryPickSucceeds: true,
  conflictResolved: true,
  conflictIncludesTicket: true,
  resolverReportsComplete: true,
  emptyPlan: false,
  invocations: [] as Array<{
    name: string;
    branch: string;
    args: Record<string, string>;
  }>,
  plannerBranches: [] as string[],
  reviewApproved: true,
  implementationComplete: true,
  handoffSucceeds: true,
  handoffUncertain: false,
  handoffThrows: false,
  finalChanges: false,
  finalReviewApproved: true,
  reviewCount: 0,
  dirtyBranch: "",
  dirtyAfterConflict: false,
  blocked: [] as Array<{
    root: string;
    failed: string;
    scope: string;
    reason: string;
  }>,
}));

vi.mock("node:child_process", () => ({
  exec: () => undefined,
  execFileSync: (
    command: string,
    args: string[],
    options?: { input?: string },
  ) => {
    if (command === "git" && args[0] === "for-each-ref")
      return calls.localBranches.join("\n");
    if (command === "git") return "staging\n";
    if (command === "gh" && args[0] === "repo") return "owner/repo\n";
    if (command === "gh" && args[0] === "label") return "";
    if (command === "gh" && args[0] === "issue" && args[1] === "edit") {
      calls.pendingEdits.push(args[2]!);
      return "";
    }
    if (command === "bash" && args[0] === ".shipyard/block-scope.sh") {
      calls.events.push("blocked");
      calls.blocked.push({
        root: args[1]!,
        failed: args[2]!,
        scope: args[4]!,
        reason: options?.input ?? "",
      });
      return "";
    }
    if (command === "bash" && args[0] === ".shipyard/verify-triage.sh") {
      calls.verified.push(args[1]!);
      if (!calls.triageReady)
        throw Object.assign(new Error("Triage gate failed"), {
          stderr: "Issue cannot be implemented: triage state is needs-info",
        });
      return "";
    }
    if (command === "node" && args[0] === ".shipyard/select-issues.mjs") {
      calls.events.push("select");
      return JSON.stringify(
        calls.selected++ === 0
          ? calls.spec
            ? [
                {
                  id: "42",
                  title: "Spec",
                  body: "planning spec",
                  branch: "shipyard/spec-42",
                  kind: "spec",
                  tickets: [
                    {
                      id: "43",
                      title: "First",
                      body: "first",
                      state: "OPEN",
                      blockedBy: [],
                    },
                    {
                      id: "44",
                      title: "Second",
                      body: "second",
                      state: "OPEN",
                      blockedBy: [{ id: "43", title: "First", state: "OPEN" }],
                    },
                  ],
                },
              ]
            : [
                {
                  id: "42",
                  title: "Fix bug",
                  branch: "shipyard/issue-42",
                  kind: "standalone",
                },
                ...(calls.multi
                  ? [
                      {
                        id: "45",
                        title: "Another",
                        branch: "shipyard/issue-45",
                        kind: "standalone",
                      },
                    ]
                  : []),
              ]
          : [],
      );
    }
    throw new Error(`Unexpected ${command}`);
  },
}));
vi.mock("node:fs", () => ({
  existsSync: () => calls.envFileExists,
}));
vi.mock("@snappedly-tools/shipyard/sandboxes/docker", () => ({
  docker: () => ({}),
}));
vi.mock("@snappedly-tools/shipyard", () => {
  const packet = (text: string) => ({
    completionSignal: "<promise>COMPLETE</promise>",
    stdout: `<handoff>${text}</handoff>`,
    commits: [{ sha: "abc" }],
  });
  const sandbox = (branch: string) => {
    const pendingContent: string[] = [];
    let headReads = 0;
    return {
      run: async ({
        name,
        agent,
        promptArgs,
      }: {
        name: string;
        agent?: {
          name: string;
          model: string;
          effort?: string;
        };
        promptArgs?: Record<string, string>;
      }) => {
        if (agent) {
          calls.agentInvocations.push({
            name,
            provider: agent.name,
            model: agent.model,
            effort: agent.effort,
          });
          if (agent.model === calls.providerFailureModel)
            throw new Error(`Provider rejected model ${agent.model}`);
        }
        if (name.startsWith("triage #")) {
          calls.triaged.push({
            id: name.slice("triage #".length),
            beforeEvents: calls.events.length,
          });
          return packet("triage applied");
        }
        calls.events.push(name);
        calls.invocations.push({ name, branch, args: promptArgs ?? {} });
        if (name === "spec-integrator")
          calls.specContent.push(...pendingContent);
        if (name === "conflict-resolver") {
          if (calls.conflictResolved)
            pendingContent.push(calls.specContent.includes("43") ? "44" : "43");
          return calls.resolverReportsComplete
            ? packet("conflict resolved and checks passed")
            : { stdout: "conflict remains", commits: [] };
        }
        if (name === "implementer")
          return calls.implementationComplete
            ? packet("tests passed")
            : { stdout: "blocked", commits: [] };
        if (name === "reviewer") {
          calls.reviewCount++;
          return (
            calls.reviewCount > 1 && calls.finalChanges
              ? calls.finalReviewApproved
              : calls.reviewApproved
          )
            ? {
                ...packet("review approved"),
                stdout:
                  "<handoff>review approved</handoff><review>APPROVED</review>",
              }
            : { ...packet("finding"), stdout: "<handoff>finding</handoff>" };
        }
        if (name === "merger")
          return {
            ...packet("integration passed"),
            commits: calls.finalChanges ? [{ sha: "new" }] : [],
          };
        return packet("integration passed");
      },
      exec: async (command: string) => {
        calls.commands.push(command);
        if (command === "git rev-parse HEAD") {
          headReads++;
          return {
            exitCode: 0,
            stdout: (headReads > 1 && calls.conflictResolved
              ? "b"
              : "a"
            ).repeat(40),
            stderr: "",
          };
        }
        if (command.startsWith("git rev-list")) {
          calls.events.push("rev-list");
          return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
        }
        if (command.startsWith("git log --format=%B "))
          return {
            exitCode: 0,
            stdout: calls.conflictIncludesTicket
              ? `(cherry picked from commit ${"a".repeat(40)})`
              : "unrelated commit",
            stderr: "",
          };
        if (command === "git ls-files -u")
          return {
            exitCode: 0,
            stdout: calls.conflictResolved ? "" : "unmerged",
            stderr: "",
          };
        if (command === "git status --porcelain")
          return {
            exitCode: 0,
            stdout: calls.conflictResolved ? "" : "UU file",
            stderr: "",
          };
        if (command === "git rev-parse -q --verify CHERRY_PICK_HEAD")
          return {
            exitCode: calls.conflictResolved ? 1 : 0,
            stdout: "",
            stderr: "",
          };
        if (command.includes("cherry-pick")) {
          calls.events.push("cherry-pick");
          if (!calls.cherryPickSucceeds)
            return { exitCode: 1, stdout: "", stderr: "conflict" };
          pendingContent.push(calls.specContent.includes("43") ? "44" : "43");
          return { exitCode: 0, stdout: "integrated", stderr: "" };
        }
        calls.events.push("handoff");
        if (calls.handoffThrows)
          throw new Error("transport lost during PR handoff");
        return {
          exitCode: calls.handoffUncertain ? 75 : calls.handoffSucceeds ? 0 : 1,
          stdout: "https://example.test/pr/1",
          stderr: calls.handoffUncertain
            ? "Could not confirm PR readiness"
            : calls.handoffSucceeds
              ? ""
              : "push failed",
        };
      },
      close: async () => {
        calls.events.push("close");
        return {
          preservedWorktreePath:
            calls.dirtyBranch === branch &&
            (!calls.dirtyAfterConflict ||
              calls.events.includes("conflict-resolver"))
              ? `/tmp/${branch}`
              : undefined,
        };
      },
    };
  };
  const codexModel = (role: "routine" | "strong") => ({
    model:
      process.env[`SHIPYARD_CODEX_${role.toUpperCase()}_MODEL`]?.trim() ||
      `${role}-default`,
    effort:
      process.env[
        `SHIPYARD_CODEX_${role.toUpperCase()}_REASONING_EFFORT`
      ]?.trim() || "max",
  });
  const makeAgent = (
    name: string,
    model: string | { model: string; effort: string },
    options?: { effort?: string | null },
  ) => ({
    name,
    model: typeof model === "string" ? model : model.model,
    effort:
      options?.effort === null
        ? undefined
        : (options?.effort ??
          (typeof model === "string" ? undefined : model.effort)),
  });
  return {
    CODEX_MODELS: {
      get routine() {
        return codexModel("routine");
      },
      get strong() {
        return codexModel("strong");
      },
    },
    codex: (
      model: string | { model: string; effort: string },
      options?: { effort?: string | null },
    ) => makeAgent("codex", model, options),
    claudeCode: (model: string, options?: { effort?: string | null }) =>
      makeAgent("claude-code", model, options),
    Output: { object: () => ({}) },
    createSandbox: async ({
      branch,
      baseBranch,
    }: {
      branch: string;
      baseBranch?: string;
    }) => {
      calls.creates.push({
        branch,
        baseBranch,
        specContent: [...calls.specContent],
      });
      return sandbox(branch);
    },
    run: async ({
      name,
      branchStrategy,
    }: {
      name: string;
      branchStrategy?: { branch?: string };
    }) => {
      calls.events.push(name);
      if (name === "planner") {
        calls.plannerBranches.push(branchStrategy?.branch ?? "");
        return {
          output: {
            issues: calls.emptyPlan
              ? []
              : [{ id: "42" }, ...(calls.multi ? [{ id: "45" }] : [])],
          },
        };
      }
      return calls.implementationComplete
        ? packet("tests passed")
        : { stdout: "blocked", commits: [] };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  for (const name of modelEnvironmentNames) delete process.env[name];
  envDirectory = undefined;
  calls.events.length = 0;
  calls.pendingEdits.length = 0;
  calls.triaged.length = 0;
  calls.verified.length = 0;
  calls.triageReady = true;
  calls.envFileExists = false;
  calls.providerFailureModel = "";
  calls.agentInvocations.length = 0;
  calls.selected = 0;
  calls.spec = false;
  calls.multi = false;
  calls.commands.length = 0;
  calls.localBranches.length = 0;
  calls.creates.length = 0;
  calls.specContent.length = 0;
  calls.cherryPickSucceeds = true;
  calls.conflictResolved = true;
  calls.conflictIncludesTicket = true;
  calls.resolverReportsComplete = true;
  calls.emptyPlan = false;
  calls.invocations.length = 0;
  calls.plannerBranches.length = 0;
  calls.reviewApproved = true;
  calls.implementationComplete = true;
  calls.handoffSucceeds = true;
  calls.handoffUncertain = false;
  calls.handoffThrows = false;
  calls.finalChanges = false;
  calls.finalReviewApproved = true;
  calls.reviewCount = 0;
  calls.dirtyBranch = "";
  calls.dirtyAfterConflict = false;
  calls.blocked.length = 0;
});

afterEach(async () => {
  process.chdir(initialCwd);
  if (envDirectory) await rm(envDirectory, { recursive: true, force: true });
  for (const name of modelEnvironmentNames) {
    const value = initialModelEnvironment[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (initialRepository === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = initialRepository;
});

const loadEnvFile = async (content: string, rootEnv = ""): Promise<void> => {
  envDirectory = await mkdtemp(join(tmpdir(), "shipyard-template-env-"));
  await mkdir(join(envDirectory, ".shipyard"));
  await writeFile(join(envDirectory, ".shipyard", ".env"), content);
  if (rootEnv) await writeFile(join(envDirectory, ".env"), rootEnv);
  process.chdir(envDirectory);
  calls.envFileExists = true;
};

describe("generated issue workflows", () => {
  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s stops and explains the alternate when a local branch ref conflicts",
    async (template) => {
      calls.localBranches.push("shipyard/planner/20260920-210724-7707b7");

      await expect(
        import(`./templates/${template}/main.mts` as string),
      ).rejects.toThrow(/interactive terminal.*'shipyard\/planner-2'/);
      expect(calls.plannerBranches).toEqual([]);
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s reuses the selected conflict-free planner branch",
    async (template) => {
      calls.localBranches.push(
        "shipyard/planner/20260920-210724-7707b7",
        "shipyard/planner-2",
      );

      await import(`./templates/${template}/main.mts` as string);
      expect(calls.plannerBranches).toEqual(["shipyard/planner-2"]);
    },
  );

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])("%s blocks a non-ready ticket after triage", async (template) => {
    calls.triageReady = false;
    await import(`./templates/${template}/main.mts` as string);
    expect(calls.triaged.map((item) => item.id)).toEqual(["42"]);
    expect(calls.verified).toEqual(["42"]);
    expect(calls.events).not.toContain("implementer");
    expect(calls.events).not.toContain("handoff");
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "42" });
    expect(calls.blocked[0]?.reason).toContain("needs-info");
  });

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])("%s triages and verifies before implementing", async (template) => {
    await import(`./templates/${template}/main.mts` as string);
    expect(calls.triaged).toEqual([
      { id: "42", beforeEvents: expect.any(Number) },
    ]);
    expect(calls.verified).toEqual(["42"]);
    expect(calls.triaged[0]!.beforeEvents).toBe(
      calls.events.indexOf("implementer"),
    );
  });

  it("blocks a non-ready spec child before starting a ticket worker", async () => {
    calls.spec = true;
    calls.triageReady = false;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.triaged.map((item) => item.id)).toEqual(["43"]);
    expect(calls.verified).toEqual(["43"]);
    expect(calls.events).not.toContain("implementer");
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "43" });
  });

  it("simple-loop handles one issue at a time and publishes after implementation", async () => {
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "close",
      "handoff",
      "close",
      "select",
    ]);
    expect(calls.pendingEdits).toEqual(["42"]);
  });

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
    const generatedRoot = await mkdtemp(
      join(process.cwd(), "src/.generated-model-workflow-"),
    );
    try {
      await Effect.runPromise(
        scaffold(generatedRoot, {
          agent: getAgent("claude-code")!,
          model: "claude-opus-4-8",
          templateName: "sequential-reviewer",
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      await writeFile(
        join(generatedRoot, ".shipyard", ".env"),
        "SHIPYARD_ROUTINE_MODEL=sonnet\nSHIPYARD_STRONG_MODEL=opus\n",
      );
      process.env.SHIPYARD_STRONG_MODEL = "host-review-model";
      process.chdir(generatedRoot);
      calls.envFileExists = true;

      await import(
        pathToFileURL(join(generatedRoot, ".shipyard", "main.mts")).href
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
    } finally {
      process.chdir(initialCwd);
      await rm(generatedRoot, { recursive: true, force: true });
    }
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

  it("marks a failed standalone issue blocked and continues without handoff", async () => {
    calls.implementationComplete = false;
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.blocked).toEqual([
      {
        root: "42",
        failed: "42",
        scope: "42",
        reason: expect.stringContaining("verified completion evidence"),
      },
    ]);
    expect(calls.blocked[0]?.reason).toContain("blocked");
    expect(calls.events).not.toContain("handoff");
  });

  it("sequential-reviewer reviews before publication", async () => {
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "reviewer",
      "close",
      "handoff",
      "close",
      "select",
    ]);
  });

  it("parallel-planner keeps planning, parallel implementation and final validation", async () => {
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "planner",
      "implementer",
      "merger",
      "close",
      "handoff",
      "close",
      "select",
    ]);
  });

  it("parallel-planner-with-review keeps review before final validation", async () => {
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "planner",
      "implementer",
      "reviewer",
      "merger",
      "close",
      "handoff",
      "close",
      "select",
    ]);
  });

  it("re-reviews the final standalone commit before handoff", async () => {
    calls.finalChanges = true;
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events.filter((event) => event === "reviewer")).toHaveLength(
      2,
    );
    expect(calls.events.indexOf("handoff")).toBeGreaterThan(
      calls.events.lastIndexOf("reviewer"),
    );
  });

  it("blocks handoff when review of final corrections has findings", async () => {
    calls.finalChanges = true;
    calls.finalReviewApproved = false;
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).not.toContain("handoff");
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "42" });
  });

  it("uses non-reserved prompt arguments for target branches", async () => {
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    for (const invocation of calls.invocations)
      expect(invocation.args).not.toHaveProperty("TARGET_BRANCH");
    expect(
      calls.invocations.find((call) => call.name === "reviewer")?.args
        .BASE_BRANCH,
    ).toBe("staging");
  });

  it("publishes only after closing the implementation sandbox and reopening the synced branch", async () => {
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "close",
      "handoff",
      "close",
      "select",
    ]);
    expect(calls.creates.map((item) => item.branch)).toEqual([
      "shipyard/issue-42",
      "shipyard/issue-42",
    ]);
  });

  it("blocks publication when implementation leaves uncommitted work", async () => {
    calls.dirtyBranch = "shipyard/issue-42";
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).not.toContain("handoff");
    expect(calls.blocked[0]?.reason).toContain("uncommitted work");
  });

  it("blocks spec integration when a child leaves uncommitted work", async () => {
    calls.spec = true;
    calls.dirtyBranch = "shipyard/spec-42-issue-43";
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).not.toContain("handoff");
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "43" });
  });

  it("review findings prevent sequential handoff", async () => {
    calls.reviewApproved = false;
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "reviewer",
      "close",
      "blocked",
      "select",
    ]);
    expect(calls.blocked[0]?.reason).toContain("unresolved review findings");
  });

  it("missing implementation evidence prevents parallel handoff", async () => {
    calls.implementationComplete = false;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "planner",
      "implementer",
      "close",
      "blocked",
      "select",
    ]);
    expect(calls.blocked[0]?.reason).toContain(
      "lacks verified completion evidence",
    );
  });

  it("simple-loop passes the complete spec scope to /implement-spec and hands off once", async () => {
    calls.spec = true;
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "close",
      "handoff",
      "close",
      "select",
    ]);
    expect(calls.invocations[0]?.args.SKILL).toBe("/implement-spec");
    expect(JSON.parse(calls.invocations[0]!.args.SCOPE!).tickets).toHaveLength(
      2,
    );
  });

  it("parallel-planner runs dependency waves then integrates one spec PR", async () => {
    calls.spec = true;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "planner",
      "close",
      "implementer",
      "close",
      "rev-list",
      "cherry-pick",
      "spec-integrator",
      "close",
      "implementer",
      "close",
      "rev-list",
      "cherry-pick",
      "spec-integrator",
      "close",
      "merger",
      "close",
      "handoff",
      "close",
      "select",
    ]);
    expect(
      calls.invocations
        .filter((call) => call.name === "implementer")
        .map((call) => call.branch),
    ).toEqual(["shipyard/spec-42-issue-43", "shipyard/spec-42-issue-44"]);
    expect(
      calls.invocations.find((call) => call.name === "merger")?.branch,
    ).toBe("shipyard/spec-42");
    expect(
      calls.commands.find((command) =>
        command.startsWith("bash .shipyard/handoff.sh"),
      ),
    ).toContain("42,43,44");
    expect(calls.specContent).toEqual(["43", "44"]);
    expect(calls.pendingEdits).toEqual(["43", "44"]);
    expect(
      calls.creates
        .filter((item) => item.baseBranch)
        .map((item) => ({
          branch: item.branch,
          baseBranch: item.baseBranch,
          specContent: item.specContent,
        })),
    ).toEqual([
      {
        branch: "shipyard/spec-42-issue-43",
        baseBranch: "shipyard/spec-42",
        specContent: [],
      },
      {
        branch: "shipyard/spec-42-issue-44",
        baseBranch: "shipyard/spec-42",
        specContent: ["43"],
      },
    ]);
  });

  it("rejects an empty plan for activated scopes", async () => {
    calls.emptyPlan = true;
    await expect(
      import("./templates/parallel-planner/main.mts" as string),
    ).rejects.toThrow("Planner returned no work for activated scopes");
    expect(calls.events).toEqual(["select", "planner"]);
  });

  it("resolves a child cherry-pick conflict on the spec branch before handoff", async () => {
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toContain("conflict-resolver");
    expect(calls.events.indexOf("conflict-resolver")).toBeLessThan(
      calls.events.indexOf("spec-integrator"),
    );
    expect(calls.events).toContain("handoff");
    expect(calls.specContent).toEqual(["43", "44"]);
  });

  it("blocks the failed ticket and spec when a conflict cannot be resolved", async () => {
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    calls.conflictResolved = false;
    calls.dirtyBranch = "shipyard/spec-42";
    calls.dirtyAfterConflict = true;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "43" });
    expect(calls.blocked[0]?.reason).toContain("remains unresolved");
    expect(calls.events).not.toContain("handoff");
  });

  it("rejects a clean conflict resolution that omitted the ticket", async () => {
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    calls.conflictIncludesTicket = false;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "43" });
    expect(calls.blocked[0]?.reason).toContain("ticket commits are missing");
    expect(calls.events).not.toContain("handoff");
  });

  it("review template resolves a conflict and reviews the integrated spec", async () => {
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).toContain("conflict-resolver");
    expect(calls.events.lastIndexOf("reviewer")).toBeGreaterThan(
      calls.events.lastIndexOf("spec-integrator"),
    );
    expect(calls.events).toContain("handoff");
  });

  it("parallel templates retain concurrent independent standalone scopes", async () => {
    calls.multi = true;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(
      calls.events.filter((event) => event === "implementer"),
    ).toHaveLength(2);
    expect(calls.events.filter((event) => event === "handoff")).toHaveLength(2);
    expect(
      calls.invocations
        .filter((call) => call.name === "implementer")
        .map((call) => call.branch),
    ).toEqual(["shipyard/issue-42", "shipyard/issue-45"]);
  });

  it("review template reviews child work and integrated spec before one handoff", async () => {
    calls.spec = true;
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "planner",
      "close",
      "implementer",
      "reviewer",
      "close",
      "rev-list",
      "cherry-pick",
      "spec-integrator",
      "close",
      "implementer",
      "reviewer",
      "close",
      "rev-list",
      "cherry-pick",
      "spec-integrator",
      "close",
      "reviewer",
      "merger",
      "close",
      "handoff",
      "close",
      "select",
    ]);
    expect(
      calls.commands.filter((command) =>
        command.startsWith("bash .shipyard/handoff.sh"),
      ),
    ).toHaveLength(1);
  });

  it("parallel spec review follows all child integrations and gates handoff", async () => {
    calls.spec = true;
    calls.reviewApproved = false;
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).not.toContain("handoff");
    expect(calls.blocked[0]).toMatchObject({ root: "42", failed: "43" });
  });

  it("failed PR publication leaves the standalone run failed", async () => {
    calls.handoffSucceeds = false;
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "close",
      "handoff",
      "close",
      "blocked",
      "select",
    ]);
    expect(calls.blocked[0]?.reason).toContain("push failed");
  });

  it("leaves an uncertain PR publication active for reconciliation", async () => {
    calls.handoffUncertain = true;
    await expect(
      import("./templates/simple-loop/main.mts" as string),
    ).rejects.toThrow("Could not confirm PR readiness");
    expect(calls.blocked).toEqual([]);
  });

  it("does not block an issue when publication transport fails", async () => {
    calls.handoffThrows = true;
    await expect(
      import("./templates/simple-loop/main.mts" as string),
    ).rejects.toThrow("transport lost during PR handoff");
    expect(calls.blocked).toEqual([]);
  });
});
