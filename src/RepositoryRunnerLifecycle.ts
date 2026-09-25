import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ACTIVATION_LABEL, CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";
import {
  assertProtectedDirectoryIdentities,
  repositoryRunnerEnvironment,
  type ProtectedDirectoryIdentity,
} from "./runnerSecurity.js";

const execFileAsync = promisify(execFile);

export const RUNNER_INSTALL_METADATA = ".shipyard-install.json";
export const RUNNER_CONTROLLER_LOCK = ".shipyard-controller.lock";
export const RUNNER_WORK_DIR = "_work";
export const REPOSITORY_RUNNER_OWNER_LABEL =
  "com.snappedly.shipyard.repository-runner-owner";
export const REPOSITORY_RUNNER_OWNER_ENV = "SHIPYARD_RUNNER_OWNER";
const REGISTRATION_FILES = [
  ".credentials",
  ".credentials_rsaparams",
  ".runner",
] as const;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface RunnerInstallMetadata {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly name: string;
  readonly label: string;
  readonly version: string;
}

export interface RunnerControllerLock {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly repository: string;
  readonly processStartedAt: string;
}

export class RunnerLifecycleError extends Error {
  readonly name = "RunnerLifecycleError";
}

/** Internal seams for validating an existing runner installation. */
export interface RunnerInstallValidationAdapters {
  readonly environment: () => NodeJS.ProcessEnv;
  readonly exists: (path: string) => Promise<boolean>;
  readonly readText: (path: string) => Promise<string>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly inspectDirectory?: (
    path: string,
  ) => Promise<ProtectedDirectoryIdentity>;
  readonly run: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
}

/** Internal seams for runner registration, filesystem cleanup, and process control. */
export interface RunnerLifecycleAdapters extends RunnerInstallValidationAdapters {
  readonly remove: (path: string) => Promise<void>;
  readonly isProcessRunning: (pid: number) => boolean;
  readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  readonly pause: (milliseconds: number) => Promise<void>;
  readonly processIdentity: (pid: number) => Promise<string | undefined>;
}

