import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRepositoryRunnerStatus,
  startRepositoryRunner,
  stopRepositoryRunner,
  type RepositoryRunnerChild,
  type RunnerControlAdapters,
} from "./RepositoryRunnerControl.js";
import { REPOSITORY_RUNNER_WORKFLOW } from "./RepositoryRunnerWake.js";

const repoDir = "/repo";
const runnerDir = join(repoDir, ".shipyard", "runner");
const metadataPath = join(runnerDir, ".shipyard-install.json");
const lockPath = join(runnerDir, ".shipyard-controller.lock");
const statePath = join(runnerDir, ".shipyard-state.json");

const installMetadata = `${JSON.stringify({
  schemaVersion: 1,
  repository: "snappedly/shipyard",
  repositoryUrl: "https://github.com/snappedly/shipyard",
  name: "shipyard-shipyard-test-mac",
  label: "shipyard",
  version: "2.331.0",
})}\n`;

const makeChild = (
  pid: number,
  result: { code: number | null; signal: NodeJS.Signals | null } = {
    code: 0,
    signal: null,
  },
): RepositoryRunnerChild => ({
  pid,
  wait: async () => result,
  terminate: () => undefined,
});

const makeAdapters = (
  overrides: Partial<RunnerControlAdapters> = {},
): {
  adapters: RunnerControlAdapters;
  files: Map<string, string>;
  commands: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>;
  spawns: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }>;
  signals: Array<{ pid: number; signal: NodeJS.Signals }>;
} => {
  const files = new Map<string, string>([
    [join(repoDir, ".shipyard", ".env"), "GH_TOKEN=repo-token\n"],
    [metadataPath, installMetadata],
    [join(runnerDir, ".credentials"), "official-runner-secret"],
    [join(runnerDir, "run.sh"), "#!/bin/sh"],
  ]);
  const directories = new Set([repoDir, join(repoDir, ".shipyard"), runnerDir]);
  const commands: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const spawns: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let childPid = 200;

  const adapters: RunnerControlAdapters = {
    platform: () => "darwin",
    arch: () => "arm64",
    environment: () => ({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      GH_TOKEN: "host-token",
      OPENAI_API_KEY: "host-agent-secret",
    }),
    currentPid: () => 100,
    processIdentity: async (pid) => `started-${pid}`,
    exists: async (path) => directories.has(path) || files.has(path),
    readText: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    writeText: async (path, content) => {
      files.set(path, content);
    },
    writeExclusive: async (path, content) => {
      if (files.has(path)) throw new Error("EEXIST");
      files.set(path, content);
    },
    remove: async (path) => {
      files.delete(path);
    },
    makeDirectory: async (path) => {
      directories.add(path);
    },
    removeTree: async (path) => {
      for (const key of [...files.keys()]) {
        if (key === path || key.startsWith(`${path}/`)) files.delete(key);
      }
      for (const key of [...directories]) {
        if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
      }
    },
    commandExists: async () => true,
    resolveEnvironment: async () => ({ GH_TOKEN: "repo-token" }),
    run: async (command, args, options) => {
      commands.push({ command, args, env: options.env });
      if (command === "git") {
        return {
          stdout: "git@github.com:snappedly/shipyard.git\n",
          stderr: "",
        };
      }
      if (command === "gh" && args[0] === "label") {
        return { stdout: "shipyard\n", stderr: "" };
      }
      if (
        command === "gh" &&
        args[0] === "api" &&
        args.includes(".default_branch")
      ) {
        return { stdout: "main\n", stderr: "" };
      }
      if (
        command === "gh" &&
        args.some((arg) => arg.includes("shipyard-wake.yml"))
      ) {
        return { stdout: REPOSITORY_RUNNER_WORKFLOW, stderr: "" };
      }
      if (
        command === "gh" &&
        args.some((arg) => arg.endsWith("/actions/runners"))
      ) {
        return {
          stdout: args.some((arg) => arg.endsWith("| .status"))
            ? "online\n"
            : "shipyard-shipyard-test-mac\tonline\tself-hosted,macOS,shipyard\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    spawn: (command, args, options) => {
      spawns.push({ command, args, env: options.env });
      return makeChild(childPid++);
    },
    isProcessRunning: () => true,
    signalProcess: (pid, signal) => {
      signals.push({ pid, signal });
    },
    onShutdown: () => () => undefined,
    pause: async () => undefined,
    now: () => new Date("2026-01-02T03:04:05.000Z"),
    report: () => undefined,
    ...overrides,
  };

  return { adapters, files, commands, spawns, signals };
};

describe("startRepositoryRunner", () => {
  it("rejects unsupported hosts before starting a process", async () => {
    const { adapters, spawns } = makeAdapters({ platform: () => "linux" });

    await expect(startRepositoryRunner({ repoDir }, adapters)).rejects.toThrow(
      "Apple Silicon macOS",
    );
    expect(spawns).toHaveLength(0);
  });

  it("creates a missing activation label and listens without invoking an agent when no task is eligible", async () => {
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.commands.push({ command, args, env: options.env });
        if (command === "git") {
          return {
            stdout: "https://github.com/snappedly/shipyard.git\n",
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "label" && args[1] === "list") {
          return { stdout: "", stderr: "" };
        }
        if (command === "gh" && args.includes(".default_branch")) {
          return { stdout: "main\n", stderr: "" };
        }
        if (
          command === "gh" &&
          args.some((arg) => arg.includes("shipyard-wake.yml"))
        ) {
          return { stdout: REPOSITORY_RUNNER_WORKFLOW, stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    const result = await startRepositoryRunner({ repoDir }, adapters);

    expect(result.initialWorkFound).toBe(false);
    expect(base.commands).toContainEqual(
      expect.objectContaining({
        command: "gh",
        args: [
          "label",
          "create",
          "shipyard",
          "--repo",
          "snappedly/shipyard",
          "--color",
          "1D76DB",
          "--description",
          "Tasks available to the Shipyard repository runner",
          "--force",
        ],
      }),
    );
    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["./run.sh", []],
    ]);
    expect(base.spawns[0]!.env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
    });
    expect(base.spawns[0]!.env).not.toHaveProperty("GH_TOKEN");
    expect(base.spawns[0]!.env).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("runs exactly npx shipyard run before listening when an eligible task exists", async () => {
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.commands.push({ command, args, env: options.env });
        if (command === "git") {
          return {
            stdout: "git@github.com:snappedly/shipyard.git\n",
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "label") {
          return { stdout: "shipyard\n", stderr: "" };
        }
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: "42\n", stderr: "" };
        }
        if (command === "gh" && args.includes(".default_branch")) {
          return { stdout: "main\n", stderr: "" };
        }
        if (
          command === "gh" &&
          args.some((arg) => arg.includes("shipyard-wake.yml"))
        ) {
          return { stdout: REPOSITORY_RUNNER_WORKFLOW, stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    const result = await startRepositoryRunner({ repoDir }, adapters);

    expect(result.initialWorkFound).toBe(true);
    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["npx", ["shipyard", "run"]],
      ["./run.sh", []],
    ]);
    expect(base.spawns[0]!.env).toMatchObject({ GH_TOKEN: "repo-token" });
    expect(base.spawns[0]!.env).toMatchObject({
      SHIPYARD_RUNNER_OWNER: "snappedly/shipyard",
    });
    const eligibility = base.commands.find(
      ({ command, args }) =>
        command === "gh" && args.some((arg) => arg.endsWith("/issues")),
    );
    expect(eligibility?.args).toEqual(
      expect.arrayContaining([
        "--paginate",
        "per_page=100",
        ".[] | select(.pull_request == null) | .number",
      ]),
    );
    expect(eligibility?.args).not.toContain("--limit");
  });

  it("recognizes a replaced issue with the same count and runs Shipyard again", async () => {
    const base = makeAdapters();
    const issueSets = ["42\n", "43\n", ""];
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: issueSets.shift() ?? "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await startRepositoryRunner({ repoDir }, adapters);

    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["npx", ["shipyard", "run"]],
      ["npx", ["shipyard", "run"]],
      ["./run.sh", []],
    ]);
  });

  it("drains an issue that arrives during a successful Shipyard invocation", async () => {
    const base = makeAdapters();
    const issueSets = ["42\n", "42\n43\n", ""];
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: issueSets.shift() ?? "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await startRepositoryRunner({ repoDir }, adapters);

    expect(base.spawns.map(({ command }) => command)).toEqual([
      "npx",
      "npx",
      "./run.sh",
    ]);
  });

  it("records no progress when the sorted eligible issue identities are unchanged", async () => {
    let resolveListener!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let listenerStarted!: () => void;
    const listenerStartedPromise = new Promise<void>(
      (resolve) => (listenerStarted = resolve),
    );
    const listenerExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveListener = resolve));
    const base = makeAdapters();
    const reports: string[] = [];
    const issueSets = ["43\n42\n", "42\n43\n"];
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: issueSets.shift() ?? "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        if (command === "./run.sh") {
          listenerStarted();
          return {
            pid: 201,
            wait: () => listenerExit,
            terminate: () => undefined,
          };
        }
        return makeChild(200);
      },
      report: (message) => reports.push(message),
    };

    const started = startRepositoryRunner({ repoDir }, adapters);
    await listenerStartedPromise;

    expect(base.spawns.map(({ command }) => command)).toEqual([
      "npx",
      "./run.sh",
    ]);
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stalled",
      lastOutcome: "Shipyard made no progress; eligible issues are unchanged",
    });
    expect(reports).toContain(
      "[repository runner] stalled: Shipyard made no progress; eligible issues are unchanged",
    );

    resolveListener({ code: 0, signal: null });
    await started;
  });

  it("checks eligibility and invokes Shipyard after a delivered wake-up", async () => {
    let deliverWake!: () => void;
    let resolveListener!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let listenerStarted!: () => void;
    let shipyardStarted!: () => void;
    const listenerStartedPromise = new Promise<void>(
      (resolve) => (listenerStarted = resolve),
    );
    const shipyardStartedPromise = new Promise<void>(
      (resolve) => (shipyardStarted = resolve),
    );
    const listenerExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveListener = resolve));
    const base = makeAdapters();
    let issueChecks = 0;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      onWake: (handler) => {
        deliverWake = handler;
        return () => undefined;
      },
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          issueChecks += 1;
          return {
            stdout: issueChecks === 1 ? "" : "42\n",
            stderr: "",
          };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        if (command === "./run.sh") {
          listenerStarted();
          return {
            pid: 200,
            wait: () => listenerExit,
            terminate: () => undefined,
          };
        }
        shipyardStarted();
        return makeChild(201);
      },
    };

    const started = startRepositoryRunner({ repoDir }, adapters);
    await listenerStartedPromise;
    deliverWake();
    await shipyardStartedPromise;
    resolveListener({ code: 0, signal: null });
    await started;

    expect(issueChecks).toBe(3);
    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["./run.sh", []],
      ["npx", ["shipyard", "run"]],
    ]);
  });

  it("coalesces wake-ups delivered while Shipyard is active", async () => {
    let deliverWake!: () => void;
    let resolveListener!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let resolveShipyard!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let listenerStarted!: () => void;
    let shipyardStarted!: () => void;
    let coalescedWakeChecked!: () => void;
    const listenerStartedPromise = new Promise<void>(
      (resolve) => (listenerStarted = resolve),
    );
    const shipyardStartedPromise = new Promise<void>(
      (resolve) => (shipyardStarted = resolve),
    );
    const coalescedWakeCheckedPromise = new Promise<void>(
      (resolve) => (coalescedWakeChecked = resolve),
    );
    const listenerExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveListener = resolve));
    const shipyardExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveShipyard = resolve));
    const base = makeAdapters();
    const issueSets = ["", "42\n", "", ""];
    let issueChecks = 0;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      onWake: (handler) => {
        deliverWake = handler;
        return () => undefined;
      },
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          issueChecks += 1;
          if (issueChecks === 4) coalescedWakeChecked();
          return { stdout: issueSets.shift() ?? "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        if (command === "./run.sh") {
          listenerStarted();
          return {
            pid: 200,
            wait: () => listenerExit,
            terminate: () => undefined,
          };
        }
        shipyardStarted();
        return {
          pid: 201,
          wait: () => shipyardExit,
          terminate: () => undefined,
        };
      },
    };

    const started = startRepositoryRunner({ repoDir }, adapters);
    await listenerStartedPromise;
    deliverWake();
    await shipyardStartedPromise;
    deliverWake();
    deliverWake();
    deliverWake();

    expect(base.spawns.filter(({ command }) => command === "npx")).toHaveLength(
      1,
    );
    resolveShipyard({ code: 0, signal: null });
    await coalescedWakeCheckedPromise;
    resolveListener({ code: 0, signal: null });
    await started;

    expect(issueChecks).toBe(4);
    expect(base.spawns.filter(({ command }) => command === "npx")).toHaveLength(
      1,
    );
  });

  it("acknowledges an empty stale wake-up without invoking Shipyard", async () => {
    let deliverWake!: () => void;
    let resolveListener!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let listenerStarted!: () => void;
    let secondIssueCheck!: () => void;
    const listenerStartedPromise = new Promise<void>(
      (resolve) => (listenerStarted = resolve),
    );
    const secondIssueCheckPromise = new Promise<void>(
      (resolve) => (secondIssueCheck = resolve),
    );
    const listenerExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveListener = resolve));
    const base = makeAdapters();
    let issueChecks = 0;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      onWake: (handler) => {
        deliverWake = handler;
        return () => undefined;
      },
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          issueChecks += 1;
          if (issueChecks === 2) secondIssueCheck();
          return { stdout: "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        listenerStarted();
        return {
          pid: 200,
          wait: () => listenerExit,
          terminate: () => undefined,
        };
      },
    };

    const started = startRepositoryRunner({ repoDir }, adapters);
    await listenerStartedPromise;
    deliverWake();
    await secondIssueCheckPromise;
    resolveListener({ code: 0, signal: null });
    await started;

    expect(issueChecks).toBe(2);
    expect(base.spawns.map(({ command }) => command)).toEqual(["./run.sh"]);
  });

  it("refuses to start until the exact workflow is on the default branch", async () => {
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (
          command === "gh" &&
          args.some((arg) => arg.includes("shipyard-wake.yml"))
        ) {
          throw new Error("HTTP 404");
        }
        return base.adapters.run(command, args, options);
      },
    };

    await expect(startRepositoryRunner({ repoDir }, adapters)).rejects.toThrow(
      "Commit and push .github/workflows/shipyard-wake.yml",
    );
    expect(base.spawns).toHaveLength(0);
  });

  it("preserves a failure diagnostic and refuses to listen after a failed Shipyard run", async () => {
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.commands.push({ command, args, env: options.env });
        if (command === "git") {
          return {
            stdout: "git@github.com:snappedly/shipyard.git\n",
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "label") {
          return { stdout: "shipyard\n", stderr: "" };
        }
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: "42\n", stderr: "" };
        }
        if (command === "gh" && args.includes(".default_branch")) {
          return { stdout: "main\n", stderr: "" };
        }
        if (
          command === "gh" &&
          args.some((arg) => arg.includes("shipyard-wake.yml"))
        ) {
          return { stdout: REPOSITORY_RUNNER_WORKFLOW, stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        return makeChild(200, { code: 7, signal: null });
      },
    };

    await expect(startRepositoryRunner({ repoDir }, adapters)).rejects.toThrow(
      "npx shipyard run exited with code 7",
    );
    expect(base.spawns).toHaveLength(1);
    expect(base.spawns[0]!.command).toBe("npx");
    expect(base.files.has(lockPath)).toBe(false);
    expect(
      base.files.get(join(runnerDir, ".shipyard-last-failure.json")),
    ).toContain("exited with code 7");
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: "npx shipyard run exited with code 7.",
    });
  });

  it("takes an active listener offline when a woken Shipyard invocation fails", async () => {
    let deliverWake!: () => void;
    let resolveListener!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let listenerStarted!: () => void;
    const listenerStartedPromise = new Promise<void>(
      (resolve) => (listenerStarted = resolve),
    );
    const listenerExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveListener = resolve));
    const listenerTerminations: NodeJS.Signals[] = [];
    const base = makeAdapters();
    const issueSets = ["", "42\n"];
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      onWake: (handler) => {
        deliverWake = handler;
        return () => undefined;
      },
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          return { stdout: issueSets.shift() ?? "", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        if (command === "./run.sh") {
          listenerStarted();
          return {
            pid: 200,
            wait: () => listenerExit,
            terminate: (signal) => {
              listenerTerminations.push(signal);
              resolveListener({ code: null, signal });
            },
          };
        }
        return makeChild(201, { code: 7, signal: null });
      },
    };

    const started = startRepositoryRunner({ repoDir }, adapters);
    await listenerStartedPromise;
    deliverWake();

    await expect(started).rejects.toThrow(
      "npx shipyard run exited with code 7",
    );
    expect(listenerTerminations).toEqual(["SIGTERM"]);
    expect(base.files.has(lockPath)).toBe(false);
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: "npx shipyard run exited with code 7.",
    });
  });

  it("records a post-run eligibility failure and takes the controller offline", async () => {
    const base = makeAdapters();
    let eligibilityChecks = 0;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "gh" && args.some((arg) => arg.endsWith("/issues"))) {
          eligibilityChecks += 1;
          if (eligibilityChecks === 1) return { stdout: "42\n", stderr: "" };
          throw new Error("GitHub unavailable after Shipyard completed");
        }
        return base.adapters.run(command, args, options);
      },
    };

    await expect(startRepositoryRunner({ repoDir }, adapters)).rejects.toThrow(
      "Checking for eligible GitHub issues failed",
    );
    expect(base.files.has(lockPath)).toBe(false);
    expect(
      base.files.get(join(runnerDir, ".shipyard-last-failure.json")),
    ).toContain("GitHub unavailable after Shipyard completed");
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
    });
  });

  it("refuses a second start while the recorded controller is alive", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 999,
        repository: "x/y",
        processStartedAt: "started-999",
      }),
    );

    await expect(
      startRepositoryRunner({ repoDir }, base.adapters),
    ).rejects.toThrow("already running with process 999");
    expect(base.spawns).toHaveLength(0);
  });

  it("repairs an expired remote registration before listening", async () => {
    const base = makeAdapters();
    base.files.delete(join(runnerDir, ".credentials"));
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.commands.push({ command, args, env: options.env });
        if (command === "git") {
          return {
            stdout: "git@github.com:snappedly/shipyard.git\n",
            stderr: "",
          };
        }
        if (command === "gh" && args[0] === "label") {
          return { stdout: "shipyard\n", stderr: "" };
        }
        if (
          command === "gh" &&
          args.some((arg) => arg.endsWith("/actions/runners"))
        ) {
          return { stdout: "", stderr: "" };
        }
        if (
          command === "gh" &&
          args.some((arg) => arg.endsWith("/registration-token"))
        ) {
          return { stdout: '{"token":"repair-token"}\n', stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await startRepositoryRunner({ repoDir }, adapters);

    const registration = base.commands.find(
      ({ command }) => command === "./config.sh",
    );
    expect(registration?.args).toEqual([
      "--url",
      "https://github.com/snappedly/shipyard",
      "--token",
      "repair-token",
      "--name",
      "shipyard-shipyard-test-mac",
      "--labels",
      "shipyard",
      "--work",
      "_work",
      "--unattended",
    ]);
    expect(registration?.env).not.toHaveProperty("GH_TOKEN");
  });

  it("uses the same shutdown path to terminate an active listener and clear the process lock", async () => {
    let resolveExit!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    let shutdown!: () => Promise<void>;
    let childStarted!: () => void;
    const childStartedPromise = new Promise<void>(
      (resolve) => (childStarted = resolve),
    );
    const terminations: NodeJS.Signals[] = [];
    const childExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveExit = resolve));
    const child: RepositoryRunnerChild = {
      pid: 200,
      wait: () => childExit,
      terminate: (signal) => {
        terminations.push(signal);
        resolveExit({ code: null, signal });
      },
    };
    const base = makeAdapters({
      spawn: () => {
        childStarted();
        return child;
      },
      onShutdown: (handler) => {
        shutdown = handler;
        return () => undefined;
      },
    });

    const started = startRepositoryRunner({ repoDir }, base.adapters);
    await childStartedPromise;
    await shutdown();
    await started;

    expect(terminations).toEqual(["SIGTERM"]);
    expect(base.files.has(lockPath)).toBe(false);
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: "Stopped by signal",
    });
  });

  it("cancels children and removes transient state even when shutdown state writes fail", async () => {
    let shutdown!: () => Promise<void>;
    let childStarted!: () => void;
    let resolveExit!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    const startedChild = new Promise<void>(
      (resolve) => (childStarted = resolve),
    );
    const childExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveExit = resolve));
    const terminations: NodeJS.Signals[] = [];
    const base = makeAdapters();
    const transientPath = join(runnerDir, "_work", "transient");
    base.files.set(transientPath, "temporary");
    let failStateWrites = false;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      writeText: async (path, content) => {
        if (path === statePath && failStateWrites) throw new Error("disk full");
        base.files.set(path, content);
      },
      spawn: (command, args, options) => {
        base.spawns.push({ command, args, env: options.env });
        childStarted();
        return {
          pid: 200,
          wait: () => childExit,
          terminate: (signal) => {
            terminations.push(signal);
            resolveExit({ code: null, signal });
          },
        };
      },
      onShutdown: (handler) => {
        shutdown = handler;
        return () => undefined;
      },
    };

    const running = startRepositoryRunner({ repoDir }, adapters);
    await startedChild;
    failStateWrites = true;
    await shutdown();
    await running;

    expect(terminations).toEqual(["SIGTERM"]);
    expect(base.files.has(lockPath)).toBe(false);
    expect(base.files.has(transientPath)).toBe(false);
  });

  it("forces a stuck child down and removes its owned sandbox before reporting stopped", async () => {
    let shutdown!: () => Promise<void>;
    let childStarted!: () => void;
    let resolveExit!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    const startedChild = new Promise<void>(
      (resolve) => (childStarted = resolve),
    );
    const childExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveExit = resolve));
    const terminations: NodeJS.Signals[] = [];
    const base = makeAdapters();
    let containerQueries = 0;
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "docker" && args[0] === "ps") {
          containerQueries += 1;
          return {
            stdout: containerQueries === 1 ? "" : "owned-container\n",
            stderr: "",
          };
        }
        return base.adapters.run(command, args, options);
      },
      spawn: () => {
        childStarted();
        return {
          pid: 200,
          wait: () => childExit,
          terminate: (signal) => {
            terminations.push(signal);
            if (signal === "SIGKILL") resolveExit({ code: null, signal });
          },
        };
      },
      onShutdown: (handler) => {
        shutdown = handler;
        return () => undefined;
      },
    };

    const running = startRepositoryRunner({ repoDir }, adapters);
    await startedChild;
    await shutdown();
    await running;

    expect(terminations).toEqual(["SIGTERM", "SIGKILL"]);
    expect(base.commands).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: ["rm", "-f", "owned-container"],
      }),
    );
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: "Stopped by signal",
    });
  });

  it("retains cleanup failures instead of reporting a clean stop", async () => {
    let shutdown!: () => Promise<void>;
    let childStarted!: () => void;
    let resolveExit!: (result: {
      code: number | null;
      signal: NodeJS.Signals | null;
    }) => void;
    const startedChild = new Promise<void>(
      (resolve) => (childStarted = resolve),
    );
    const childExit = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => (resolveExit = resolve));
    const reports: string[] = [];
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      spawn: () => {
        childStarted();
        return {
          pid: 200,
          wait: () => childExit,
          terminate: (signal) => resolveExit({ code: null, signal }),
        };
      },
      removeTree: async (path) => {
        if (path.endsWith("/_work")) throw new Error("work cleanup denied");
        await base.adapters.removeTree(path);
      },
      onShutdown: (handler) => {
        shutdown = handler;
        return () => undefined;
      },
      report: (message) => reports.push(message),
    };

    const running = startRepositoryRunner({ repoDir }, adapters);
    await startedChild;
    await shutdown();
    await running;

    expect(reports.join("\n")).toContain("work cleanup denied");
    expect(
      base.files.get(join(runnerDir, ".shipyard-last-failure.json")),
    ).toContain("work cleanup denied");
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: expect.stringContaining("cleanup failed"),
    });
  });

  it("retains startup failures after installation metadata is available", async () => {
    const base = makeAdapters();
    const adapters: RunnerControlAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "docker" && args[0] === "info") {
          throw new Error("Docker Desktop is unavailable");
        }
        return base.adapters.run(command, args, options);
      },
    };

    await expect(startRepositoryRunner({ repoDir }, adapters)).rejects.toThrow(
      "Docker Desktop is unavailable",
    );

    expect(
      base.files.get(join(runnerDir, ".shipyard-last-failure.json")),
    ).toContain("Docker Desktop is unavailable");
    expect(JSON.parse(base.files.get(statePath)!)).toMatchObject({
      state: "stopped",
      lastOutcome: expect.stringContaining("Docker Desktop is unavailable"),
    });
  });
});

