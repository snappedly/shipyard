import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  lstat,
  realpath,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ACTIVATION_LABEL, CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";
import {
  assertProtectedDirectoryIdentities,
  repositoryRunnerEnvironment,
  type ProtectedDirectoryIdentity,
} from "./runnerSecurity.js";
import {
  assertRepositoryRunnerWorkflowCanBeInstalled,
  installRepositoryRunnerWakeFiles,
} from "./RepositoryRunnerWake.js";
import {
  RUNNER_INSTALL_METADATA,
  RunnerLifecycleError,
  validateExistingRepositoryRunner,
} from "./RepositoryRunnerLifecycle.js";

const execFileAsync = promisify(execFile);

const RUNNER_ARCHIVE = "runner.tgz";
const RELEASES_API =
  "https://api.github.com/repos/actions/runner/releases/latest";

export class RunnerInstallError extends Error {
  readonly name: string = "RunnerInstallError";
}

export interface ExistingRepositoryRunnerRegistration {
  readonly id: number | undefined;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean;
}

export class RunnerInstallConflictError extends RunnerInstallError {
  override readonly name = "RunnerInstallConflictError";

  readonly confirmationMessage: string;

  constructor(
    readonly repository: string,
    readonly runners: readonly ExistingRepositoryRunnerRegistration[],
  ) {
    const names = runners.map(({ name }) => name).join(", ");
    super(
      `A repository runner labeled \`${ACTIVATION_LABEL}\` is already registered for ${repository}: ${names}. Remove it before installing another.`,
    );
    const details = runners
      .map(
        ({ id, name, status, busy }) =>
          `${name}${id === undefined ? "" : ` (#${id})`} (${status}${busy ? ", busy" : ""})`,
      )
      .join(", ");
    this.confirmationMessage = `GitHub has ${runners.length} repository runner${runners.length === 1 ? "" : "s"} labeled \`${ACTIVATION_LABEL}\` for ${repository}: ${details}. Delete ${runners.length === 1 ? "this registration" : "these registrations"} and install a replacement?`;
  }
}

export interface RunnerInstallOptions {
  readonly repoDir: string;
  readonly registrationToken?: string;
  readonly onProgress?: (update: RunnerInstallProgress) => void;
}

export interface RunnerInstallProgress {
  readonly current: number;
  readonly total: number;
  readonly message: string;
}

export interface RunnerInstallResult {
  readonly name: string;
  readonly repository: string;
  readonly version: string;
  readonly runnerDir: string;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/** Internal seams used to test installation without GitHub or a live runner. */
export interface RunnerInstallAdapters {
  readonly platform: () => NodeJS.Platform | string;
  readonly arch: () => string;
  readonly hostname: () => string;
  readonly environment: () => NodeJS.ProcessEnv;
  readonly exists: (path: string) => Promise<boolean>;
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly writeBytes: (path: string, content: Uint8Array) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly remove: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly commandExists: (command: string) => Promise<boolean>;
  readonly inspectDirectory?: (
    path: string,
  ) => Promise<ProtectedDirectoryIdentity>;
  readonly fetchJson: (url: string) => Promise<unknown>;
  readonly fetchBytes: (url: string) => Promise<Uint8Array>;
  readonly run: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
}

interface RunnerReleaseAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly digest: string;
}

interface RunnerRelease {
  readonly tag_name: string;
  readonly assets: readonly RunnerReleaseAsset[];
}

const defaultAdapters: RunnerInstallAdapters = {
  platform: () => process.platform,
  arch: () => process.arch,
  hostname,
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
  writeText: (path, content) => writeFile(path, content, { mode: 0o600 }),
  writeBytes: (path, content) => writeFile(path, content, { mode: 0o600 }),
  makeDirectory: (path) => mkdir(path, { recursive: false, mode: 0o700 }),
  remove: (path) => rm(path, { recursive: true, force: true }),
  chmod,
  commandExists: async (command) => {
    try {
      await execFileAsync("which", [command]);
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
  fetchJson: async (url) => {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "shipyard-runner-installer",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    return response.json();
  },
  fetchBytes: async (url) => {
    const response = await fetch(url, {
      headers: { "User-Agent": "shipyard-runner-installer" },
    });
    if (!response.ok) {
      throw new Error(`GitHub returned HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  },
  run: async (command, args, options) => {
    const result = await execFileAsync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr };
  },
};

export const parseGitHubRepository = (
  remote: string,
): { owner: string; repository: string } => {
  const trimmed = remote.trim();
  const sshMatch = trimmed.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/,
  );
  const httpsMatch = trimmed.match(
    /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  );
  const match = sshMatch ?? httpsMatch;
  if (!match) {
    throw new RunnerInstallError(
      "The origin remote must be a GitHub.com repository (github.com/owner/repository). GitHub Enterprise and other hosts are not supported yet.",
    );
  }
  return { owner: match[1]!, repository: match[2]! };
};

const normalizeNamePart = (value: string): string => {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
  return normalized || "unknown";
};

const requireCommand = async (
  adapters: RunnerInstallAdapters,
  command: string,
  purpose: string,
): Promise<void> => {
  if (!(await adapters.commandExists(command))) {
    throw new RunnerInstallError(
      `Missing required command \`${command}\` (${purpose}). Install it and retry.`,
    );
  }
};

const asRelease = (value: unknown): RunnerRelease => {
  if (typeof value !== "object" || value === null) {
    throw new RunnerInstallError(
      "GitHub returned invalid runner release metadata.",
    );
  }
  const release = value as Partial<RunnerRelease>;
  if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new RunnerInstallError(
      "GitHub returned invalid runner release metadata.",
    );
  }
  return release as RunnerRelease;
};

const selectArm64Asset = (release: RunnerRelease): RunnerReleaseAsset => {
  const asset = release.assets.find((candidate) =>
    /^actions-runner-osx-arm64-[\d.]+\.tar\.gz$/.test(candidate.name),
  );
  if (
    !asset ||
    !asset.browser_download_url.startsWith(
      "https://github.com/actions/runner/releases/download/",
    ) ||
    !/^sha256:[a-f0-9]{64}$/i.test(asset.digest)
  ) {
    throw new RunnerInstallError(
      "The latest official GitHub Actions runner release has no verifiable macOS ARM64 archive.",
    );
  }
  return asset;
};

const appendRunnerIgnores = async (
  gitignorePath: string,
  adapters: RunnerInstallAdapters,
): Promise<void> => {
  const current = (await adapters.exists(gitignorePath))
    ? await adapters.readText(gitignorePath)
    : "";
  const lines = new Set(current.split(/\r?\n/));
  const additions = [`${RUNNER_DIR}/`].filter((line) => !lines.has(line));
  if (additions.length === 0) return;
  const prefix =
    current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  await adapters.writeText(gitignorePath, `${prefix}${additions.join("\n")}\n`);
};

const commandFailure = (purpose: string, error: unknown): RunnerInstallError =>
  new RunnerInstallError(
    `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`,
  );

const reportProgress = (
  options: RunnerInstallOptions,
  current: number,
  total: number,
  message: string,
): void => options.onProgress?.({ current, total, message });

const parseExistingRunnerRegistrations = (
  stdout: string,
): readonly ExistingRepositoryRunnerRegistration[] => {
  const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
  return lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Accept the earlier name-only response format from injected adapters.
      // Such a result can block an install, but cannot be deleted without an ID.
      return { id: undefined, name: line, status: "unknown", busy: false };
    }
    if (typeof value !== "object" || value === null) {
      throw new RunnerInstallError(
        "GitHub returned invalid repository runner information.",
      );
    }
    const registration = value as Record<string, unknown>;
    if (
      typeof registration.id !== "number" ||
      !Number.isInteger(registration.id) ||
      registration.id <= 0 ||
      typeof registration.name !== "string" ||
      registration.name.length === 0 ||
      typeof registration.status !== "string" ||
      typeof registration.busy !== "boolean"
    ) {
      throw new RunnerInstallError(
        "GitHub returned invalid repository runner information.",
      );
    }
    return {
      id: registration.id,
      name: registration.name,
      status: registration.status,
      busy: registration.busy,
    };
  });
};