const defaultAdapters: RunnerLifecycleAdapters = {
  environment: () => process.env,
  exists: async (path) => {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText: (path) => readFile(path, "utf8"),
  makeDirectory: async (path) => {
    await mkdir(path, { recursive: true, mode: 0o700 });
  },
  inspectDirectory: async (path) => {
    const [stat, resolved] = await Promise.all([lstat(path), realpath(path)]);
    return {
      realPath: resolved,
      directory: stat.isDirectory(),
      symbolicLink: stat.isSymbolicLink(),
    };
  },
  remove: (path) => rm(path, { recursive: true, force: true }),
  run: async (command, args, options) => {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
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
  isProcessRunning: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  signalProcess: (pid, signal) => process.kill(pid, signal),
  pause: (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export const lockOwnsProcess = async (
  lock: RunnerControllerLock | undefined,
  adapters: Pick<
    RunnerLifecycleAdapters,
    "isProcessRunning" | "processIdentity"
  >,
): Promise<boolean> =>
  lock !== undefined &&
  Number.isInteger(lock.pid) &&
  typeof lock.processStartedAt === "string" &&
  lock.processStartedAt.length > 0 &&
  adapters.isProcessRunning(lock.pid) &&
  (await adapters.processIdentity(lock.pid)) === lock.processStartedAt;

const lifecycleFailure = (
  purpose: string,
  error: unknown,
): RunnerLifecycleError =>
  error instanceof RunnerLifecycleError
    ? error
    : new RunnerLifecycleError(
        `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`,
      );

const runCommand = async (
  adapters: Pick<RunnerInstallValidationAdapters, "run">,
  purpose: string,
  command: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> => {
  try {
    return await adapters.run(command, args, options);
  } catch (error) {
    throw lifecycleFailure(purpose, error);
  }
};

const readJson = async <T>(
  path: string,
  adapters: Pick<RunnerInstallValidationAdapters, "exists" | "readText">,
): Promise<T | undefined> => {
  if (!(await adapters.exists(path))) return undefined;
  try {
    return JSON.parse(await adapters.readText(path)) as T;
  } catch (error) {
    throw lifecycleFailure(`Reading repository runner state at ${path}`, error);
  }
};

const requireInstallMetadata = async (
  runnerDir: string,
  adapters: Pick<RunnerInstallValidationAdapters, "exists" | "readText">,
): Promise<RunnerInstallMetadata> => {
  const metadata = await readJson<RunnerInstallMetadata>(
    join(runnerDir, RUNNER_INSTALL_METADATA),
    adapters,
  );
  if (
    metadata?.schemaVersion !== 1 ||
    typeof metadata.repository !== "string" ||
    typeof metadata.repositoryUrl !== "string" ||
    typeof metadata.name !== "string" ||
    metadata.label !== ACTIVATION_LABEL ||
    typeof metadata.version !== "string"
  ) {
    throw new RunnerLifecycleError(
      `The existing directory at ${runnerDir} is not a valid Shipyard repository runner installation. Refusing to replace it.`,
    );
  }
  return metadata;
};

interface RemoteRunner {
  readonly name: string;
  readonly status: string;
  readonly labels: ReadonlySet<string>;
}

const parseRemoteRunners = (stdout: string): readonly RemoteRunner[] =>
  stdout
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = "", status = "", labels = ""] = line.split("\t");
      return {
        name,
        status,
        labels: new Set(labels.split(",").filter(Boolean)),
      };
    });

const listRemoteRunners = async (
  repository: string,
  repoDir: string,
  environment: NodeJS.ProcessEnv,
  adapters: RunnerInstallValidationAdapters,
): Promise<readonly RemoteRunner[]> => {
  const response = await runCommand(
    adapters,
    "Checking registered GitHub repository runners",
    "gh",
    [
      "api",
      "--paginate",
      `repos/${repository}/actions/runners`,
      "--jq",
      '.runners[] | [.name, .status, ([.labels[].name] | join(","))] | @tsv',
    ],
    { cwd: repoDir, env: environment },
  );
  return parseRemoteRunners(response.stdout);
};

export const validateExistingRepositoryRunner = async (
  options: {
    readonly repoDir: string;
    readonly runnerDir: string;
    readonly repository: string;
    readonly runnerName: string;
  },
  adapters: RunnerInstallValidationAdapters = defaultAdapters,
): Promise<RunnerInstallMetadata> => {
  await assertProtectedDirectoryIdentities(
    options.runnerDir,
    adapters.inspectDirectory,
  ).catch((error) => {
    throw lifecycleFailure("Validating protected runner directories", error);
  });
  const metadata = await requireInstallMetadata(options.runnerDir, adapters);
  if (metadata.repository !== options.repository) {
    throw new RunnerLifecycleError(
      `The existing repository runner belongs to ${metadata.repository}, not ${options.repository}. Refusing to replace it.`,
    );
  }
  if (metadata.name !== options.runnerName) {
    throw new RunnerLifecycleError(
      `The existing installation belongs to runner ${metadata.name}, not ${options.runnerName}. A Mac rename does not rename a registered runner; remove and reinstall it explicitly.`,
    );
  }
  for (const required of [".credentials", "run.sh"] as const) {
    if (!(await adapters.exists(join(options.runnerDir, required)))) {
      throw new RunnerLifecycleError(
        `The existing repository runner is missing ${required}. Refusing to replace its registration; remove it explicitly first.`,
      );
    }
  }

  const remoteRunners = await listRemoteRunners(
    options.repository,
    options.repoDir,
    adapters.environment(),
    adapters,
  );
  const labelled = remoteRunners.filter(({ labels }) =>
    labels.has(ACTIVATION_LABEL),
  );
  if (labelled.length > 1) {
    throw new RunnerLifecycleError(
      `Multiple repository runners carry the ${ACTIVATION_LABEL} label (${labelled.map(({ name }) => name).join(", ")}). Remove duplicates before continuing.`,
    );
  }
  const matching = remoteRunners.find(({ name }) => name === metadata.name);
  if (!matching) {
    throw new RunnerLifecycleError(
      `Runner ${metadata.name} is installed locally but is no longer registered with GitHub. Run \`shipyard runner start\` to repair it, or remove it explicitly.`,
    );
  }
  if (!matching.labels.has(ACTIVATION_LABEL)) {
    throw new RunnerLifecycleError(
      `Registered runner ${metadata.name} does not carry the ${ACTIVATION_LABEL} label. Refusing to replace a customized registration.`,
    );
  }

  return metadata;
};

const removeRegistrationFiles = async (
  runnerDir: string,
  adapters: RunnerLifecycleAdapters,
): Promise<void> => {
  for (const name of REGISTRATION_FILES) {
    const path = join(runnerDir, name);
    if (await adapters.exists(path)) await adapters.remove(path);
  }
};

const readOneTimeToken = (stdout: string, purpose: string): string => {
  try {
    const parsed = JSON.parse(stdout) as { token?: unknown };
    if (typeof parsed.token !== "string" || parsed.token.length === 0) {
      throw new Error("response did not contain a token");
    }
    return parsed.token;
  } catch (error) {
    throw lifecycleFailure(purpose, error);
  }
};

const requestRegistrationToken = async (
  repository: string,
  repoDir: string,
  environment: NodeJS.ProcessEnv,
  adapters: RunnerLifecycleAdapters,
): Promise<string> => {
  await runCommand(
    adapters,
    "Checking current administrative GitHub authorization",
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { cwd: repoDir, env: environment },
  );
  const response = await runCommand(
    adapters,
    "Requesting a one-time repository runner registration token",
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${repository}/actions/runners/registration-token`,
    ],
    { cwd: repoDir, env: environment },
  );
  return readOneTimeToken(response.stdout, "Reading the registration token");
};

export const recoverRepositoryRunner = async (
  options: {
    readonly repoDir: string;
    readonly runnerDir: string;
    readonly metadata: RunnerInstallMetadata;
    readonly runnerEnvironment: NodeJS.ProcessEnv;
    readonly dockerEnvironment?: NodeJS.ProcessEnv;
  },
  adapters: RunnerLifecycleAdapters = defaultAdapters,
): Promise<{ readonly reRegistered: boolean }> => {
  const lockPath = join(options.runnerDir, RUNNER_CONTROLLER_LOCK);
  const lock = await readJson<RunnerControllerLock>(lockPath, adapters);
  if (await lockOwnsProcess(lock, adapters)) {
    throw new RunnerLifecycleError(
      `The repository runner is already running with process ${lock!.pid}.`,
    );
  }
  if (lock) await adapters.remove(lockPath);

  const workDir = join(options.runnerDir, RUNNER_WORK_DIR);
  if (await adapters.exists(workDir)) await adapters.remove(workDir);
  await assertProtectedDirectoryIdentities(
    options.runnerDir,
    adapters.inspectDirectory,
  ).catch((error) => {
    throw lifecycleFailure("Validating protected runner directories", error);
  });

  await removeOwnedRepositoryRunnerContainers(
    {
      repoDir: options.repoDir,
      repository: options.metadata.repository,
      environment: options.dockerEnvironment ?? options.runnerEnvironment,
    },
    adapters,
  );

  const adminEnvironment = adapters.environment();
  const remoteRunners = await listRemoteRunners(
    options.metadata.repository,
    options.repoDir,
    adminEnvironment,
    adapters,
  );
  const labelled = remoteRunners.filter(({ labels }) =>
    labels.has(ACTIVATION_LABEL),
  );
  if (labelled.length > 1) {
    throw new RunnerLifecycleError(
      `Multiple repository runners carry the ${ACTIVATION_LABEL} label (${labelled.map(({ name }) => name).join(", ")}). Remove duplicates before continuing.`,
    );
  }
  const matching = remoteRunners.find(
    ({ name }) => name === options.metadata.name,
  );
  if (matching) {
    if (!matching.labels.has(ACTIVATION_LABEL)) {
      throw new RunnerLifecycleError(
        `Registered runner ${matching.name} does not carry the ${ACTIVATION_LABEL} label. Refusing to replace a customized registration.`,
      );
    }
    if (!(await adapters.exists(join(options.runnerDir, ".credentials")))) {
      throw new RunnerLifecycleError(
        `Registered runner ${matching.name} is missing local credentials. Remove and reinstall it explicitly.`,
      );
    }
    return { reRegistered: false };
  }

  const collision = labelled[0];
  if (collision) {
    throw new RunnerLifecycleError(
      `Repository runner ${collision.name} already carries the ${ACTIVATION_LABEL} label. Refusing to create a conflicting registration.`,
    );
  }

  const registrationToken = await requestRegistrationToken(
    options.metadata.repository,
    options.repoDir,
    adminEnvironment,
    adapters,
  );
  await removeRegistrationFiles(options.runnerDir, adapters);
  try {
    await adapters.run(
      "./config.sh",
      [
        "--url",
        options.metadata.repositoryUrl,
        "--token",
        registrationToken,
        "--name",
        options.metadata.name,
        "--labels",
        ACTIVATION_LABEL,
        "--work",
        RUNNER_WORK_DIR,
        "--unattended",
      ],
      { cwd: options.runnerDir, env: options.runnerEnvironment },
    );
  } catch {
    await removeRegistrationFiles(options.runnerDir, adapters);
    throw new RunnerLifecycleError(
      `Re-registering ${options.metadata.name} failed. Partial local registration files were removed; check GitHub Settings > Actions > Runners for an orphan registration, then retry \`shipyard runner start\`. The one-time token was not stored.`,
    );
  }
  return { reRegistered: true };
};

export const removeOwnedRepositoryRunnerContainers = async (
  options: {
    readonly repoDir: string;
    readonly repository: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  adapters: Pick<RunnerLifecycleAdapters, "run"> = defaultAdapters,
): Promise<void> => {
  const ownedContainers = await runCommand(
    adapters,
    "Finding stale repository-runner containers",
    "docker",
    [
      "ps",
      "-aq",
      "--filter",
      `label=${REPOSITORY_RUNNER_OWNER_LABEL}=${options.repository}`,
    ],
    { cwd: options.repoDir, env: options.environment },
  );
  const containerIds = ownedContainers.stdout.split(/\s+/).filter(Boolean);
  if (containerIds.length === 0) return;
  await runCommand(
    adapters,
    "Removing stale repository-runner containers",
    "docker",
    ["rm", "-f", ...containerIds],
    { cwd: options.repoDir, env: options.environment },
  );
};

const waitForProcessToStop = async (
  pid: number,
  adapters: RunnerLifecycleAdapters,
): Promise<void> => {
  adapters.signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!adapters.isProcessRunning(pid)) return;
    await adapters.pause(100);
  }
  throw new RunnerLifecycleError(
    `Repository runner process ${pid} did not stop within 5 seconds. Local runner files were preserved.`,
  );
};

