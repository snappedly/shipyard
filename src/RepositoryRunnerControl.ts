import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { resolveEnv } from "./EnvResolver.js";
import { parseGitHubRepository } from "./RepositoryRunner.js";
import {
  repositoryRunnerEnvironment,
  type ProtectedDirectoryIdentity,
} from "./runnerSecurity.js";
import {
  createRepositoryRunnerWakeSubscription,
  requirePublishedRepositoryRunnerWorkflow,
} from "./RepositoryRunnerWake.js";
import {
  removeOwnedRepositoryRunnerContainers,
  recoverRepositoryRunner,
  RUNNER_CONTROLLER_LOCK,
  RUNNER_INSTALL_METADATA,
  RUNNER_WORK_DIR,
  RunnerLifecycleError,
  REPOSITORY_RUNNER_OWNER_ENV,
  type RunnerInstallMetadata,
  type RunnerLifecycleAdapters,
} from "./RepositoryRunnerLifecycle.js";
import {
  ACTIVATION_LABEL,
  CONFIG_DIR,
  RUNNER_DIR,
  RUNNER_SANDBOX_MASK_DIR,
} from "./runtimeNames.js";
import {
  DEFAULT_LOG_RETENTION_DAYS,
  purgeRunLogs,
  type PurgeRunLogsOptions,
  type PurgeRunLogsResult,
} from "./LogRetention.js";

const execFileAsync = promisify(execFile);
const CONTROLLER_STATE = ".shipyard-state.json";
const LAST_FAILURE = ".shipyard-last-failure.json";
const LOG_PURGE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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

const retainedFailures = new WeakSet<RunnerControlError>();

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
  readonly processIdentity: (pid: number) => Promise<string | undefined>;
  readonly exists: (path: string) => Promise<boolean>;
  readonly inspectDirectory?: (
    path: string,
  ) => Promise<ProtectedDirectoryIdentity>;
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly writeExclusive: (path: string, content: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly removeTree: (path: string) => Promise<void>;
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
  readonly onWake?: (handler: () => void) => () => void;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly now: () => Date;
  readonly purgeRunLogs: (
    options: PurgeRunLogsOptions,
  ) => Promise<PurgeRunLogsResult>;
  readonly scheduleRecurring: (
    task: () => Promise<void>,
    milliseconds: number,
  ) => () => void;
  readonly report: (message: string) => void;
}

interface RunnerControllerLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly repository: string;
  readonly processStartedAt: string;
}

type RunnerControllerStateName =
  | "idle"
  | "processing"
  | "stalled"
  | "stopping"
  | "stopped";

interface RunnerWakeRecord {
  readonly source: "startup" | "signal";
  readonly recordedAt: string;
}

interface RunnerControllerState {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly state: RunnerControllerStateName;
  readonly lastOutcome: string;
  readonly lastWake?: RunnerWakeRecord;
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
  readonly lastWake?: RunnerWakeRecord;
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
  processIdentity: async (pid) => {
    try {
      const result = await execFileAsync("ps", [
        "-p",
        String(pid),
        "-o",
        "lstart=",
      ]);
      const identity = result.stdout.trim().replace(/\s+/g, " ");
      return identity.length > 0 ? identity : undefined;
    } catch {
      return undefined;
    }
  },
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  inspectDirectory: async (path) => {
    const [stat, resolved] = await Promise.all([lstat(path), realpath(path)]);
    return {
      realPath: resolved,
      directory: stat.isDirectory(),
      symbolicLink: stat.isSymbolicLink(),
    };
  },
  readText: (path) => readFile(path, "utf8"),
  writeText: (path, content) => writeFile(path, content, { mode: 0o600 }),
  writeExclusive: (path, content) =>
    writeFile(path, content, { encoding: "utf8", mode: 0o600, flag: "wx" }),
  remove: (path) => rm(path, { force: true }),
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  removeTree: (path) => rm(path, { recursive: true, force: true }),
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
  pause: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => new Date(),
  purgeRunLogs,
  scheduleRecurring: (task, milliseconds) => {
    const timer = setInterval(() => {
      void task();
    }, milliseconds);
    return () => clearInterval(timer);
  },
  report: (message) => console.log(message),
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
  readonly maskDir: string;
  readonly repository: string;
  readonly metadata: RunnerInstallMetadata;
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
  const maskDir = join(configDir, RUNNER_SANDBOX_MASK_DIR);
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
  if (adapters.inspectDirectory) {
    const runnerIdentity = await adapters
      .inspectDirectory(runnerDir)
      .catch((error) => {
        throw controlFailure(
          "Inspecting the protected runner directory",
          error,
        );
      });
    if (!runnerIdentity.directory || runnerIdentity.symbolicLink) {
      throw new RunnerControlError(
        `The protected repository runner path must be a real directory: ${runnerDir}`,
      );
    }
  }

