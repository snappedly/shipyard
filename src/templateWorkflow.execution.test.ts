import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const initialRepository = process.env.GH_REPO;

const calls = vi.hoisted(() => ({
  events: [] as string[],
  selected: 0,
  plans: 0,
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
          ? [{ id: "42", title: "Fix bug", branch: "shipyard/issue-42" }]
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
  const sandbox = () => ({
    run: async ({ name }: { name: string }) => {
      calls.events.push(name);
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
    exec: async () => {
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
  });
  return {
    CODEX_MODELS: { routine: "routine", strong: "strong" },
    codex: () => ({}),
    Output: { object: () => ({}) },
    createSandbox: async () => sandbox(),
    run: async ({ name }: { name: string }) => {
      calls.events.push(name);
      if (name === "planner")
        return {
          output: {
            issues:
              calls.plans++ === 0
                ? [{ id: "42", title: "Fix bug", branch: "shipyard/issue-42" }]
                : [],
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
      "planner",
      "implementer",
      "merger",
      "handoff",
      "close",
      "planner",
    ]);
  });

  it("parallel-planner-with-review keeps review before final validation", async () => {
    await import("./templates/parallel-planner-with-review/main.mts" as string);
    expect(calls.events).toEqual([
      "planner",
      "implementer",
      "reviewer",
      "close",
      "merger",
      "handoff",
      "close",
      "planner",
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
    await import("./templates/parallel-planner/main.mts" as string);
    expect(calls.events).toEqual(["planner", "implementer"]);
  });

  it("failed PR publication leaves the standalone run failed", async () => {
    calls.handoffSucceeds = false;
    await expect(
      import("./templates/simple-loop/main.mts" as string),
    ).rejects.toThrow("push failed");
    expect(calls.events).toEqual(["select", "implementer", "handoff", "close"]);
  });
});