const unregisterRepositoryRunner = async (
  metadata: RunnerInstallMetadata,
  repoDir: string,
  runnerDir: string,
  environment: NodeJS.ProcessEnv,
  adapters: RunnerLifecycleAdapters,
): Promise<void> => {
  await runCommand(
    adapters,
    "Checking current administrative GitHub authorization",
    "gh",
    ["auth", "status", "--hostname", "github.com"],
    { cwd: repoDir, env: environment },
  );
  const response = await runCommand(
    adapters,
    "Requesting a one-time repository runner removal token",
    "gh",
    [
      "api",
      "--method",
      "POST",
      `repos/${metadata.repository}/actions/runners/remove-token`,
    ],
    { cwd: repoDir, env: environment },
  );
  const token = readOneTimeToken(response.stdout, "Reading the removal token");
  try {
    await adapters.run(
      "./config.sh",
      ["remove", "--token", token, "--unattended"],
      { cwd: runnerDir, env: repositoryRunnerEnvironment(environment) },
    );
  } catch {
    throw new RunnerLifecycleError(
      `Unregistering ${metadata.name} from GitHub failed. Local runner files were preserved; retry after restoring repository administration access.`,
    );
  }
};

export interface RepositoryRunnerRemoveResult {
  readonly removed: true;
  readonly forced: boolean;
  readonly manualCleanup?: string;
}

