import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { resolveEnv } from "./EnvResolver.js";
import {
  parseGitHubRepository,
  repositoryRunnerEnvironment,
} from "./RepositoryRunner.js";
import { ACTIVATION_LABEL, CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";

const execFileAsync = promisify(execFile);
const INSTALL_METADATA = ".shipyard-install.json";
const CONTROLLER_LOCK = ".shipyard-controller.lock";
const CONTROLLER_STATE = ".shipyard-state.json";
const LAST_FAILURE = ".shipyard-last-failure.json";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export class RunnerControlError extends Error {
  readonly name = "RunnerControlError";
}

export interface RepositoryRunnerChild {
  readonly pid: number;
  readonly wait: () => Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly terminate: (signal: NodeJS.Signals) => void;
}

/** Internal seams for process, GitHub, filesystem, credentials, and shutdown tests. */
export interface RunnerControlAdapters {
  readonly platform: () => NodeJS.Platform | string;
  readonly arch: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly currentPid: () => number;
  readonly exists: (path: string) => Promise<boolean>;
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly writeExclusive: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly commandExists: (command: string) => Promise<boolean>;
  readonly resolveEnvironment: (
    repoDir: string,
  ) => Promise<Record<string, string>>;
  readonly run: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => RepositoryRunnerChild;
  readonly isProcessRunning: (pid: number) => boolean;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly onShutdown: (handler: () => Promise<void>) => () => void;
}

interface RunnerInstallMetadata {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly name: string;
  readonly label: string;
  readonly version: string;
}

interface RunnerControllerLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly repository: string;
}

type RunnerControllerStateName = "idle" | "processing" | "stopping" | "stopped";

interface RunnerControllerState {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly state: RunnerControllerStateName;
  readonly lastOutcome: string;
}

export interface RepositoryRunnerStartResult {
  readonly repository: string;
  readonly initialWorkFound: boolean;
}

export interface RepositoryRunnerStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly pid?: number;
  readonly github: "online" | "offline" | "unreachable" | "not-installed";
  readonly repository?: string;
  readonly state: RunnerControllerStateName | "not-installed";
  readonly lastOutcome: string;
}

const spawnForegroundChild = (
  command: string,
  args: readonly string[],
  options: CommandOptions,
): RepositoryRunnerChild => {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
    detached: true,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new RunnerControlError(`Could not start ${command}.`);
  }
  const result = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid,
    wait: () => result,
    terminate: (signal) => {
      try {
        process.kill(-pid, signal);
      } catch {
        child.kill(signal);
      }
    },
  };
};

const registerRunnerShutdown = (handler: () => Promise<void>): (() => void) => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let handling = false;
  const listeners = new Map<NodeJS.Signals, () => void>();
  const unregister = () => {
    for (const [signal, listener] of listeners) {
      process.removeListener(signal, listener);
    }
    listeners.clear();
  };

  for (const signal of signals) {
    const listener = () => {
      if (handling) return;
      handling = true;
      void handler().finally(() => {
        unregister();
        process.exit(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129,
        );
      });
    };
    listeners.set(signal, listener);
    process.once(signal, listener);
  }
  return unregister;
};

const defaultAdapters: RunnerControlAdapters = {
  platform: () => process.platform,
  arch: () => process.arch,
  environment: () => process.env,
  currentPid: () => process.pid,
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, content) => writeFile(path, content, { mode: 0o600 }),
  writeExclusive: (path, content) =>
    writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }),
  remove: (path) => rm(path, { force: true }),
  commandExists: async (command) => {
    try {
      await execFileAsync("which", [command]);
      return true;
    } catch {
      return false;
    }
  },
  resolveEnvironment: (repoDir) =>
    Effect.runPromise(
      resolveEnv(repoDir).pipe(Effect.provide(NodeFileSystem.layer)),
    ),
  run: async (command, args, options) => {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
  spawn: spawnForegroundChild,
  isProcessRunning: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signalProcess: (pid, signal) => process.kill(pid, signal),
  onShutdown: registerRunnerShutdown,
};

