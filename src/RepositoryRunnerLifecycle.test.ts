import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  recoverRepositoryRunner,
  removeRepositoryRunner,
  validateExistingRepositoryRunner,
  type RunnerLifecycleAdapters,
} from "./RepositoryRunnerLifecycle.js";

const repoDir = "/repo";
const configDir = join(repoDir, ".shipyard");
const runnerDir = join(configDir, "runner");
const maskDir = join(configDir, "runner-sandbox-mask");
const metadataPath = join(runnerDir, ".shipyard-install.json");
const lockPath = join(runnerDir, ".shipyard-controller.lock");
const workPath = join(runnerDir, "_work");

const metadata = {
  schemaVersion: 1 as const,
  repository: "snappedly/shipyard",
  repositoryUrl: "https://github.com/snappedly/shipyard",
  name: "shipyard-shipyard-test-mac",
  label: "shipyard",
  version: "2.331.0",
};

const makeAdapters = (overrides: Partial<RunnerLifecycleAdapters> = {}) => {
  const files = new Map<string, string>([
    [metadataPath, `${JSON.stringify(metadata)}\n`],
    [join(runnerDir, ".credentials"), "secret"],
    [join(runnerDir, ".credentials_rsaparams"), "secret"],
    [join(runnerDir, ".runner"), "registration"],
    [join(runnerDir, "run.sh"), "#!/bin/sh"],
    [join(configDir, ".env"), "GH_TOKEN=runtime-token\n"],
    [join(configDir, "main.ts"), "export {}\n"],
    [join(configDir, "logs", "run.log"), "evidence"],
    [join(configDir, "worktrees", "task", "work.txt"), "evidence"],
  ]);
  const directories = new Set([
    repoDir,
    configDir,
    runnerDir,
    maskDir,
    workPath,
    join(configDir, "logs"),
    join(configDir, "worktrees"),
    join(configDir, "worktrees", "task"),
  ]);
  const calls: Array<{
    command: string;
    args: readonly string[];
    env: NodeJS.ProcessEnv;
  }> = [];
  const removes: string[] = [];
  const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  const removeTree = (path: string) => {
    removes.push(path);
    for (const key of [...files.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) files.delete(key);
    }
    for (const key of [...directories]) {
      if (key === path || key.startsWith(`${path}/`)) directories.delete(key);
    }
  };

  const adapters: RunnerLifecycleAdapters = {
    environment: () => ({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/test",
      GH_TOKEN: "admin-token",
    }),
    exists: async (path) => files.has(path) || directories.has(path),
    readText: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    makeDirectory: async (path) => {
      directories.add(path);
    },
    remove: async (path) => removeTree(path),
    run: async (command, args, options) => {
      calls.push({ command, args, env: options.env });
      if (
        command === "gh" &&
        args.some((arg) => arg.endsWith("/registration-token"))
      ) {
        return { stdout: '{"token":"one-time-registration"}\n', stderr: "" };
      }
      if (
        command === "gh" &&
        args.some((arg) => arg.endsWith("/remove-token"))
      ) {
        return { stdout: '{"token":"one-time-removal"}\n', stderr: "" };
      }
      if (
        command === "gh" &&
        args.some((arg) => arg.endsWith("/actions/runners"))
      ) {
        return {
          stdout:
            "shipyard-shipyard-test-mac\tonline\tself-hosted,macOS,shipyard\n",
          stderr: "",
        };
      }
      return { stdout: "", stderr: "" };
    },
    isProcessRunning: () => false,
    signalProcess: (pid, signal) => signals.push({ pid, signal }),
    pause: async () => undefined,
    processIdentity: async (pid) => `started-${pid}`,
    ...overrides,
  };

  return { adapters, calls, files, directories, removes, signals };
};

const installOptions = {
  repoDir,
  runnerDir,
  maskDir,
  repository: metadata.repository,
  runnerName: metadata.name,
};

