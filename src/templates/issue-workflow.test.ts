import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { scaffold, getAgent } from "../InitService.js";
import type { ScaffoldOptions } from "../InitService.js";

const repositories: string[] = [];
const makeRepo = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), "shipyard-template-"));
  repositories.push(dir);
  return dir;
};

afterEach(async () => {
  await Promise.all(
    repositories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

interface Issue {
  number: number;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  url: string;
  labels: { name: string }[];
  parent_issue_url?: string;
}

interface PullRequest {
  number: number;
  state: "OPEN" | "CLOSED";
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  title: string;
  body: string;
  url: string;
  mergedAt?: string | null;
}

interface Scenario {
  readonly activated: Issue[];
  readonly allIssues?: Issue[];
  readonly issues: Record<number, Issue>;
  readonly subIssues: Record<number, Issue[]>;
  readonly dependencies: Record<number, Issue[]>;
  readonly comments?: Record<number, unknown[]>;
  readonly pullRequests?: PullRequest[];
  readonly repo?: string;
  readonly baseBranch?: string;
}

const executableIssue = (
  number: number,
  extra: Partial<Issue> = {},
): Issue => ({
  number,
  title: `Issue ${number}`,
  body: "A standalone implementation request.",
  state: "OPEN",
  url: `https://github.com/example/project/issues/${number}`,
  labels: [{ name: "shipyard" }],
  ...extra,
});

const specIssue = (number: number, extra: Partial<Issue> = {}): Issue => ({
  number,
  title: `Spec ${number}`,
  body: "**Work item type:** planning spec, not executable\n\nDeliver the linked work.",
  state: "OPEN",
  url: `https://github.com/example/project/issues/${number}`,
  labels: [{ name: "shipyard" }],
  ...extra,
});

const linkedIssue = (
  number: number,
  parent: number,
  extra: Partial<Issue> = {},
): Issue =>
  executableIssue(number, {
    body:
      "**Work item type:** executable\n\n## Parent\n\n#" +
      parent +
      " — Spec " +
      parent,
    parent_issue_url:
      "https://api.github.com/repos/example/project/issues/" + parent,
    ...extra,
  });

const specScenario = (activated: Issue[]): Scenario => {
  const root =
    activated.find((issue) => issue.number === 73) ??
    specIssue(73, { labels: [] });
  const first = linkedIssue(74, 73);
  const second = linkedIssue(75, 73, {
    body: "**Work item type:** executable\n\n## Parent\n\n#73 — Spec 73\n\n## Blocked by\n\n- #74 — Issue 74",
  });
  return {
    activated,
    allIssues: [root, first, second],
    issues: { 73: root, 74: first, 75: second },
    subIssues: { 73: [first, second] },
    dependencies: { 73: [], 74: [], 75: [first] },
  };
};

const scaffoldTemplate = async (
  repoDir: string,
  templateName: string,
): Promise<void> => {
  const options: ScaffoldOptions = {
    agent: getAgent("codex")!,
    model: getAgent("codex")!.defaultModel,
    templateName,
  };
  await Effect.runPromise(
    scaffold(repoDir, options).pipe(Effect.provide(NodeFileSystem.layer)),
  );
};

const installRuntimeStubs = async (repoDir: string): Promise<void> => {
  const packageDir = join(
    repoDir,
    "node_modules",
    "@snappedly-tools",
    "shipyard",
  );
  await mkdir(join(packageDir, "sandboxes"), { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({
      type: "module",
      exports: {
        ".": "./index.mjs",
        "./sandboxes/docker": "./sandboxes/docker.mjs",
      },
    }),
  );
  await writeFile(
    join(packageDir, "index.mjs"),
    `import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const record = process.env.SHIPYARD_RUN_RECORD;
export const CODEX_MODELS = { routine: "routine", strong: "strong" };
export const codex = (model) => ({ model });
export const claudeCode = (model) => ({ model });
export async function run(options) {
  for (const hook of options.hooks?.sandbox?.onSandboxReady ?? []) {
    const result = spawnSync("sh", ["-c", hook.command], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
    });
    if (result.status !== 0) {
      throw new Error("Sandbox setup hook failed before the agent started: " + result.stderr);
    }
  }
  appendFileSync(process.env.SHIPYARD_GH_LOG, JSON.stringify({ command: "agent-start" }) + "\\n");
  const prior = record && existsSync(record) ? readFileSync(record, "utf8") : "";
  const calls = prior ? JSON.parse(prior) : [];
  calls.push({
    name: options.name,
    promptFile: options.promptFile,
    promptArgs: options.promptArgs,
    branchStrategy: options.branchStrategy,
    maxIterations: options.maxIterations,
    hooks: options.hooks,
  });
  if (record) writeFileSync(record, JSON.stringify(calls));
  return JSON.parse(process.env.SHIPYARD_RUN_RESULT);
}
`,
  );
  await writeFile(
    join(packageDir, "sandboxes", "docker.mjs"),
    'export const docker = () => ({ tag: "isolated" });\n',
  );
};

const installCommandStubs = async (repoDir: string): Promise<string> => {
  const binDir = join(repoDir, "test-bin");
  await mkdir(binDir, { recursive: true });
  const commandLog = join(repoDir, "command-log.json");
  const stub = `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
const [command, ...args] = process.argv.slice(2);
const scenario = JSON.parse(readFileSync(process.env.SHIPYARD_GH_SCENARIO, "utf8"));
const log = (entry) => appendFileSync(process.env.SHIPYARD_GH_LOG, JSON.stringify(entry) + "\\n");
const print = (value) => process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
if (command === "gh") {
  if (args[0] === "repo" && args[1] === "view") {
    print({ nameWithOwner: scenario.repo ?? "example/project", defaultBranchRef: { name: scenario.baseBranch ?? "main" } });
  } else if (args[0] === "issue" && args[1] === "list") {
    print(args.includes("all") ? (scenario.allIssues ?? scenario.activated) : scenario.activated);
  } else if (args[0] === "api") {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    let value;
    const issue = path.match(/\\/issues\\/(\\d+)(?:\\?|$)/);
    const subIssues = path.match(/\\/issues\\/(\\d+)\\/sub_issues/);
    const blockedBy = path.match(/\\/issues\\/(\\d+)\\/dependencies\\/blocked_by/);
    const comments = path.match(/\\/issues\\/(\\d+)\\/comments/);
    if (subIssues) value = scenario.subIssues?.[Number(subIssues[1])] ?? [];
    else if (blockedBy) value = scenario.dependencies?.[Number(blockedBy[1])] ?? [];
    else if (comments) value = scenario.comments?.[Number(comments[1])] ?? [];
    else if (issue) value = scenario.issues[Number(issue[1])];
    if (value === undefined) { process.stderr.write("missing fixture for " + path); process.exit(1); }
    print(args.includes("--slurp") ? [value] : value);
  } else if (args[0] === "pr" && args[1] === "list") {
    print(scenario.pullRequests ?? []);
  } else if (args[0] === "pr" && args[1] === "create") {
    log({ command: "pr-create", args });
    print("https://github.com/example/project/pull/900");
  } else if (args[0] === "pr" && args[1] === "edit") {
    log({ command: "pr-edit", args });
  } else if (args[0] === "pr" && args[1] === "ready") {
    log({ command: "pr-ready", args });
  } else if (args[0] === "issue" && args[1] === "edit") {
    log({ command: "issue-edit", args });
  } else {
    log({ command: "unexpected-gh", args });
    process.stderr.write("unexpected gh call: " + args.join(" "));
    process.exit(1);
  }
} else if (command === "git") {
  if (args[0] === "log") print(process.env.SHIPYARD_HAS_COMMITS === "true" ? "abc123\\n" : "");
  else if (args[0] === "rev-list") print(process.env.SHIPYARD_HAS_COMMITS === "true" ? "1" : "0");
  else if (args[0] === "push" || args[0] === "fetch") log({ command: "git-" + args[0], args });
  else if (args[0] === "show-ref") process.exit(1);
  else { log({ command: "unexpected-git", args }); process.exit(1); }
} else if (command === "corepack") {
  log({ command: "package-install", args });
} else {
  process.stderr.write("unexpected command: " + command);
  process.exit(1);
}
`;
  const path = join(binDir, "shipyard-command");
  await writeFile(path, stub);
  await chmod(path, 0o755);
  const ghPath = join(binDir, "gh");
  const gitPath = join(binDir, "git");
  const corepackPath = join(binDir, "corepack");
  await writeFile(
    ghPath,
    `#!/bin/sh\nexec "$(dirname "$0")/shipyard-command" gh "$@"\n`,
  );
  await writeFile(
    gitPath,
    `#!/bin/sh\nexec "$(dirname "$0")/shipyard-command" git "$@"\n`,
  );
  await writeFile(
    corepackPath,
    `#!/bin/sh\nexec "$(dirname "$0")/shipyard-command" corepack "$@"\n`,
  );
  await chmod(ghPath, 0o755);
  await chmod(gitPath, 0o755);
  await chmod(corepackPath, 0o755);
  return commandLog;
};

const runTemplate = async (
  repoDir: string,
  scenario: Scenario,
  result: {
    readonly commits: { sha: string }[];
    readonly completionSignal?: string;
    readonly stdout: string;
    readonly branch: string;
  },
  options: { readonly skillsInstallFails?: boolean } = {},
): Promise<{
  status: number;
  output: string;
  runCalls: Record<string, unknown>[];
  commands: Record<string, unknown>[];
}> => {
  await installRuntimeStubs(repoDir);
  const commandLog = await installCommandStubs(repoDir);
  const mainFile = join(repoDir, ".shipyard", "main.mts");
  const runRecord = join(repoDir, "run-record.json");
  const scenarioFile = join(repoDir, "scenario.json");
  const homeDir = join(repoDir, "home");
  await mkdir(homeDir, { recursive: true });
  for (const skill of [
    "implement",
    "implement-spec",
    "code-cleanup",
    "code-review",
    "tdd",
  ]) {
    if (options.skillsInstallFails && skill === "tdd") continue;
    const skillDir = join(homeDir, ".agents", "skills", skill);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# " + skill);
  }
  await writeFile(scenarioFile, JSON.stringify(scenario));
  const tsxCli = join(process.cwd(), "node_modules", ".bin", "tsx");
  const child = spawnSync(tsxCli, [mainFile], {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      PATH: `${join(repoDir, "test-bin")}${delimiter}${process.env.PATH ?? ""}`,
      SHIPYARD_GH_SCENARIO: scenarioFile,
      SHIPYARD_GH_LOG: commandLog,
      SHIPYARD_RUN_RECORD: runRecord,
      SHIPYARD_RUN_RESULT: JSON.stringify(result),
      SHIPYARD_HAS_COMMITS: result.commits.length ? "true" : "false",
    },
  });
  const runCallsText = await readFile(runRecord, "utf8").catch(() => "[]");
  const commandsText = await readFile(commandLog, "utf8").catch(() => "");
  return {
    status: child.status ?? 1,
    output: `${child.stdout ?? ""}${child.stderr ?? ""}`,
    runCalls: JSON.parse(runCallsText),
    commands: commandsText
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
};

const readyOutput = `<shipyard-handoff>\nstatus: ready-for-human\nverification: npm test -- issue.test.ts — passed\nreview: local diff review — no findings\nfindings: none\n</shipyard-handoff>`;
const completedResult = {
  commits: [{ sha: "abc123" }],
  completionSignal: "<promise>COMPLETE</promise>",
  stdout: readyOutput,
  branch: "shipyard/issue-42",
};

describe("generated GitHub issue workflows", () => {
  it("routes one activated standalone issue to /implement on its integration branch", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const issue = executableIssue(42);
    const scenario: Scenario = {
      activated: [issue],
      issues: { 42: issue },
      subIssues: {},
      dependencies: {},
    };

    const execution = await runTemplate(repoDir, scenario, completedResult);

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    expect(execution.runCalls[0]).toMatchObject({
      branchStrategy: {
        type: "branch",
        branch: "shipyard/issue-42",
        baseBranch: "origin/main",
      },
      maxIterations: 100,
    });
    const promptArgs = execution.runCalls[0]!["promptArgs"] as Record<
      string,
      string
    >;
    expect(promptArgs["TASK_TYPE"]).toBe("standalone");
    expect(
      JSON.parse(
        Buffer.from(promptArgs["WORK_ITEM_BASE64"]!, "base64").toString(),
      ),
    ).toMatchObject({
      kind: "standalone",
      root: { issue: { number: 42 } },
      tickets: [{ issue: { number: 42 } }],
    });
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(true);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-ready"),
    ).toBe(false);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-merge"),
    ).toBe(false);
    const hooks = execution.runCalls[0]!["hooks"] as {
      sandbox: { onSandboxReady: { command: string }[] };
    };
    expect(hooks.sandbox.onSandboxReady[0]!.command).toContain(
      "https://github.com/snappedly/skills.git",
    );
    expect(hooks.sandbox.onSandboxReady[1]!.command).toContain(
      "packageManager",
    );
    expect(execution.runCalls[0]).not.toHaveProperty("copyToWorktree");
    const prompt = await readFile(
      join(repoDir, ".shipyard", "prompt.md"),
      "utf8",
    );
    expect(prompt).toContain("/implement");
    expect(prompt).toContain("/implement-spec");
  });

  it("routes a parent-only planning spec activation through one whole-spec invocation", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const root = specIssue(73);
    const execution = await runTemplate(repoDir, specScenario([root]), {
      ...completedResult,
      branch: "shipyard/spec-73",
    });

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    expect(execution.runCalls[0]).toMatchObject({
      branchStrategy: {
        type: "branch",
        branch: "shipyard/spec-73",
        baseBranch: "origin/main",
      },
      name: "implement-spec",
    });
    const promptArgs = execution.runCalls[0]!["promptArgs"] as Record<
      string,
      string
    >;
    const item = JSON.parse(
      Buffer.from(promptArgs["WORK_ITEM_BASE64"]!, "base64").toString(),
    );
    expect(promptArgs["TASK_TYPE"]).toBe("spec");
    expect(item).toMatchObject({
      kind: "spec",
      root: { issue: { number: 73 } },
      tickets: [
        { issue: { number: 74 } },
        { issue: { number: 75 }, blockedBy: [74] },
      ],
    });
    const pullRequest = execution.commands.find(
      (entry) => entry["command"] === "pr-create",
    );
    expect(pullRequest).toBeDefined();
    const args = pullRequest!["args"] as string[];
    const body = args[args.indexOf("--body") + 1]!;
    expect(body).toContain("Closes #73");
    expect(body).toContain("Closes #74");
    expect(body).toContain("Closes #75");
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-merge"),
    ).toBe(false);
  });

  it("resolves documented Parent sections when native sub-issue links are absent", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const root = specIssue(73);
    const child = executableIssue(74, {
      body: "**Work item type:** executable\n\n## Parent\n\n#73 — Spec 73",
      labels: [],
    });
    const execution = await runTemplate(
      repoDir,
      {
        activated: [root],
        allIssues: [root, child],
        issues: { 73: root, 74: child },
        subIssues: { 73: [] },
        dependencies: {},
      },
      { ...completedResult, branch: "shipyard/spec-73" },
    );

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    const promptArgs = execution.runCalls[0]!["promptArgs"] as Record<
      string,
      string
    >;
    const item = JSON.parse(
      Buffer.from(promptArgs["WORK_ITEM_BASE64"]!, "base64").toString(),
    );
    expect(item.kind).toBe("spec");
    expect(
      item.tickets.map((ticket: { issue: Issue }) => ticket.issue.number),
    ).toEqual([74]);
  });

  it("resolves an activated child to its planning-spec parent and dependency graph", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const child = linkedIssue(75, 73, {
      body: "**Work item type:** executable\n\n## Parent\n\n#73 — Spec 73\n\n## Blocked by\n\n- #74 — Issue 74",
    });
    const execution = await runTemplate(repoDir, specScenario([child]), {
      ...completedResult,
      branch: "shipyard/spec-73",
    });

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    const promptArgs = execution.runCalls[0]!["promptArgs"] as Record<
      string,
      string
    >;
    const item = JSON.parse(
      Buffer.from(promptArgs["WORK_ITEM_BASE64"]!, "base64").toString(),
    );
    expect(item.kind).toBe("spec");
    expect(item.root.issue.number).toBe(73);
    expect(
      item.tickets.map((ticket: { issue: Issue }) => ticket.issue.number),
    ).toEqual([74, 75]);
    expect(item.tickets[1].blockedBy).toEqual([74]);
    expect(item.activatedIssues).toEqual([75]);
  });

  it("deduplicates activated siblings into one spec invocation", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const first = linkedIssue(74, 73);
    const second = linkedIssue(75, 73);
    const execution = await runTemplate(
      repoDir,
      specScenario([first, second]),
      { ...completedResult, branch: "shipyard/spec-73" },
    );

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    const promptArgs = execution.runCalls[0]!["promptArgs"] as Record<
      string,
      string
    >;
    const item = JSON.parse(
      Buffer.from(promptArgs["WORK_ITEM_BASE64"]!, "base64").toString(),
    );
    expect(item.activatedIssues).toEqual([74, 75]);
  });

  it("reports an invalid parent relationship instead of treating a linked child as standalone", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const parent = executableIssue(90, { labels: [] });
    const child = linkedIssue(91, 90);
    const scenario: Scenario = {
      activated: [child],
      allIssues: [parent, child],
      issues: { 90: parent, 91: child },
      subIssues: {},
      dependencies: {},
    };

    const execution = await runTemplate(repoDir, scenario, completedResult);

    expect(execution.status).not.toBe(0);
    expect(execution.output).toContain("which is not a planning spec");
    expect(execution.runCalls).toHaveLength(0);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
  });

  it("reports conflicting parent links instead of choosing one", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const root = specIssue(73, { labels: [] });
    const child = linkedIssue(74, 73, {
      body: "**Work item type:** executable\n\n## Parent\n\n#73 — Spec 73\n#99 — Another spec",
    });
    const execution = await runTemplate(
      repoDir,
      {
        activated: [child],
        allIssues: [root, child],
        issues: { 73: root, 74: child },
        subIssues: { 73: [child] },
        dependencies: {},
      },
      completedResult,
    );

    expect(execution.status).not.toBe(0);
    expect(execution.output).toContain("conflicting parent relationships");
    expect(execution.runCalls).toHaveLength(0);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
  });

  it("skips an existing ready pull request on later invocations", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const child = linkedIssue(75, 73);
    const scenario = specScenario([child]);
    const execution = await runTemplate(
      repoDir,
      {
        ...scenario,
        pullRequests: [
          {
            number: 610,
            state: "OPEN",
            isDraft: false,
            headRefName: "shipyard/spec-73",
            baseRefName: "main",
            title: "Implement spec 73",
            body: "Closes #73",
            url: "https://github.com/example/project/pull/610",
          },
        ],
      },
      completedResult,
    );

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(0);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
    expect(
      execution.commands.some((entry) => entry["command"] === "issue-edit"),
    ).toBe(true);
  });

  it("updates an existing draft and marks it ready only after clean skill evidence", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const issue = executableIssue(42);
    const execution = await runTemplate(
      repoDir,
      {
        activated: [issue],
        issues: { 42: issue },
        subIssues: {},
        dependencies: {},
        pullRequests: [
          {
            number: 611,
            state: "OPEN",
            isDraft: true,
            headRefName: "shipyard/issue-42",
            baseRefName: "main",
            title: "Draft",
            body: "",
            url: "https://github.com/example/project/pull/611",
          },
        ],
      },
      completedResult,
    );

    expect(execution.status, execution.output).toBe(0);
    expect(execution.runCalls).toHaveLength(1);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-edit"),
    ).toBe(true);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-ready"),
    ).toBe(true);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
  });

  it("does not publish when checks or findings block skill handoff", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const issue = executableIssue(42);
    const execution = await runTemplate(
      repoDir,
      {
        activated: [issue],
        issues: { 42: issue },
        subIssues: {},
        dependencies: {},
      },
      {
        ...completedResult,
        stdout:
          "<shipyard-handoff>\nstatus: blocked\nverification: npm test — failed\nreview: spec review — open findings\nfindings: unresolved\nlimitations: test failure\n</shipyard-handoff>",
      },
    );

    expect(execution.status).not.toBe(0);
    expect(execution.output).toContain("No pull request was handed off");
    expect(execution.runCalls).toHaveLength(1);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-ready"),
    ).toBe(false);
  });

  it("aborts before starting the agent when skill installation fails", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    const issue = executableIssue(42);
    const execution = await runTemplate(
      repoDir,
      {
        activated: [issue],
        issues: { 42: issue },
        subIssues: {},
        dependencies: {},
      },
      completedResult,
      { skillsInstallFails: true },
    );

    expect(execution.status).not.toBe(0);
    expect(execution.output).toContain(
      "Sandbox setup hook failed before the agent started",
    );
    expect(execution.runCalls).toHaveLength(0);
    expect(
      execution.commands.some((entry) => entry["command"] === "agent-start"),
    ).toBe(false);
    expect(
      execution.commands.some((entry) => entry["command"] === "pr-create"),
    ).toBe(false);
  });

  it("installs target-repository dependencies with its package manager before the agent starts", async () => {
    const repoDir = await makeRepo();
    await scaffoldTemplate(repoDir, "simple-loop");
    await writeFile(
      join(repoDir, "package.json"),
      JSON.stringify({ name: "candidate", packageManager: "pnpm@9.1.0" }),
    );
    await writeFile(
      join(repoDir, "pnpm-lock.yaml"),
      "lockfileVersion: '9.0'\n",
    );
    const issue = executableIssue(42);
    const execution = await runTemplate(
      repoDir,
      {
        activated: [issue],
        issues: { 42: issue },
        subIssues: {},
        dependencies: {},
      },
      completedResult,
    );

    expect(execution.status, execution.output).toBe(0);
    const installIndex = execution.commands.findIndex(
      (entry) => entry["command"] === "package-install",
    );
    const agentIndex = execution.commands.findIndex(
      (entry) => entry["command"] === "agent-start",
    );
    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(execution.commands[installIndex]).toMatchObject({
      command: "package-install",
      args: ["pnpm", "install", "--frozen-lockfile"],
    });
    expect(agentIndex).toBeGreaterThan(installIndex);
  });
});