const readJson = async <T>(
  path: string,
  adapters: RunnerControlAdapters,
): Promise<T | undefined> => {
  if (!(await adapters.exists(path))) return undefined;
  try {
    return JSON.parse(await adapters.readText(path)) as T;
  } catch (error) {
    throw new RunnerControlError(
      `Could not read repository runner state at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const writeJson = (
  path: string,
  value: object,
  adapters: RunnerControlAdapters,
): Promise<void> =>
  adapters.writeText(path, `${JSON.stringify(value, null, 2)}\n`);

const controlFailure = (purpose: string, error: unknown): RunnerControlError =>
  error instanceof RunnerControlError
    ? error
    : new RunnerControlError(
        `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`,
      );

const runCommand = async (
  adapters: RunnerControlAdapters,
  purpose: string,
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> => {
  try {
    return await adapters.run(command, args, options);
  } catch (error) {
    throw controlFailure(purpose, error);
  }
};

const requireCommand = async (
  adapters: RunnerControlAdapters,
  command: string,
  purpose: string,
): Promise<void> => {
  if (!(await adapters.commandExists(command))) {
    throw new RunnerControlError(
      `Missing required command \`${command}\` (${purpose}). Install it and retry.`,
    );
  }
};

interface RunnerControlContext {
  readonly runnerDir: string;
  readonly repository: string;
  readonly hostEnvironment: NodeJS.ProcessEnv;
  readonly runtimeEnvironment: NodeJS.ProcessEnv;
}

const requireRunnerContext = async (
  repoDir: string,
  adapters: RunnerControlAdapters,
): Promise<RunnerControlContext> => {
  if (adapters.platform() !== "darwin" || adapters.arch() !== "arm64") {
    throw new RunnerControlError(
      "Repository runners currently require Apple Silicon macOS (darwin/arm64).",
    );
  }

  const configDir = join(repoDir, CONFIG_DIR);
  const runnerDir = join(configDir, RUNNER_DIR);
  if (!(await adapters.exists(configDir))) {
    throw new RunnerControlError(
      `No ${CONFIG_DIR}/ found. Run \`shipyard init\` in this repository first.`,
    );
  }
  if (!(await adapters.exists(runnerDir))) {
    throw new RunnerControlError(
      `No repository runner is installed at ${runnerDir}. Run \`shipyard runner install\` first.`,
    );
  }

  const metadata = await readJson<RunnerInstallMetadata>(
    join(runnerDir, INSTALL_METADATA),
    adapters,
  );
  if (
    metadata?.schemaVersion !== 1 ||
    typeof metadata.repository !== "string" ||
    typeof metadata.name !== "string" ||
    metadata.label !== ACTIVATION_LABEL
  ) {
    throw new RunnerControlError(
      "The repository runner installation metadata is missing or invalid. Reinstall the repository runner.",
    );
  }
  if (!(await adapters.exists(join(runnerDir, ".credentials")))) {
    throw new RunnerControlError(
      "The repository runner credentials are missing. Reinstall the repository runner.",
    );
  }
  if (!(await adapters.exists(join(runnerDir, "run.sh")))) {
    throw new RunnerControlError(
      "The official repository runner executable is missing. Reinstall the repository runner.",
    );
  }

  for (const [command, purpose] of [
    ["git", "reading the repository remote"],
    ["npx", "running the local Shipyard package"],
    ["docker", "checking the Docker runtime"],
    ["gh", "checking GitHub access"],
  ] as const) {
    await requireCommand(adapters, command, purpose);
  }

  const hostEnvironment = adapters.environment();
  const resolvedEnvironment = await adapters
    .resolveEnvironment(repoDir)
    .catch((error) => {
      throw controlFailure("Resolving repository credentials", error);
    });
  const runtimeEnvironment = { ...hostEnvironment, ...resolvedEnvironment };
  const remote = await runCommand(
    adapters,
    "Reading the origin remote",
    "git",
    ["remote", "get-url", "origin"],
    { cwd: repoDir, env: runtimeEnvironment },
  );
  let identity: { owner: string; repository: string };
  try {
    identity = parseGitHubRepository(remote.stdout);
  } catch (error) {
    throw new RunnerControlError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const repository = `${identity.owner}/${identity.repository}`;
  if (repository !== metadata.repository) {
    throw new RunnerControlError(
      `The installed repository runner belongs to ${metadata.repository}, but this repository origin is ${repository}. Reinstall it for this repository.`,
    );
  }

  await runCommand(
    adapters,
    "Checking the local Shipyard package",
    "npx",
    ["--no-install", "shipyard", "--version"],
    { cwd: repoDir, env: runtimeEnvironment },
  );
  await runCommand(
    adapters,
    "Checking Docker availability",
    "docker",
    ["info"],
    { cwd: repoDir, env: runtimeEnvironment },
  );
  await runCommand(
    adapters,
    "Checking GitHub authentication",
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { cwd: repoDir, env: runtimeEnvironment },
  );

  const label = await runCommand(
    adapters,
    "Checking the activation label",
    "gh",
    [
      "label",
      "list",
      "--repo",
      repository,
      "--json",
      "name",
      "--jq",
      `.[] | select(.name == "${ACTIVATION_LABEL}") | .name`,
    ],
    { cwd: repoDir, env: runtimeEnvironment },
  );
  if (label.stdout.trim() !== ACTIVATION_LABEL) {
    await runCommand(
      adapters,
      "Creating the activation label",
      "gh",
      [
        "label",
        "create",
        ACTIVATION_LABEL,
        "--repo",
        repository,
        "--color",
        "1D76DB",
        "--description",
        "Tasks available to the Shipyard repository runner",
        "--force",
      ],
      { cwd: repoDir, env: runtimeEnvironment },
    );
  }

  return {
    runnerDir,
    repository,
    hostEnvironment,
    runtimeEnvironment,
  };
};

const childFailure = (
  command: string,
  result: { code: number | null; signal: NodeJS.Signals | null },
): RunnerControlError =>
  new RunnerControlError(
    result.signal === null
      ? `${command} exited with code ${result.code ?? "unknown"}.`
      : `${command} was terminated by ${result.signal}.`,
  );

const stopChildBounded = async (
  child: RepositoryRunnerChild,
): Promise<void> => {
  child.terminate("SIGTERM");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    child.wait().then(() => true),
    new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), 5_000);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  if (!stopped) child.terminate("SIGKILL");
};