describe("validateExistingRepositoryRunner", () => {
  it("returns a healthy matching installation without registering a duplicate", async () => {
    const base = makeAdapters();

    const result = await validateExistingRepositoryRunner(
      installOptions,
      base.adapters,
    );

    expect(result).toEqual(metadata);
    expect(base.calls.some(({ command }) => command === "./config.sh")).toBe(
      false,
    );
    expect(base.calls.filter(({ command }) => command === "gh")).toHaveLength(
      1,
    );
  });

  it("refuses local metadata belonging to another runner name", async () => {
    const base = makeAdapters();
    base.files.set(
      metadataPath,
      JSON.stringify({ ...metadata, name: "shipyard-shipyard-old-mac" }),
    );

    await expect(
      validateExistingRepositoryRunner(installOptions, base.adapters),
    ).rejects.toThrow("belongs to runner shipyard-shipyard-old-mac");
    expect(base.calls).toHaveLength(0);
  });

  it("refuses a matching name whose remote labels do not match", async () => {
    const base = makeAdapters({
      run: async () => ({
        stdout: "shipyard-shipyard-test-mac\tonline\tself-hosted,macOS\n",
        stderr: "",
      }),
    });

    await expect(
      validateExistingRepositoryRunner(installOptions, base.adapters),
    ).rejects.toThrow("does not carry the shipyard label");
  });

  it("refuses duplicate shipyard-labelled registrations even when the expected runner exists", async () => {
    const base = makeAdapters({
      run: async () => ({
        stdout:
          "shipyard-shipyard-test-mac\tonline\tself-hosted,macOS,shipyard\nshipyard-other-mac\toffline\tself-hosted,macOS,shipyard\n",
        stderr: "",
      }),
    });

    await expect(
      validateExistingRepositoryRunner(installOptions, base.adapters),
    ).rejects.toThrow("Multiple repository runners carry the shipyard label");
  });

  it("rejects a symlinked protected sandbox mask", async () => {
    const base = makeAdapters({
      inspectDirectory: async (path) => ({
        realPath:
          path === maskDir
            ? "/REPO/.SHIPYARD/RUNNER"
            : "/repo/.shipyard/runner",
        directory: true,
        symbolicLink: path === maskDir,
      }),
    });

    await expect(
      validateExistingRepositoryRunner(installOptions, base.adapters),
    ).rejects.toThrow("must be a real directory");
  });

  it("rejects protected directories that alias after macOS case folding", async () => {
    const base = makeAdapters({
      inspectDirectory: async (path) => ({
        realPath:
          path === maskDir
            ? "/REPO/.SHIPYARD/RUNNER"
            : "/repo/.shipyard/runner",
        directory: true,
        symbolicLink: false,
      }),
    });

    await expect(
      validateExistingRepositoryRunner(installOptions, base.adapters),
    ).rejects.toThrow("must be distinct directories");
  });
});

describe("recoverRepositoryRunner", () => {
  it("cleans only stale runner-owned work and controller state", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 999,
        repository: metadata.repository,
      }),
    );
    base.files.set(join(maskDir, "stale"), "stale");

    const result = await recoverRepositoryRunner(
      {
        repoDir,
        runnerDir,
        maskDir,
        metadata,
        runnerEnvironment: { PATH: "/usr/bin:/bin" },
      },
      base.adapters,
    );

    expect(result).toEqual({ reRegistered: false });
    expect(base.removes).toEqual([lockPath, workPath, maskDir]);
    expect(base.directories.has(maskDir)).toBe(true);
    expect(base.files.get(join(configDir, ".env"))).toBe(
      "GH_TOKEN=runtime-token\n",
    );
    expect(base.files.get(join(configDir, "logs", "run.log"))).toBe("evidence");
    expect(
      base.files.get(join(configDir, "worktrees", "task", "work.txt")),
    ).toBe("evidence");
  });

  it("re-registers a remotely expired runner under its recorded name", async () => {
    const base = makeAdapters();
    const adapters: RunnerLifecycleAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.calls.push({ command, args, env: options.env });
        if (
          command === "gh" &&
          args.some((arg) => arg.endsWith("/registration-token"))
        ) {
          return {
            stdout: '{"token":"one-time-registration"}\n',
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
    };

    const result = await recoverRepositoryRunner(
      {
        repoDir,
        runnerDir,
        maskDir,
        metadata,
        runnerEnvironment: { PATH: "/usr/bin:/bin" },
      },
      adapters,
    );

    expect(result).toEqual({ reRegistered: true });
    const config = base.calls.find(({ command }) => command === "./config.sh");
    expect(config?.args).toEqual([
      "--url",
      metadata.repositoryUrl,
      "--token",
      "one-time-registration",
      "--name",
      metadata.name,
      "--labels",
      "shipyard",
      "--work",
      "_work",
      "--unattended",
    ]);
    expect(config?.args).not.toContain("--disableupdate");
    expect(config?.env).toEqual({ PATH: "/usr/bin:/bin" });
    expect(base.removes).toEqual(
      expect.arrayContaining([
        join(runnerDir, ".credentials"),
        join(runnerDir, ".credentials_rsaparams"),
        join(runnerDir, ".runner"),
      ]),
    );
  });

  it("leaves registration state untouched when admin authorization fails", async () => {
    const base = makeAdapters({
      run: async (command, args) => {
        if (command === "gh" && args[0] === "auth") {
          throw new Error("not an administrator");
        }
        return { stdout: "", stderr: "" };
      },
    });

    await expect(
      recoverRepositoryRunner(
        {
          repoDir,
          runnerDir,
          maskDir,
          metadata,
          runnerEnvironment: { PATH: "/usr/bin:/bin" },
        },
        base.adapters,
      ),
    ).rejects.toThrow("administrative GitHub authorization");
    expect(base.files.has(join(runnerDir, ".credentials"))).toBe(true);
    expect(base.calls.some(({ command }) => command === "./config.sh")).toBe(
      false,
    );
  });

  it("reports a re-registration failure without leaking its one-time token", async () => {
    const base = makeAdapters();
    const adapters: RunnerLifecycleAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.calls.push({ command, args, env: options.env });
        if (
          command === "gh" &&
          args.some((arg) => arg.endsWith("/registration-token"))
        ) {
          return { stdout: '{"token":"secret-repair-token"}\n', stderr: "" };
        }
        if (command === "./config.sh") throw new Error("registration failed");
        return { stdout: "", stderr: "" };
      },
    };

    const error = await recoverRepositoryRunner(
      {
        repoDir,
        runnerDir,
        maskDir,
        metadata,
        runnerEnvironment: { PATH: "/usr/bin:/bin" },
      },
      adapters,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Partial local registration files were removed",
    );
    expect((error as Error).message).toContain("orphan registration");
    expect((error as Error).message).not.toContain("secret-repair-token");
  });

  it("removes only containers with this repository runner owner label during recovery", async () => {
    const base = makeAdapters();
    const adapters: RunnerLifecycleAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        base.calls.push({ command, args, env: options.env });
        if (command === "docker" && args[0] === "ps") {
          return { stdout: "owned-a\nowned-b\n", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await recoverRepositoryRunner(
      {
        repoDir,
        runnerDir,
        maskDir,
        metadata,
        runnerEnvironment: { PATH: "/usr/bin:/bin" },
        dockerEnvironment: {
          PATH: "/usr/bin:/bin",
          DOCKER_HOST: "unix:///custom/docker.sock",
        },
      },
      adapters,
    );

    expect(base.calls).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: [
          "ps",
          "-aq",
          "--filter",
          "label=com.snappedly.shipyard.repository-runner-owner=snappedly/shipyard",
        ],
      }),
    );
    expect(base.calls).toContainEqual(
      expect.objectContaining({
        command: "docker",
        args: ["rm", "-f", "owned-a", "owned-b"],
        env: expect.objectContaining({
          DOCKER_HOST: "unix:///custom/docker.sock",
        }),
      }),
    );
  });
});