export const removeExistingRepositoryRunnerRegistrations = async (
  options: {
    readonly repoDir: string;
    readonly conflict: RunnerInstallConflictError;
  },
  adapters: RunnerInstallAdapters = defaultAdapters,
): Promise<void> => {
  if (options.conflict.runners.some(({ id }) => id === undefined)) {
    throw new RunnerInstallError(
      "GitHub did not provide runner IDs, so Shipyard cannot safely remove the existing registrations. Remove them in GitHub Settings > Actions > Runners, then retry.",
    );
  }

  const environment = adapters.environment();
  const removed: string[] = [];
  for (const runner of options.conflict.runners) {
    try {
      await adapters.run(
        "gh",
        [
          "api",
          "--method",
          "DELETE",
          `repos/${options.conflict.repository}/actions/runners/${runner.id}`,
        ],
        { cwd: options.repoDir, env: environment },
      );
      removed.push(runner.name);
    } catch (error) {
      const previous =
        removed.length === 0
          ? ""
          : ` Earlier registrations were already removed: ${removed.join(", ")}.`;
      throw new RunnerInstallError(
        `${
          commandFailure(
            `Removing GitHub runner ${runner.name} (#${runner.id}) from ${options.conflict.repository}`,
            error,
          ).message
        }${previous}`,
      );
    }
  }
};

export const installRepositoryRunnerWithReplacement = async (
  options: {
    readonly repoDir: string;
    readonly interactive: boolean;
    readonly install: () => Promise<RunnerInstallResult>;
    readonly confirmReplacement: (
      conflict: RunnerInstallConflictError,
    ) => Promise<boolean>;
  },
  adapters: RunnerInstallAdapters = defaultAdapters,
): Promise<RunnerInstallResult> => {
  try {
    return await options.install();
  } catch (error) {
    if (
      !(error instanceof RunnerInstallConflictError) ||
      !options.interactive
    ) {
      throw error;
    }
    if (!(await options.confirmReplacement(error))) {
      throw new RunnerInstallError(
        `${error.message} Existing runner registrations were left unchanged; installation cancelled.`,
      );
    }
    await removeExistingRepositoryRunnerRegistrations(
      {
        repoDir: options.repoDir,
        conflict: error,
      },
      adapters,
    );
    return options.install();
  }
};

export const installRepositoryRunner = async (
  options: RunnerInstallOptions,
  adapters: RunnerInstallAdapters = defaultAdapters,
): Promise<RunnerInstallResult> => {
  if (adapters.platform() !== "darwin" || adapters.arch() !== "arm64") {
    throw new RunnerInstallError(
      "Repository runners currently require Apple Silicon macOS (darwin/arm64).",
    );
  }

  const configDir = join(options.repoDir, CONFIG_DIR);
  const runnerDir = join(configDir, RUNNER_DIR);
  if (!(await adapters.exists(configDir))) {
    throw new RunnerInstallError(
      `No ${CONFIG_DIR}/ found. Run \`shipyard init\` in this repository first.`,
    );
  }
  const runnerExists = await adapters.exists(runnerDir);
  const progressTotal = runnerExists ? 3 : 8;
  try {
    await assertRepositoryRunnerWorkflowCanBeInstalled(
      options.repoDir,
      adapters,
    );
  } catch (error) {
    throw new RunnerInstallError(
      error instanceof Error ? error.message : String(error),
    );
  }

  await requireCommand(adapters, "git", "reading the repository remote");
  if (!runnerExists) {
    await requireCommand(adapters, "tar", "extracting the runner archive");
  }
  await requireCommand(adapters, "gh", "checking repository runner uniqueness");

  const hostEnv = adapters.environment();
  const gitRemote = await adapters
    .run("git", ["remote", "get-url", "origin"], {
      cwd: options.repoDir,
      env: hostEnv,
    })
    .catch((error) => {
      throw commandFailure("Reading the origin remote", error);
    });
  const identity = parseGitHubRepository(gitRemote.stdout);
  const repository = `${identity.owner}/${identity.repository}`;
  const repoUrl = `https://github.com/${repository}`;
  const runnerName = `shipyard-${normalizeNamePart(identity.repository)}-${normalizeNamePart(adapters.hostname())}`;

  await adapters
    .run("gh", ["auth", "status", "--hostname", "github.com"], {
      cwd: options.repoDir,
      env: hostEnv,
    })
    .catch((error) => {
      throw commandFailure(
        "GitHub CLI authentication (repository administration is required)",
        error,
      );
    });
  reportProgress(
    options,
    1,
    progressTotal,
    "Validated repository and GitHub access",
  );

  if (runnerExists) {
    let metadata;
    try {
      metadata = await validateExistingRepositoryRunner(
        {
          repoDir: options.repoDir,
          runnerDir,
          repository,
          runnerName,
        },
        adapters,
      );
    } catch (error) {
      throw new RunnerInstallError(
        error instanceof RunnerLifecycleError
          ? error.message
          : `Validating the existing repository runner failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await appendRunnerIgnores(join(configDir, ".gitignore"), adapters);
    await adapters.chmod(runnerDir, 0o700);
    await assertProtectedDirectoryIdentities(
      runnerDir,
      adapters.inspectDirectory,
    ).catch((error) => {
      throw commandFailure("Validating protected runner directories", error);
    });
    reportProgress(options, 2, progressTotal, "Validated existing runner");
    try {
      await installRepositoryRunnerWakeFiles(
        { repoDir: options.repoDir, runnerDir },
        adapters,
      );
    } catch (error) {
      throw new RunnerInstallError(
        `The existing runner is valid, but its wake-up files could not be refreshed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    reportProgress(options, 3, progressTotal, "Refreshed wake-up workflow");
    return {
      name: metadata.name,
      repository: metadata.repository,
      version: metadata.version,
      runnerDir,
    };
  }

  const existing = await adapters
    .run(
      "gh",
      [
        "api",
        "--paginate",
        `repos/${repository}/actions/runners`,
        "--jq",
        `.runners[] | select(any(.labels[]; .name == \"${ACTIVATION_LABEL}\")) | {id, name, status, busy}`,
      ],
      { cwd: options.repoDir, env: hostEnv },
    )
    .catch((error) => {
      throw commandFailure(
        "Checking existing repository runners (repository administration is required)",
        error,
      );
    });
  const existingRegistrations = parseExistingRunnerRegistrations(
    existing.stdout,
  );
  if (existingRegistrations.length > 0) {
    throw new RunnerInstallConflictError(repository, existingRegistrations);
  }
  reportProgress(
    options,
    2,
    progressTotal,
    "Checked for conflicting repository runners",
  );

  let registrationToken = options.registrationToken;
  if (!registrationToken) {
    const tokenResult = await adapters
      .run(
        "gh",
        [
          "api",
          "--method",
          "POST",
          `repos/${repository}/actions/runners/registration-token`,
        ],
        { cwd: options.repoDir, env: hostEnv },
      )
      .catch((error) => {
        throw commandFailure(
          "Requesting a one-time runner registration token (repository administration is required)",
          error,
        );
      });
    try {
      const parsed = JSON.parse(tokenResult.stdout) as { token?: unknown };
      if (typeof parsed.token !== "string" || parsed.token.length === 0) {
        throw new Error("response did not contain a token");
      }
      registrationToken = parsed.token;
    } catch (error) {
      throw commandFailure("Reading the one-time registration token", error);
    }
  }
  reportProgress(
    options,
    3,
    progressTotal,
    "Prepared runner registration token",
  );

  let release: RunnerRelease;
  try {
    release = asRelease(await adapters.fetchJson(RELEASES_API));
  } catch (error) {
    if (error instanceof RunnerInstallError) throw error;
    throw commandFailure("Fetching official runner release metadata", error);
  }
  const asset = selectArm64Asset(release);
  const version = release.tag_name.replace(/^v/, "");
  let archive: Uint8Array;
  try {
    archive = await adapters.fetchBytes(asset.browser_download_url);
  } catch (error) {
    throw commandFailure("Downloading the official runner archive", error);
  }
  const actualDigest = createHash("sha256").update(archive).digest("hex");
  const expectedDigest = asset.digest.slice("sha256:".length).toLowerCase();
  if (actualDigest !== expectedDigest) {
    throw new RunnerInstallError(
      `Runner archive digest mismatch: expected ${expectedDigest}, received ${actualDigest}. Nothing was installed.`,
    );
  }
  reportProgress(
    options,
    4,
    progressTotal,
    "Downloaded and verified official runner archive",
  );

  await appendRunnerIgnores(join(configDir, ".gitignore"), adapters);
  await adapters.makeDirectory(runnerDir).catch((error) => {
    throw commandFailure("Creating the protected runner directory", error);
  });
  await assertProtectedDirectoryIdentities(
    runnerDir,
    adapters.inspectDirectory,
  ).catch((error) => {
    throw commandFailure("Validating protected runner directories", error);
  });
  await adapters.chmod(runnerDir, 0o700);
  reportProgress(
    options,
    5,
    progressTotal,
    "Prepared protected runner directories",
  );

  const archivePath = join(runnerDir, RUNNER_ARCHIVE);
  await adapters.writeBytes(archivePath, archive);
  try {
    await adapters.run("tar", ["-xzf", archivePath, "--directory", runnerDir], {
      cwd: options.repoDir,
      env: repositoryRunnerEnvironment(hostEnv),
    });
  } catch (error) {
    await adapters.remove(runnerDir);
    throw commandFailure("Extracting the verified runner archive", error);
  } finally {
    await adapters.remove(archivePath);
  }
  reportProgress(options, 6, progressTotal, "Extracted runner archive");

  try {
    await adapters.run(
      "./config.sh",
      [
        "--url",
        repoUrl,
        "--token",
        registrationToken!,
        "--name",
        runnerName,
        "--labels",
        ACTIVATION_LABEL,
        "--work",
        "_work",
        "--unattended",
      ],
      { cwd: runnerDir, env: repositoryRunnerEnvironment(hostEnv) },
    );
  } catch {
    const cleanup = await Promise.allSettled([adapters.remove(runnerDir)]);
    const cleanupSucceeded = cleanup.every(
      (result) => result.status === "fulfilled",
    );
    throw new RunnerInstallError(
      cleanupSucceeded
        ? `Registering ${runnerName} failed. Partial local runner files were removed so installation can be retried. Check GitHub Settings > Actions > Runners for an orphan registration; the one-time token was not stored.`
        : `Registering ${runnerName} failed and partial local runner files could not be fully removed. Remove only ${runnerDir}, check GitHub Settings > Actions > Runners for an orphan registration, then retry. The one-time token was not stored.`,
    );
  }
  reportProgress(options, 7, progressTotal, "Registered runner with GitHub");

  await adapters.writeText(
    join(runnerDir, RUNNER_INSTALL_METADATA),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository,
        repositoryUrl: repoUrl,
        name: runnerName,
        label: ACTIVATION_LABEL,
        version,
      },
      null,
      2,
    )}\n`,
  );

  try {
    await installRepositoryRunnerWakeFiles(
      { repoDir: options.repoDir, runnerDir },
      adapters,
    );
  } catch (error) {
    throw new RunnerInstallError(
      `The runner was registered, but its wake-up files could not be installed. Runner files were retained at ${runnerDir}; fix the error and retry: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  reportProgress(options, 8, progressTotal, "Installed wake-up workflow");

  return { name: runnerName, repository, version, runnerDir };
};