export const startRepositoryRunner = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<RepositoryRunnerStartResult> => {
  const context = await requireRunnerContext(options.repoDir, adapters);
  const lockPath = join(context.runnerDir, CONTROLLER_LOCK);
  const statePath = join(context.runnerDir, CONTROLLER_STATE);
  const failurePath = join(context.runnerDir, LAST_FAILURE);
  const existingLock = await readJson<RunnerControllerLock>(lockPath, adapters);
  if (
    existingLock &&
    Number.isInteger(existingLock.pid) &&
    adapters.isProcessRunning(existingLock.pid)
  ) {
    throw new RunnerControlError(
      `The repository runner is already running with process ${existingLock.pid}.`,
    );
  }
  if (existingLock) {
    throw new RunnerControlError(
      "The repository runner has stale process state. Run it again after recovery or remove the stale installation.",
    );
  }

  const lock: RunnerControllerLock = {
    schemaVersion: 1,
    pid: adapters.currentPid(),
    repository: context.repository,
  };
  try {
    await adapters.writeExclusive(lockPath, `${JSON.stringify(lock)}\n`);
  } catch (error) {
    throw controlFailure("Claiming the repository runner process", error);
  }

  let activeChild: RepositoryRunnerChild | undefined;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;
  const saveState = (state: RunnerControllerStateName, lastOutcome: string) =>
    writeJson(
      statePath,
      {
        schemaVersion: 1,
        repository: context.repository,
        state,
        lastOutcome,
      } satisfies RunnerControllerState,
      adapters,
    );
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopping = true;
      await saveState("stopping", "Stopping repository runner");
      if (activeChild) await stopChildBounded(activeChild);
      await saveState("stopped", "Stopped by signal");
      await adapters.remove(lockPath);
    })();
    return shutdownPromise;
  };
  const unregisterShutdown = adapters.onShutdown(shutdown);

  let initialWorkFound = false;
  try {
    const issues = await runCommand(
      adapters,
      "Checking for eligible GitHub issues",
      "gh",
      [
        "issue",
        "list",
        "--repo",
        context.repository,
        "--state",
        "open",
        "--label",
        ACTIVATION_LABEL,
        "--limit",
        "1",
        "--json",
        "number",
        "--jq",
        ".[].number",
      ],
      { cwd: options.repoDir, env: context.runtimeEnvironment },
    );
    initialWorkFound = issues.stdout.trim().length > 0;
    if (stopping) {
      await shutdownPromise;
      return { repository: context.repository, initialWorkFound };
    }

    if (initialWorkFound) {
      await saveState("processing", "Shipyard is processing eligible issues");
      activeChild = adapters.spawn("npx", ["shipyard", "run"], {
        cwd: options.repoDir,
        env: context.runtimeEnvironment,
      });
      const runResult = await activeChild.wait();
      activeChild = undefined;
      if (stopping) {
        await shutdownPromise;
        return { repository: context.repository, initialWorkFound };
      }
      if (runResult.code !== 0) {
        const failure = childFailure("npx shipyard run", runResult);
        await writeJson(
          failurePath,
          {
            schemaVersion: 1,
            repository: context.repository,
            message: failure.message,
            recordedAt: new Date().toISOString(),
          },
          adapters,
        );
        await saveState("stopped", failure.message);
        throw failure;
      }
      await saveState("idle", "Shipyard completed successfully");
    } else {
      await saveState("idle", "No eligible issues; listening");
    }

    activeChild = adapters.spawn("./run.sh", [], {
      cwd: context.runnerDir,
      env: repositoryRunnerEnvironment(context.hostEnvironment),
    });
    const listenerResult = await activeChild.wait();
    activeChild = undefined;
    if (stopping) {
      await shutdownPromise;
      return { repository: context.repository, initialWorkFound };
    }
    if (listenerResult.code !== 0) {
      const failure = childFailure(
        "Repository runner listener",
        listenerResult,
      );
      await writeJson(
        failurePath,
        {
          schemaVersion: 1,
          repository: context.repository,
          message: failure.message,
          recordedAt: new Date().toISOString(),
        },
        adapters,
      );
      await saveState("stopped", failure.message);
      throw failure;
    }
    await saveState("stopped", "Repository runner listener exited");
    return { repository: context.repository, initialWorkFound };
  } finally {
    unregisterShutdown();
    await adapters.remove(lockPath);
  }
};

