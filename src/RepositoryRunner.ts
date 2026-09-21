import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  ACTIVATION_LABEL,
  CONFIG_DIR,
  RUNNER_DIR,
  RUNNER_SANDBOX_MASK_DIR,
} from "./runtimeNames.js";

const execFileAsync = promisify(execFile);

const RUNNER_ARCHIVE = "runner.tgz";
const INSTALL_METADATA = ".shipyard-install.json";
const RELEASES_API =
  "https://api.github.com/repos/actions/runner/releases/latest";
const SAFE_RUNNER_ENV_KEYS = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USER",
]);

export class RunnerInstallError extends Error {
  readonly name = "RunnerInstallError";
}

export interface RunnerInstallOptions {
  readonly repoDir: string;
  readonly registrationToken?: string;
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

const parseGitHubRepository = (
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

export const repositoryRunnerEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => SAFE_RUNNER_ENV_KEYS.has(key) && value !== undefined,
    ),
  );

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
  const additions = [`${RUNNER_DIR}/`, `${RUNNER_SANDBOX_MASK_DIR}/`].filter(
    (line) => !lines.has(line),
  );
  if (additions.length === 0) return;
  const prefix =
    current.length === 0 || current.endsWith("\n") ? current : `${current}\n`;
  await adapters.writeText(gitignorePath, `${prefix}${additions.join("\n")}\n`);
};

const commandFailure = (purpose: string, error: unknown): RunnerInstallError =>
  new RunnerInstallError(
    `${purpose} failed: ${error instanceof Error ? error.message : String(error)}`,
  );

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
  const maskDir = join(configDir, RUNNER_SANDBOX_MASK_DIR);
  if (!(await adapters.exists(configDir))) {
    throw new RunnerInstallError(
      `No ${CONFIG_DIR}/ found. Run \`shipyard init\` in this repository first.`,
    );
  }
  if (await adapters.exists(runnerDir)) {
    throw new RunnerInstallError(
      `A repository runner is already installed at ${runnerDir}. Remove it before installing another.`,
    );
  }

  await requireCommand(adapters, "git", "reading the repository remote");
  await requireCommand(adapters, "tar", "extracting the runner archive");
  if (!options.registrationToken) {
    await requireCommand(adapters, "gh", "requesting repository runner access");
  }

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

  if (!options.registrationToken) {
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
    const existing = await adapters
      .run(
        "gh",
        [
          "api",
          "--paginate",
          `repos/${repository}/actions/runners`,
          "--jq",
          `.runners[] | select(any(.labels[]; .name == \"${ACTIVATION_LABEL}\")) | .name`,
        ],
        { cwd: options.repoDir, env: hostEnv },
      )
      .catch((error) => {
        throw commandFailure(
          "Checking existing repository runners (repository administration is required)",
          error,
        );
      });
    if (existing.stdout.trim().length > 0) {
      throw new RunnerInstallError(
        `A repository runner labeled \`${ACTIVATION_LABEL}\` is already registered for ${repository}. Remove it before installing another.`,
      );
    }
  }

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

  await appendRunnerIgnores(join(configDir, ".gitignore"), adapters);
  await adapters.makeDirectory(runnerDir).catch((error) => {
    throw commandFailure("Creating the protected runner directory", error);
  });
  await adapters.chmod(runnerDir, 0o700);
  if (!(await adapters.exists(maskDir))) {
    await adapters.makeDirectory(maskDir);
  }
  await adapters.chmod(maskDir, 0o700);

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
    throw new RunnerInstallError(
      `Registering ${runnerName} failed. Runner files were retained at ${runnerDir} for recovery; the one-time token was not stored.`,
    );
  }

  await adapters.writeText(
    join(runnerDir, INSTALL_METADATA),
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

  return { name: runnerName, repository, version, runnerDir };
};
