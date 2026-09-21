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
        return { stdout: "online\n", stderr: "" };
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
        return { stdout: "", stderr: "" };
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
        if (command === "gh" && args[0] === "issue") {
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
        return { stdout: "", stderr: "" };
      },
    };

    const result = await startRepositoryRunner({ repoDir }, adapters);

    expect(result.initialWorkFound).toBe(true);
    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["npx", ["shipyard", "run"]],
      ["./run.sh", []],
    ]);
    expect(base.spawns[0]!.env).toMatchObject({ GH_TOKEN: "repo-token" });
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
        if (command === "gh" && args[0] === "issue") {
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

    expect(issueChecks).toBe(2);
    expect(base.spawns.map(({ command, args }) => [command, args])).toEqual([
      ["./run.sh", []],
      ["npx", ["shipyard", "run"]],
    ]);
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
        if (command === "gh" && args[0] === "issue") {
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
        if (command === "gh" && args[0] === "issue") {
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
        return { stdout: "", stderr: "" };
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
  });

  it("refuses a second start while the recorded controller is alive", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({ schemaVersion: 1, pid: 999, repository: "x/y" }),
    );

    await expect(
      startRepositoryRunner({ repoDir }, base.adapters),
    ).rejects.toThrow("already running with process 999");
    expect(base.spawns).toHaveLength(0);
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
      }),
    );
    base.files.set(
      statePath,
      JSON.stringify({
        schemaVersion: 1,
        repository: "snappedly/shipyard",
        state: "idle",
        lastOutcome: "Shipyard completed successfully",
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
      }),
    );

    const result = await stopRepositoryRunner({ repoDir }, base.adapters);

    expect(result).toEqual({ pid: 321 });
    expect(base.signals).toEqual([{ pid: 321, signal: "SIGTERM" }]);
    expect(base.files.has(lockPath)).toBe(true);
  });
});
