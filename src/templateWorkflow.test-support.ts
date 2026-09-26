import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { afterEach, beforeEach, vi } from "vitest";
import { getAgent, scaffold } from "./InitService.js";

const initialRepository = process.env.GH_REPO;
const initialCwd = process.cwd();
const modelEnvironmentNames = [
  "SHIPYARD_ROUTINE_MODEL",
  "SHIPYARD_STRONG_MODEL",
  "SHIPYARD_ROUTINE_REASONING_EFFORT",
  "SHIPYARD_STRONG_REASONING_EFFORT",
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
  pendingLabelCommands: [] as string[][],
  triaged: [] as Array<{ id: string; beforeEvents: number }>,
  verified: [] as string[],
  triageReady: true,
  envFileExists: false,
  providerFailureModel: "",
  codexModelsSnapshot: undefined as
    | {
        routine: { model: string; effort: string };
        strong: { model: string; effort: string };
      }
    | undefined,
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
  handoffInputs: [] as string[],
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
      if (args.includes("shipyard:pending"))
        calls.pendingLabelCommands.push(args);
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
      exec: async (command: string, options?: { stdin?: string }) => {
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
        calls.handoffInputs.push(options?.stdin ?? "");
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
    ...((calls.codexModelsSnapshot ?? {})[role] ?? {
      model:
        process.env[`SHIPYARD_CODEX_${role.toUpperCase()}_MODEL`]?.trim() ||
        `${role}-default`,
      effort:
        process.env[
          `SHIPYARD_CODEX_${role.toUpperCase()}_REASONING_EFFORT`
        ]?.trim() || "max",
    }),
  });
  const codexModels = {
    get routine() {
      return codexModel("routine");
    },
    get strong() {
      return codexModel("strong");
    },
  };
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
    REASONING_EFFORTS: ["low", "medium", "high", "xhigh", "max"],
    CODEX_REASONING_EFFORTS: ["low", "medium", "high", "xhigh", "max"],
    CODEX_MODELS: codexModels,
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
      agent,
    }: {
      name: string;
      branchStrategy?: { branch?: string };
      agent?: {
        name: string;
        model: string;
        effort?: string;
      };
    }) => {
      if (agent)
        calls.agentInvocations.push({
          name,
          provider: agent.name,
          model: agent.model,
          effort: agent.effort,
        });
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

export const getCalls = () => calls;

beforeEach(() => {
  vi.resetModules();
  for (const name of modelEnvironmentNames) delete process.env[name];
  envDirectory = undefined;
  calls.events.length = 0;
  calls.pendingEdits.length = 0;
  calls.pendingLabelCommands.length = 0;
  calls.triaged.length = 0;
  calls.verified.length = 0;
  calls.triageReady = true;
  calls.envFileExists = false;
  calls.providerFailureModel = "";
  calls.codexModelsSnapshot = undefined;
  calls.agentInvocations.length = 0;
  calls.selected = 0;
  calls.spec = false;
  calls.multi = false;
  calls.commands.length = 0;
  calls.handoffInputs.length = 0;
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

export const loadEnvFile = async (
  content: string,
  rootEnv = "",
): Promise<void> => {
  envDirectory = await mkdtemp(join(tmpdir(), "shipyard-template-env-"));
  await mkdir(join(envDirectory, ".shipyard"));
  await writeFile(join(envDirectory, ".shipyard", ".env"), content);
  if (rootEnv) await writeFile(join(envDirectory, ".env"), rootEnv);
  process.chdir(envDirectory);
  calls.envFileExists = true;
};

const captureCodexModels = () => {
  const modelFor = (role: "routine" | "strong") => {
    const prefix = `SHIPYARD_CODEX_${role.toUpperCase()}`;
    return {
      model: process.env[`${prefix}_MODEL`]?.trim() || `${role}-default`,
      effort: process.env[`${prefix}_REASONING_EFFORT`]?.trim() || "max",
    };
  };
  calls.codexModelsSnapshot = {
    routine: modelFor("routine"),
    strong: modelFor("strong"),
  };
};

export const importTemplate = async (
  templateName:
    | "simple-loop"
    | "sequential-reviewer"
    | "parallel-planner"
    | "parallel-planner-with-review",
): Promise<void> => {
  captureCodexModels();
  await import(`./templates/${templateName}/main.mts` as string);
};

export const runGeneratedWorkflow = async (
  templateName: string,
  agentName: "codex" | "claude-code",
  model: string,
  modelExplicit: boolean,
  envContent: string,
): Promise<void> => {
  const generatedRoot = await mkdtemp(
    join(initialCwd, "src/.generated-model-workflow-"),
  );
  try {
    await Effect.runPromise(
      scaffold(generatedRoot, {
        agent: getAgent(agentName)!,
        model,
        modelExplicit,
        templateName,
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    );
    await writeFile(join(generatedRoot, ".shipyard", ".env"), envContent);
    process.chdir(generatedRoot);
    calls.envFileExists = true;
    captureCodexModels();
    await import(
      pathToFileURL(join(generatedRoot, ".shipyard", "main.mts")).href
    );
  } finally {
    process.chdir(initialCwd);
    await rm(generatedRoot, { recursive: true, force: true });
  }
};