export const removeRepositoryRunner = async (
  options: { readonly repoDir: string; readonly force?: boolean },
  adapters: RunnerLifecycleAdapters = defaultAdapters,
): Promise<RepositoryRunnerRemoveResult> => {
  const configDir = join(options.repoDir, CONFIG_DIR);
  const runnerDir = join(configDir, RUNNER_DIR);
  if (!(await adapters.exists(runnerDir))) {
    throw new RunnerLifecycleError(
      `No repository runner is installed at ${runnerDir}.`,
    );
  }
  try {
    await assertProtectedDirectoryIdentities(
      runnerDir,
      adapters.inspectDirectory,
    );
  } catch (error) {
    if (!options.force) {
      throw lifecycleFailure("Validating protected runner directory", error);
    }
    await adapters.remove(runnerDir);
    return {
      removed: true,
      forced: true,
      manualCleanup:
        "Check GitHub Settings > Actions > Runners and manually remove any orphan repository runner registration.",
    };
  }
  let metadata: RunnerInstallMetadata;
  try {
    metadata = await requireInstallMetadata(runnerDir, adapters);
  } catch (error) {
    if (!options.force) throw error;
    await adapters.remove(runnerDir);
    return {
      removed: true,
      forced: true,
      manualCleanup:
        "Check GitHub Settings > Actions > Runners and manually remove any orphan repository runner registration.",
    };
  }
  const lock = await readJson<RunnerControllerLock>(
    join(runnerDir, RUNNER_CONTROLLER_LOCK),
    adapters,
  );
  if (await lockOwnsProcess(lock, adapters)) {
    await waitForProcessToStop(lock!.pid, adapters);
  }

  try {
    await unregisterRepositoryRunner(
      metadata,
      options.repoDir,
      runnerDir,
      adapters.environment(),
      adapters,
    );
  } catch (error) {
    if (!options.force) {
      const failure = lifecycleFailure("Removing the repository runner", error);
      throw new RunnerLifecycleError(
        `${failure.message} Local runner files were preserved.`,
      );
    }
    await adapters.remove(runnerDir);
    return {
      removed: true,
      forced: true,
      manualCleanup: `Remove runner ${metadata.name} from ${metadata.repository} in GitHub Settings > Actions > Runners.`,
    };
  }

  await adapters.remove(runnerDir);
  return { removed: true, forced: false };
};