export const getRepositoryRunnerStatus = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<RepositoryRunnerStatus> => {
  const runnerDir = join(options.repoDir, CONFIG_DIR, RUNNER_DIR);
  const metadata = await readJson<RunnerInstallMetadata>(
    join(runnerDir, INSTALL_METADATA),
    adapters,
  );
  if (!metadata) {
    return {
      installed: false,
      running: false,
      github: "not-installed",
      state: "not-installed",
      lastOutcome: "Repository runner is not installed",
    };
  }

  const lock = await readJson<RunnerControllerLock>(
    join(runnerDir, CONTROLLER_LOCK),
    adapters,
  );
  const state = await readJson<RunnerControllerState>(
    join(runnerDir, CONTROLLER_STATE),
    adapters,
  );
  const running =
    lock !== undefined &&
    Number.isInteger(lock.pid) &&
    adapters.isProcessRunning(lock.pid);
  let github: RepositoryRunnerStatus["github"] = "unreachable";
  try {
    const resolvedEnvironment = await adapters.resolveEnvironment(
      options.repoDir,
    );
    const response = await adapters.run(
      "gh",
      [
        "api",
        `repos/${metadata.repository}/actions/runners`,
        "--jq",
        `.runners[] | select(.name == "${metadata.name}") | .status`,
      ],
      {
        cwd: options.repoDir,
        env: { ...adapters.environment(), ...resolvedEnvironment },
      },
    );
    github = response.stdout.trim() === "online" ? "online" : "offline";
  } catch {
    github = "unreachable";
  }

  return {
    installed: true,
    running,
    ...(lock ? { pid: lock.pid } : {}),
    github,
    repository: metadata.repository,
    state: state?.state ?? (running ? "idle" : "stopped"),
    lastOutcome: state?.lastOutcome ?? "No repository runner outcome recorded",
  };
};

export const stopRepositoryRunner = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<{ readonly pid: number }> => {
  const lockPath = join(
    options.repoDir,
    CONFIG_DIR,
    RUNNER_DIR,
    CONTROLLER_LOCK,
  );
  const lock = await readJson<RunnerControllerLock>(lockPath, adapters);
  if (!lock || !Number.isInteger(lock.pid)) {
    throw new RunnerControlError("The repository runner is not running.");
  }
  if (!adapters.isProcessRunning(lock.pid)) {
    throw new RunnerControlError(
      `The repository runner process ${lock.pid} is no longer running; recovery is required.`,
    );
  }
  try {
    adapters.signalProcess(lock.pid, "SIGTERM");
  } catch (error) {
    throw controlFailure("Stopping the repository runner", error);
  }
  return { pid: lock.pid };
};
