import { execFile } from "node:child_process";

const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Git configuration that can execute programs while Shipyard processes files
 * authored inside a sandbox. Command-line configuration has the highest
 * priority, so these values override repository and user configuration.
 */
const SAFE_CONFIG: ReadonlyArray<readonly [string, string]> = [
  ["core.hooksPath", "/dev/null"],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.alternateRefsCommand", "false"],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["gpg.program", "false"],
  ["gpg.ssh.program", "false"],
  ["gpg.ssh.defaultKeyCommand", "false"],
  ["merge.autoEdit", "no"],
  ["interactive.diffFilter", ""],
  ["diff.external", ""],
  ["maintenance.auto", "false"],
  ["gc.auto", "0"],
  ["submodule.recurse", "false"],
  ["checkout.recurseSubmodules", "false"],
];

const COMMAND_CONFIG_PATTERN =
  "^(filter\\..*\\.(clean|smudge|process|required)|merge\\..*\\.driver|diff\\..*\\.(command|textconv)|difftool\\..*\\.cmd|mergetool\\..*\\.cmd)$";

export interface HostGitOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBuffer?: number;
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const runGit = (
  args: readonly string[],
  cwd: string,
  options: HostGitOptions = {},
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        env: {
          ...process.env,
          ...options.env,
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
        },
        maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ stdout, stderr, exitCode: 0 });
          return;
        }

        if (typeof error.code === "number") {
          resolve({ stdout, stderr, exitCode: error.code });
          return;
        }

        reject(error);
      },
    );
  });

const configArgs = (entries: ReadonlyArray<readonly [string, string]>) =>
  entries.flatMap(([key, value]) => ["-c", `${key}=${value}`]);

/**
 * Discover named drivers because Git has no wildcard command-line override for
 * filter, diff, or merge driver sections. Discovery itself only reads config;
 * it does not inspect the index or working tree and cannot invoke those
 * drivers.
 */
const commandDriverOverrides = async (
  cwd: string,
  options: HostGitOptions,
): Promise<string[]> => {
  const result = await runGit(
    ["config", "--null", "--name-only", "--get-regexp", COMMAND_CONFIG_PATTERN],
    cwd,
    options,
  );
  if (result.exitCode === 1) return [];
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || "Failed to inspect Git configuration",
    );
  }

  const overrides = new Map<string, string>();
  for (const key of result.stdout.split("\0").filter(Boolean)) {
    const filterMatch = /^(filter\..*)\.(clean|smudge|process|required)$/i.exec(
      key,
    );
    if (filterMatch) {
      const section = filterMatch[1]!;
      overrides.set(`${section}.clean`, "cat");
      overrides.set(`${section}.smudge`, "cat");
      overrides.set(`${section}.process`, "");
      overrides.set(`${section}.required`, "false");
      continue;
    }

    // If a sandbox-authored .gitattributes file selects one of these named
    // drivers, fail that optional driver instead of launching a host program.
    overrides.set(key, "false");
  }

  return configArgs([...overrides.entries()]);
};

/**
 * Run an internal host-side Git operation without a shell or executable Git
 * callbacks. User identity and other inert configuration remain available.
 */
export const execHostGit = async (
  args: readonly string[],
  cwd: string,
  options: HostGitOptions = {},
): Promise<string> => {
  const driverArgs = await commandDriverOverrides(cwd, options);
  const safeArgs = [...configArgs(SAFE_CONFIG), ...driverArgs, ...args];
  const result = await runGit(safeArgs, cwd, options);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() ||
        `git ${args.join(" ")} failed with exit ${result.exitCode}`,
    );
  }
  return result.stdout;
};