  const metadata = await readJson<RunnerInstallMetadata>(
    join(runnerDir, RUNNER_INSTALL_METADATA),
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
  const runtimeEnvironment = {
    ...hostEnvironment,
    ...resolvedEnvironment,
    [REPOSITORY_RUNNER_OWNER_ENV]: metadata.repository,
  };
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
    { cwd: repoDir, env: hostEnvironment },
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
    { cwd: repoDir, env: hostEnvironment },
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
      { cwd: repoDir, env: hostEnvironment },
    );
  }

  await requirePublishedRepositoryRunnerWorkflow(
    {
      repoDir,
      repository,
      // The published workflow is an administrative runner preflight. Keep
      // it on the host's gh login instead of the issue-agent token from
      // .shipyard/.env, which intentionally only needs issue permissions.
      environment: hostEnvironment,
    },
    adapters,
  ).catch((error) => {
    throw new RunnerControlError(
      error instanceof Error ? error.message : String(error),
    );
  });

  return {
    runnerDir,
    maskDir,
    repository,
    metadata,
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
  pause: (milliseconds: number) => Promise<void>,
): Promise<void> => {
  child.terminate("SIGTERM");
  const stopped = await Promise.race([
    child.wait().then(() => true),
    pause(5_000).then(() => false),
  ]);
  if (stopped) return;
  child.terminate("SIGKILL");
  const killed = await Promise.race([
    child.wait().then(() => true),
    pause(1_000).then(() => false),
  ]);
  if (!killed) {
    throw new RunnerControlError(
      `Process ${child.pid} did not exit after SIGKILL.`,
    );
  }
};

const lockOwnsProcess = async (
  lock: RunnerControllerLock | undefined,
  adapters: Pick<RunnerControlAdapters, "isProcessRunning" | "processIdentity">,
): Promise<boolean> =>
  lock !== undefined &&
  Number.isInteger(lock.pid) &&
  typeof lock.processStartedAt === "string" &&
  lock.processStartedAt.length > 0 &&
  adapters.isProcessRunning(lock.pid) &&
  (await adapters.processIdentity(lock.pid)) === lock.processStartedAt;

const bestEffort = async (operation: () => Promise<unknown>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Cleanup and diagnostic persistence must not hide the triggering failure.
  }
};

