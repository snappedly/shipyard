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
  emptyPlan: false,
  invocations: [] as Array<{
    name: string;
    branch: string;
    args: Record<string, string>;
  }>,
  reviewApproved: true,
  implementationComplete: true,
  handoffSucceeds: true,
}));

vi.mock("node:child_process", () => ({
  execFileSync: (command: string, args: string[]) => {
    if (command === "git") return "staging\n";
    if (command === "gh" && args[0] === "repo") return "owner/repo\n";
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
        if (name === "implementer")
          return calls.implementationComplete
            ? packet("tests passed")
            : { stdout: "blocked", commits: [] };
        if (name === "reviewer")
          return calls.reviewApproved
            ? {
                ...packet("review approved"),
                stdout:
                  "<handoff>review approved</handoff><review>APPROVED</review>",
              }
            : { ...packet("finding"), stdout: "<handoff>finding</handoff>" };
        return packet("integration passed");
      },
      exec: async (command: string) => {
        calls.commands.push(command);
        if (command.startsWith("git rev-list")) {
          calls.events.push("rev-list");
          return { exitCode: 0, stdout: "a".repeat(40), stderr: "" };
        }
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
  calls.emptyPlan = false;
  calls.invocations.length = 0;
  calls.reviewApproved = true;
  calls.implementationComplete = true;
  calls.handoffSucceeds = true;
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
      "handoff",
      "close",
      "select",
    ]);
  });

  it("sequential-reviewer reviews before publication", async () => {
    await import("./templates/sequential-reviewer/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "reviewer",
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
      "handoff",
      "close",
      "select",
    ]);
  });

  it("review findings prevent sequential handoff", async () => {
    calls.reviewApproved = false;
    await expect(
      import("./templates/sequential-reviewer/main.mts" as string),
    ).rejects.toThrow("unresolved review findings");
    expect(calls.events).toEqual([
      "select",
      "implementer",
      "reviewer",
      "close",
    ]);
  });

  it("missing implementation evidence prevents parallel handoff", async () => {
    calls.implementationComplete = false;
    await expect(
      import("./templates/parallel-planner/main.mts" as string),
    ).rejects.toThrow("lacks verified completion evidence");
    expect(calls.events).toEqual(["select", "planner", "implementer", "close"]);
  });

  it("simple-loop passes the complete spec scope to /implement-spec and hands off once", async () => {
    calls.spec = true;
    await import("./templates/simple-loop/main.mts" as string);
    expect(calls.events).toEqual([
      "select",
      "implementer",
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

  it("cherry-pick failure prevents the spec PR handoff", async () => {
    calls.spec = true;
    calls.cherryPickSucceeds = false;
    await expect(
      import("./templates/parallel-planner/main.mts" as string),
    ).rejects.toThrow("Cherry-pick of #43 failed: conflict");
    expect(calls.events).not.toContain("handoff");
    expect(calls.specContent).toEqual([]);
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
    await expect(
      import("./templates/parallel-planner-with-review/main.mts" as string),
    ).rejects.toThrow("unresolved review findings");
    expect(calls.events).not.toContain("handoff");
  });

  it("failed PR publication leaves the standalone run failed", async () => {
    calls.handoffSucceeds = false;
    await expect(
      import("./templates/simple-loop/main.mts" as string),
    ).rejects.toThrow("push failed");
    expect(calls.events).toEqual(["select", "implementer", "handoff", "close"]);
  });
});
