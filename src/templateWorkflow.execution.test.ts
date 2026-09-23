import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialRepository = process.env.GH_REPO;

const calls = vi.hoisted(() => ({
  events: [] as string[],
  selected: 0,
  plans: 0,
  spec: false,
  multi: false,
  commands: [] as string[],
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
  reviewApproved: true,
  implementationComplete: true,
  handoffSucceeds: true,
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
  execFileSync: (
    command: string,
    args: string[],
    options?: { input?: string },
  ) => {
    if (command === "git") return "staging\n";
    if (command === "gh" && args[0] === "repo") return "owner/repo\n";
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
vi.mock("node:fs", () => ({ existsSync: () => false }));
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
        promptArgs,
      }: {
        name: string;
        promptArgs?: Record<string, string>;
      }) => {
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
        return {
          exitCode: calls.handoffSucceeds ? 0 : 1,
          stdout: "https://example.test/pr/1",
          stderr: calls.handoffSucceeds ? "" : "push failed",
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
    CODEX_MODELS: { routine: "routine", strong: "strong" },
    codex: () => ({}),
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
    run: async ({ name }: { name: string }) => {
      calls.events.push(name);
      if (name === "planner")
        return {
          output: {
            issues: calls.emptyPlan
              ? []
              : [{ id: "42" }, ...(calls.multi ? [{ id: "45" }] : [])],
          },
        };
      return calls.implementationComplete
        ? packet("tests passed")
        : { stdout: "blocked", commits: [] };
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  calls.events.length = 0;
  calls.selected = 0;
  calls.plans = 0;
  calls.spec = false;
  calls.multi = false;
  calls.commands.length = 0;
  calls.creates.length = 0;
  calls.specContent.length = 0;
  calls.cherryPickSucceeds = true;
  calls.conflictResolved = true;
  calls.conflictIncludesTicket = true;
  calls.resolverReportsComplete = true;
  calls.emptyPlan = false;
  calls.invocations.length = 0;
  calls.reviewApproved = true;
  calls.implementationComplete = true;
  calls.handoffSucceeds = true;
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
});

describe("generated issue workflows", () => {
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
});