const startRepositoryRunnerManaged = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<RepositoryRunnerStartResult> => {
  const context = await requireRunnerContext(options.repoDir, adapters);
  const lifecycleAdapters: RunnerLifecycleAdapters = {
    environment: adapters.environment,
    exists: adapters.exists,
    readText: adapters.readText,
    makeDirectory: adapters.makeDirectory,
    inspectDirectory: adapters.inspectDirectory,
    remove: adapters.removeTree,
    run: adapters.run,
    isProcessRunning: adapters.isProcessRunning,
    signalProcess: adapters.signalProcess,
    pause: adapters.pause,
    processIdentity: adapters.processIdentity,
  };
  await recoverRepositoryRunner(
    {
      repoDir: options.repoDir,
      runnerDir: context.runnerDir,
      maskDir: context.maskDir,
      metadata: context.metadata,
      runnerEnvironment: repositoryRunnerEnvironment(context.hostEnvironment),
      dockerEnvironment: context.runtimeEnvironment,
    },
    lifecycleAdapters,
  ).catch((error) => {
    throw new RunnerControlError(
      error instanceof RunnerLifecycleError
        ? error.message
        : `Repository runner recovery failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const lockPath = join(context.runnerDir, RUNNER_CONTROLLER_LOCK);
  const statePath = join(context.runnerDir, CONTROLLER_STATE);
  const failurePath = join(context.runnerDir, LAST_FAILURE);
  const existingLock = await readJson<RunnerControllerLock>(lockPath, adapters);
  if (await lockOwnsProcess(existingLock, adapters)) {
    throw new RunnerControlError(
      `The repository runner is already running with process ${existingLock!.pid}.`,
    );
  }
  if (existingLock) {
    throw new RunnerControlError(
      "The repository runner has stale process state. Run it again after recovery or remove the stale installation.",
    );
  }

  const controllerPid = adapters.currentPid();
  const processStartedAt = await adapters.processIdentity(controllerPid);
  if (!processStartedAt) {
    throw new RunnerControlError(
      "Could not establish the repository runner controller process identity.",
    );
  }
  const lock: RunnerControllerLock = {
    schemaVersion: 1,
    pid: controllerPid,
    repository: context.repository,
    processStartedAt,
  };
  try {
    await adapters.writeExclusive(lockPath, `${JSON.stringify(lock)}\n`);
  } catch (error) {
    throw controlFailure("Claiming the repository runner process", error);
  }

  let listenerChild: RepositoryRunnerChild | undefined;
  let shipyardChild: RepositoryRunnerChild | undefined;
  let cancelLogPurge: (() => void) | undefined;
  let stopping = false;
  let lastWake: RunnerWakeRecord | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let primaryFailure: RunnerControlError | undefined;
  const saveState = async (
    state: RunnerControllerStateName,
    lastOutcome: string,
  ): Promise<void> => {
    await writeJson(
      statePath,
      {
        schemaVersion: 1,
        repository: context.repository,
        state,
        lastOutcome,
        ...(lastWake ? { lastWake } : {}),
      } satisfies RunnerControllerState,
      adapters,
    );
    adapters.report(`[repository runner] ${state}: ${lastOutcome}`);
  };
  const purgeLogs = async (): Promise<void> => {
    if (stopping || shipyardChild !== undefined) return;
    try {
      const result = await adapters.purgeRunLogs({
        repoDir: options.repoDir,
        retentionDays: DEFAULT_LOG_RETENTION_DAYS,
        now: adapters.now(),
      });
      const removed = result.removedCount;
      if (removed > 0) {
        adapters.report(
          `[repository runner] purged ${removed} outdated run-log ${removed === 1 ? "entry" : "entries"}`,
        );
      }
    } catch (error) {
      adapters.report(
        `[repository runner] log purge skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const removeTransientWork = () =>
    adapters.removeTree(join(context.runnerDir, RUNNER_WORK_DIR));
  const removeOwnedContainers = () =>
    removeOwnedRepositoryRunnerContainers(
      {
        repoDir: options.repoDir,
        repository: context.repository,
        environment: context.runtimeEnvironment,
      },
      lifecycleAdapters,
    );
  const attemptCleanup = async (
    failures: string[],
    purpose: string,
    operation: () => Promise<unknown>,
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      const message = `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      adapters.report(`[repository runner] cleanup error: ${message}`);
    }
  };
  const persistCleanupFailures = async (
    failures: readonly string[],
  ): Promise<void> => {
    if (failures.length === 0) return;
    const cleanupMessage = `Repository runner cleanup failed: ${failures.join("; ")}`;
    const message = primaryFailure
      ? `${primaryFailure.message} ${cleanupMessage}`
      : cleanupMessage;
    await bestEffort(() =>
      writeJson(
        failurePath,
        {
          schemaVersion: 1,
          repository: context.repository,
          message,
          recordedAt: adapters.now().toISOString(),
        },
        adapters,
      ).then(() => {
        if (primaryFailure) retainedFailures.add(primaryFailure);
      }),
    );
    await bestEffort(() => saveState("stopped", cleanupMessage));
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      stopping = true;
      const failures: string[] = [];
      const children = [listenerChild, shipyardChild].filter(
        (child): child is RepositoryRunnerChild => child !== undefined,
      );
      listenerChild = undefined;
      shipyardChild = undefined;
      await Promise.all(
        children.map((child) =>
          attemptCleanup(failures, `Stopping process ${child.pid}`, () =>
            stopChildBounded(child, adapters.pause),
          ),
        ),
      );
      await attemptCleanup(
        failures,
        "Removing repository-runner containers",
        removeOwnedContainers,
      );
      await attemptCleanup(
        failures,
        "Removing transient runner work",
        removeTransientWork,
      );
      await attemptCleanup(failures, "Removing controller lock", () =>
        adapters.remove(lockPath),
      );
      if (failures.length === 0) {
        try {
          await saveState("stopped", "Stopped by signal");
        } catch (error) {
          const message = `Persisting stopped state failed: ${error instanceof Error ? error.message : String(error)}`;
          failures.push(message);
          adapters.report(`[repository runner] cleanup error: ${message}`);
        }
      }
      await persistCleanupFailures(failures);
    })();
    return shutdownPromise;
  };
  const unregisterShutdown = adapters.onShutdown(shutdown);
  const wakeSubscription = createRepositoryRunnerWakeSubscription(
    adapters.onWake,
  );

  let initialWorkFound = false;
  try {
    await purgeLogs();
    cancelLogPurge = adapters.scheduleRecurring(
      purgeLogs,
      LOG_PURGE_CHECK_INTERVAL_MS,
    );

    const listEligibleIssueNumbers = async (): Promise<readonly string[]> => {
      const issues = await runCommand(
        adapters,
        "Checking for eligible GitHub issues",
        "gh",
        [
          "api",
          "--method",
          "GET",
          "--paginate",
          `repos/${context.repository}/issues`,
          "-f",
          "state=open",
          "-f",
          `labels=${ACTIVATION_LABEL}`,
          "-f",
          "per_page=100",
          "--jq",
          ".[] | select(.pull_request == null) | .number",
        ],
        { cwd: options.repoDir, env: context.runtimeEnvironment },
      );
      return [...new Set(issues.stdout.split(/\s+/).filter(Boolean))].sort(
        (left, right) => Number(left) - Number(right),
      );
    };
    const sameIssueNumbers = (
      left: readonly string[],
      right: readonly string[],
    ): boolean =>
      left.length === right.length &&
      left.every((issue, index) => issue === right[index]);
    const processEligibleWork = async (): Promise<boolean> => {
      let issueNumbers = await listEligibleIssueNumbers();
      const workFound = issueNumbers.length > 0;

      while (!stopping && issueNumbers.length > 0) {
        await saveState("processing", "Shipyard is processing eligible issues");
        shipyardChild = adapters.spawn("npx", ["shipyard", "run"], {
          cwd: options.repoDir,
          env: context.runtimeEnvironment,
        });
        const runResult = await shipyardChild.wait();
        shipyardChild = undefined;
        if (stopping) {
          await shutdownPromise;
          return workFound;
        }
        if (runResult.code !== 0) {
          const failure = childFailure("npx shipyard run", runResult);
          await writeJson(
            failurePath,
            {
              schemaVersion: 1,
              repository: context.repository,
              message: failure.message,
              recordedAt: adapters.now().toISOString(),
            },
            adapters,
          );
          await saveState("stopped", failure.message);
          throw failure;
        }

        const nextIssueNumbers = await listEligibleIssueNumbers();
        if (nextIssueNumbers.length === 0) {
          await saveState("idle", "Shipyard completed; no eligible issues");
          break;
        }
        if (sameIssueNumbers(issueNumbers, nextIssueNumbers)) {
          await saveState(
            "stalled",
            "Shipyard made no progress; eligible issues are unchanged",
          );
          break;
        }
        issueNumbers = nextIssueNumbers;
      }

      return workFound;
    };

    lastWake = {
      source: "startup",
      recordedAt: adapters.now().toISOString(),
    };
    initialWorkFound = await processEligibleWork();
    if (stopping) {
      await shutdownPromise;
      return { repository: context.repository, initialWorkFound };
    }

    if (!initialWorkFound) {
      await saveState("idle", "No eligible issues; listening");
    }

    listenerChild = adapters.spawn("./run.sh", [], {
      cwd: context.runnerDir,
      env: repositoryRunnerEnvironment(context.hostEnvironment),
    });
    const listenerExit = listenerChild.wait().then((result) => ({
      type: "listener" as const,
      result,
    }));

    let listenerResult:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined;
    while (!listenerResult && !stopping) {
      const event = await Promise.race([
        listenerExit,
        wakeSubscription.next().then(() => ({ type: "wake" as const })),
      ]);
      if (event.type === "listener") {
        listenerResult = event.result;
        listenerChild = undefined;
        break;
      }
      if (stopping) break;
      lastWake = {
        source: "signal",
        recordedAt: adapters.now().toISOString(),
      };
      const workFound = await processEligibleWork();
      if (!workFound && !stopping) {
        await saveState("idle", "Wake-up delivered; no eligible issues");
      }
    }

    if (stopping) {
      await shutdownPromise;
      return { repository: context.repository, initialWorkFound };
    }
    if (!listenerResult) {
      throw new RunnerControlError(
        "The repository runner listener stopped without an exit result.",
      );
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
          recordedAt: adapters.now().toISOString(),
        },
        adapters,
      );
      await saveState("stopped", failure.message);
      throw failure;
    }
    await saveState("stopped", "Repository runner listener exited");
    return { repository: context.repository, initialWorkFound };
  } catch (error) {
    const failure = controlFailure("Repository runner controller", error);
    primaryFailure = failure;
    await bestEffort(() =>
      writeJson(
        failurePath,
        {
          schemaVersion: 1,
          repository: context.repository,
          message: failure.message,
          recordedAt: adapters.now().toISOString(),
        },
        adapters,
      ).then(() => retainedFailures.add(failure)),
    );
    await bestEffort(() => saveState("stopped", failure.message));
    throw failure;
  } finally {
    if (cancelLogPurge !== undefined) {
      cancelLogPurge();
      cancelLogPurge = undefined;
    }
    wakeSubscription.close();
    unregisterShutdown();
    if (shutdownPromise) {
      await shutdownPromise;
    } else {
      const failures: string[] = [];
      if (listenerChild) {
        await attemptCleanup(
          failures,
          `Stopping process ${listenerChild.pid}`,
          () => stopChildBounded(listenerChild!, adapters.pause),
        );
      }
      if (shipyardChild) {
        await attemptCleanup(
          failures,
          `Stopping process ${shipyardChild.pid}`,
          () => stopChildBounded(shipyardChild!, adapters.pause),
        );
      }
      await attemptCleanup(
        failures,
        "Removing repository-runner containers",
        removeOwnedContainers,
      );
      await attemptCleanup(
        failures,
        "Removing transient runner work",
        removeTransientWork,
      );
      await attemptCleanup(failures, "Removing controller lock", () =>
        adapters.remove(lockPath),
      );
      await persistCleanupFailures(failures);
    }
  }
};

export const startRepositoryRunner = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<RepositoryRunnerStartResult> => {
  try {
    return await startRepositoryRunnerManaged(options, adapters);
  } catch (error) {
    const failure = controlFailure("Repository runner startup", error);
    if (retainedFailures.has(failure)) throw failure;
    const runnerDir = join(options.repoDir, CONFIG_DIR, RUNNER_DIR);
    if (await adapters.exists(runnerDir)) {
      const metadata = await readJson<RunnerInstallMetadata>(
        join(runnerDir, RUNNER_INSTALL_METADATA),
        adapters,
      ).catch(() => undefined);
      const repository = metadata?.repository ?? "unknown";
      for (const [purpose, operation] of [
        [
          "failure diagnostics",
          () =>
            writeJson(
              join(runnerDir, LAST_FAILURE),
              {
                schemaVersion: 1,
                repository,
                message: failure.message,
                recordedAt: adapters.now().toISOString(),
              },
              adapters,
            ),
        ],
        [
          "stopped state",
          () =>
            writeJson(
              join(runnerDir, CONTROLLER_STATE),
              {
                schemaVersion: 1,
                repository,
                state: "stopped",
                lastOutcome: failure.message,
              } satisfies RunnerControllerState,
              adapters,
            ),
        ],
      ] as const) {
        try {
          await operation();
        } catch (persistenceError) {
          adapters.report(
            `[repository runner] Could not persist ${purpose}: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
          );
        }
      }
    }
    throw failure;
  }
};