describe("getRepositoryRunnerStatus", () => {
  it("reports installation, process, GitHub connectivity, state, and last outcome without secrets", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 321,
        repository: "snappedly/shipyard",
        processStartedAt: "started-321",
      }),
    );
    base.files.set(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        repository: "snappedly/shipyard",
        state: "idle",
        lastOutcome: "Shipyard completed successfully",
        lastWake: {
          source: "signal",
          recordedAt: "2026-01-02T03:04:05.000Z",
        },
      }),
    );

    const status = await getRepositoryRunnerStatus({ repoDir }, base.adapters);

    expect(status).toEqual({
      installed: true,
      running: true,
      pid: 321,
      github: "online",
      repository: "snappedly/shipyard",
      state: "idle",
      lastOutcome: "Shipyard completed successfully",
      lastWake: {
        source: "signal",
        recordedAt: "2026-01-02T03:04:05.000Z",
      },
    });
    expect(JSON.stringify(status)).not.toContain("token");
    expect(JSON.stringify(status)).not.toContain("secret");
  });
});

describe("stopRepositoryRunner", () => {
  it("signals the foreground controller and leaves cleanup to its bounded shutdown", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 321,
        repository: "snappedly/shipyard",
        processStartedAt: "started-321",
      }),
    );

    const result = await stopRepositoryRunner({ repoDir }, base.adapters);

    expect(result).toEqual({ pid: 321 });
    expect(base.signals).toEqual([{ pid: 321, signal: "SIGTERM" }]);
    expect(base.files.has(lockPath)).toBe(true);
  });

  it("does not signal a reused PID whose start identity differs", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 321,
        repository: "snappedly/shipyard",
        processStartedAt: "old-process",
      }),
    );

    await expect(
      stopRepositoryRunner({ repoDir }, base.adapters),
    ).rejects.toThrow("no longer matches");
    expect(base.signals).toHaveLength(0);
  });
});
