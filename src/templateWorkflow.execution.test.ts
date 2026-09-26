import { describe, expect, it } from "vitest";
import { getCalls } from "./templateWorkflow.test-support.js";

const calls = getCalls();

describe("generated issue workflows", () => {
  it.each([
    "simple-loop",
    "sequential-reviewer",
    "parallel-planner",
    "parallel-planner-with-review",
  ])(
    "%s removes activation when marking a ticket pending",
    async (template) => {
      await import(`./templates/${template}/main.mts` as string);

      expect(calls.pendingLabelCommands).toContainEqual([
        "issue",
        "edit",
        "42",
        "--repo",
        "owner/repo",
        "--add-label",
        "shipyard:pending",
        "--remove-label",
        "shipyard",
      ]);
    },
  );

  it.each(["parallel-planner", "parallel-planner-with-review"])(
    "%s removes activation from each spec ticket when marking it pending",
    async (template) => {
      calls.spec = true;
      await import(`./templates/${template}/main.mts` as string);

      expect(calls.pendingLabelCommands.map((args) => args[2])).toEqual([
        "43",
        "44",
      ]);
      for (const args of calls.pendingLabelCommands)
        expect(args.slice(-4)).toEqual([
          "--add-label",
          "shipyard:pending",
          "--remove-label",
          "shipyard",
        ]);
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
    process.env.SHIPYARD_STRONG_MODEL = "strong-choice";
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toContain("conflict-resolver");
    expect(
      calls.agentInvocations.find((call) => call.name === "conflict-resolver"),
    ).toMatchObject({ provider: "codex", model: "strong-choice" });
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