export const getRepositoryRunnerStatus = async (
  options: { readonly repoDir: string },
  adapters: RunnerControlAdapters = defaultAdapters,
): Promise<RepositoryRunnerStatus> => {
  const runnerDir = join(options.repoDir, CONFIG_DIR, RUNNER_DIR);
  const metadata = await readJson<RunnerInstallMetadata>(
    join(runnerDir, RUNNER_INSTALL_METADATA),
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
    join(runnerDir, RUNNER_CONTROLLER_LOCK),
    adapters,
  );
  const state = await readJson<RunnerControllerState>(
    join(runnerDir, CONTROLLER_STATE),
    adapters,
  );
  const running = await lockOwnsProcess(lock, adapters);
  let github: RepositoryRunnerStatus["github"] = "unreachable";
  try {
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
        // Runner connectivity is an administrative check. Do not let the
        // issue-agent token from .shipyard/.env shadow the host gh login.
        env: adapters.environment(),
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
    ...(state?.lastWake ? { lastWake: state.lastWake } : {}),
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
    RUNNER_CONTROLLER_LOCK,
  );
  const lock = await readJson<RunnerControllerLock>(lockPath, adapters);
  if (!lock || !Number.isInteger(lock.pid)) {
    throw new RunnerControlError("The repository runner is not running.");
  }
  if (!adapters.isProcessRunning(lock.pid)) {
    throw new RunnerControlError(
      `The recorded repository runner process ${lock.pid} is no longer running.`,
    );
  }
  try {
    adapters.signalProcess(lock.pid, "SIGTERM");
  } catch (error) {
    throw controlFailure("Stopping the repository runner", error);
  }
  return { pid: lock.pid };
};