describe("removeRepositoryRunner", () => {
  it("stops a running controller before unregistering", async () => {
    const base = makeAdapters();
    base.files.set(
      lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid: 777,
        repository: metadata.repository,
        processStartedAt: "started-777",
      }),
    );
    let running = true;
    const adapters: RunnerLifecycleAdapters = {
      ...base.adapters,
      isProcessRunning: () => running,
      signalProcess: (pid, signal) => {
        base.signals.push({ pid, signal });
        running = false;
      },
    };

    await removeRepositoryRunner({ repoDir }, adapters);

    expect(base.signals).toEqual([{ pid: 777, signal: "SIGTERM" }]);
    expect(
      base.calls.find(({ command }) => command === "./config.sh"),
    ).toBeDefined();
  });

  it("stops, unregisters, and deletes only runner-owned installation files", async () => {
    const base = makeAdapters({ isProcessRunning: () => false });

    const result = await removeRepositoryRunner({ repoDir }, base.adapters);

    expect(result).toEqual({ removed: true, forced: false });
    expect(
      base.calls.find(({ command }) => command === "./config.sh")?.args,
    ).toEqual(["remove", "--token", "one-time-removal", "--unattended"]);
    expect(base.removes.at(-1)).toBe(runnerDir);
    expect(base.files.get(join(configDir, ".env"))).toBe(
      "GH_TOKEN=runtime-token\n",
    );
    expect(base.files.get(join(configDir, "logs", "run.log"))).toBe("evidence");
    expect(
      base.files.get(join(configDir, "worktrees", "task", "work.txt")),
    ).toBe("evidence");
  });

  it("keeps local registration when GitHub unregistration fails", async () => {
    const base = makeAdapters({
      run: async (command) => {
        if (command === "gh") throw new Error("GitHub unavailable");
        return { stdout: "", stderr: "" };
      },
    });

    await expect(
      removeRepositoryRunner({ repoDir }, base.adapters),
    ).rejects.toThrow("Local runner files were preserved");
    expect(base.directories.has(runnerDir)).toBe(true);
    expect(base.files.has(metadataPath)).toBe(true);
  });

  it("force-removes local files and returns manual orphan cleanup guidance", async () => {
    const base = makeAdapters({
      run: async (command) => {
        if (command === "gh") throw new Error("GitHub unavailable");
        return { stdout: "", stderr: "" };
      },
    });

    const result = await removeRepositoryRunner(
      { repoDir, force: true },
      base.adapters,
    );

    expect(result).toEqual({
      removed: true,
      forced: true,
      manualCleanup:
        "Remove runner shipyard-shipyard-test-mac from snappedly/shipyard in GitHub Settings > Actions > Runners.",
    });
    expect(base.directories.has(runnerDir)).toBe(false);
    expect(base.files.get(join(configDir, ".env"))).toBe(
      "GH_TOKEN=runtime-token\n",
    );
  });

  it("force-removes an incomplete installation without trusting invalid metadata", async () => {
    const base = makeAdapters();
    base.files.set(metadataPath, "not-json");

    const result = await removeRepositoryRunner(
      { repoDir, force: true },
      base.adapters,
    );

    expect(result).toEqual({
      removed: true,
      forced: true,
      manualCleanup:
        "Check GitHub Settings > Actions > Runners and manually remove any orphan repository runner registration.",
    });
    expect(base.directories.has(runnerDir)).toBe(false);
    expect(base.files.has(join(configDir, ".env"))).toBe(true);
  });
});
