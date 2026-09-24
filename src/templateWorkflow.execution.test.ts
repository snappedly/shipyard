import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgent, scaffold } from "./InitService.js";

const initialRepository = process.env.GH_REPO;
const initialStrongLimit = process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE;
const initialEscalation = process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES;

const calls = vi.hoisted(() => ({
  events: [] as string[],
  pendingEdits: [] as string[],
  triaged: [] as Array<{ id: string; beforeEvents: number }>,
  verified: [] as string[],
  triageReady: true,
  highRisk: false,
  quotedRiskMarker: false,
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
    model: string;
    effort: string;
  }>,
  modelCalls: [] as Array<{ name: string; model: string; effort: string }>,
  usageRecords: [] as Array<Record<string, unknown>>,
  usageWriteFails: false,
  plannerBranches: [] as string[],
  reviewApproved: true,
  implementationComplete: true,
  structuredFailure: false,
  strongEscalationSucceeds: true,
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

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
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
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: () => false,
  mkdirSync: () => undefined,
  appendFileSync: (_path: string, line: string) => {
    if (calls.usageWriteFails) throw new Error("usage disk unavailable");
    calls.usageRecords.push(JSON.parse(line) as Record<string, unknown>);
  },
}));
vi.mock("@snappedly-tools/shipyard/sandboxes/docker", () => ({
  docker: () => ({}),
}));
vi.mock("@snappedly-tools/shipyard", () => {
  const packet = (text: string) => ({
    completionSignal: "<promise>COMPLETE</promise>",
    stdout: `<handoff>${text}</handoff>`,
    commits: [{ sha: "abc" }],
    iterations: [
      {
        usage: {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 5,
          outputTokens: 2,
        },
      },
    ],
  });
  const sandbox = (branch: string) => {
    const pendingContent: string[] = [];
    let headReads = 0;
    return {
      run: async ({
        name,
        promptArgs,
        agent,
      }: {
        name: string;
        promptArgs?: Record<string, string>;
        agent: { model: string; effort: string };
      }) => {
        calls.modelCalls.push({
          name,
          model: agent.model,
          effort: agent.effort,
        });
        if (name.startsWith("triage #")) {
          calls.triaged.push({
            id: name.slice("triage #".length),
            beforeEvents: calls.events.length,
          });
          return {
            ...packet("triage applied"),
            stdout: calls.highRisk
              ? "<risk>strong-review</risk>"
              : calls.quotedRiskMarker
                ? "quoted <risk>strong-review</risk> from issue text\nNo risk decision"
                : "triage applied",
          };
        }
        calls.events.push(name);
        calls.invocations.push({
          name,
          branch,
          args: promptArgs ?? {},
          model: agent.model,
          effort: agent.effort,
        });
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
            : {
                stdout: calls.structuredFailure
                  ? "<handoff>Facts: patch applied\nChecks: typecheck failed\nBlocker: missing type</handoff>"
                  : "blocked",
                commits: [],
              };
        if (name === "implementer-escalation")
          return calls.strongEscalationSucceeds
            ? packet("strong retry passed")
            : { stdout: "still blocked", commits: [] };
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
  return {
    CODEX_MODELS: {
      routine: { model: "small-model", effort: "low" },
      strong: { model: "large-model", effort: "high" },
    },
    codex: (model: string, options: { effort: string }) => ({
      name: "codex",
      model,
      effort: options.effort,
    }),
    claudeCode: (model: string, options: { effort: string }) => ({
      name: "claude-code",
      model,
      effort: options.effort,
    }),
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
      agent,
    }: {
      name: string;
      branchStrategy?: { branch?: string };
      agent: { model: string; effort: string };
    }) => {
      calls.events.push(name);
      calls.modelCalls.push({ name, model: agent.model, effort: agent.effort });
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
  calls.events.length = 0;
  calls.pendingEdits.length = 0;
  calls.triaged.length = 0;
  calls.verified.length = 0;
  calls.triageReady = true;
  calls.highRisk = false;
  calls.quotedRiskMarker = false;
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
  calls.modelCalls.length = 0;
  calls.usageRecords.length = 0;
  calls.usageWriteFails = false;
  calls.plannerBranches.length = 0;
  calls.reviewApproved = true;
  calls.implementationComplete = true;
  calls.structuredFailure = false;
  calls.strongEscalationSucceeds = true;
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

afterEach(() => {
  if (initialRepository === undefined) delete process.env.GH_REPO;
  else process.env.GH_REPO = initialRepository;
  if (initialStrongLimit === undefined)
    delete process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE;
  else process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE = initialStrongLimit;
  if (initialEscalation === undefined)
    delete process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES;
  else process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES = initialEscalation;
});

describe("generated issue workflows", () => {
  it("runs a scaffolded Claude workflow with both model roles", async () => {
    const dir = await mkdtemp(
      join(process.cwd(), "src/templates/.claude-role-test-"),
    );
    try {
      await Effect.runPromise(
        scaffold(dir, {
          agent: getAgent("claude-code")!,
          model: "small-model",
          routineModel: "small-model",
          strongModel: "large-model",
          routineEffort: "low",
          strongEffort: "high",
          templateName: "sequential-reviewer",
        }).pipe(Effect.provide(NodeFileSystem.layer)),
      );
      await import(join(dir, ".shipyard/main.mts") as string);
      expect(calls.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "implementer",
            provider: "claude-code",
            model: "small-model",
          }),
          expect.objectContaining({
            phase: "reviewer",
            provider: "claude-code",
            model: "large-model",
          }),
        ]),
      );
      expect(calls.events).toContain("handoff");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])(
    "%s routes routine and strong work to configured models",
    async (template) => {
      await import(`./templates/${template}/main.mts` as string);
      for (const invocation of calls.modelCalls) {
        const routine =
          invocation.name === "implementer" ||
          invocation.name.startsWith("triage #");
        expect(invocation.model).toBe(routine ? "small-model" : "large-model");
        expect(invocation.effort).toBe(routine ? "low" : "high");
      }
    },
  );

  it("records model usage by issue and phase", async () => {
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(calls.usageRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: "42",
          phase: "implementer",
          role: "routine",
          model: "small-model",
          usage: expect.objectContaining({ inputTokens: 10, outputTokens: 2 }),
          childUsage: { builtIn: "disabled", external: "unknown" },
        }),
        expect.objectContaining({
          issueId: "42",
          phase: "reviewer",
          role: "strong",
          model: "large-model",
        }),
      ]),
    );
  });

  it("does not route a quoted risk marker to the strong role", async () => {
    calls.quotedRiskMarker = true;
    await import("./templates/simple-loop/main.mts" as string);
    expect(
      calls.modelCalls.some((call) => call.name.startsWith("risk-review")),
    ).toBe(false);
  });

  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])("%s sends high-risk triage to the strong role", async (template) => {
    calls.highRisk = true;
    await import(`./templates/${template}/main.mts` as string);
    expect(calls.modelCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "risk-review #42",
          model: "large-model",
        }),
      ]),
    );
  });

  it("preserves workflow success when usage logging fails", async () => {
    calls.usageWriteFails = true;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await import("./templates/simple-loop/main.mts" as string);
      expect(calls.events).toContain("handoff");
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("usage disk unavailable"),
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("blocks a strong phase when its per-issue limit is exhausted", async () => {
    process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE = "0";
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(calls.modelCalls.some((call) => call.name === "reviewer")).toBe(
      false,
    );
    expect(calls.blocked[0]?.reason).toContain("strong model run limit");
    expect(calls.usageRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          issueId: "42",
          phase: "reviewer",
          status: "budget-exhausted",
        }),
      ]),
    );
  });

  it("escalates one failed routine implementation when enabled", async () => {
    process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES = "true";
    calls.implementationComplete = false;
    calls.structuredFailure = true;
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(
      calls.modelCalls.filter((call) => call.name === "implementer-escalation"),
    ).toEqual([
      { name: "implementer-escalation", model: "large-model", effort: "high" },
    ]);
    expect(calls.events).toContain("handoff");
    expect(calls.usageRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          phase: "implementer",
          status: "returned-without-signal",
          usage: null,
        }),
        expect.objectContaining({
          phase: "implementer-escalation",
          attempt: 2,
          escalationReason: expect.stringContaining(
            "without a completion signal",
          ),
        }),
      ]),
    );
    expect(
      calls.invocations.find((call) => call.name === "implementer-escalation")
        ?.args.ROUTINE_EVIDENCE,
    ).toBe(
      "Facts: patch applied\nChecks: typecheck failed\nBlocker: missing type",
    );
  });

  it("does not escalate without a structured failure handoff", async () => {
    process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES = "true";
    calls.implementationComplete = false;
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(
      calls.modelCalls.some((call) => call.name === "implementer-escalation"),
    ).toBe(false);
  });

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s attributes shared planner usage to activated issues separately from issue limits",
    async (template) => {
      calls.multi = true;
      process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE = "0";
      await import(`./templates/${template}/main.mts` as string);
      expect(calls.modelCalls.some((call) => call.name === "planner")).toBe(
        true,
      );
      expect(calls.usageRecords).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "planner",
            issueIds: ["42", "45"],
          }),
        ]),
      );
    },
  );
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
