import { lstatSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import {
  CONFIG_DIR,
  RUNNER_DIR,
  RUNNER_SANDBOX_MASK_DIR,
} from "./runtimeNames.js";

const PROTECTED_RUNNER_PATH = `${CONFIG_DIR}/${RUNNER_DIR}`;
const pathKey = (value: string): string =>
  value.normalize("NFC").toLocaleLowerCase("en-US");
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

/** Keep repository credentials and agent secrets out of official runner processes. */
export const repositoryRunnerEnvironment = (
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(source).filter(
      ([key, value]) => SAFE_RUNNER_ENV_KEYS.has(key) && value !== undefined,
    ),
  );

/** Reject a copy root that is the repository runner, contains it, or sits inside it. */
export const assertExcludesRepositoryRunner = (relativePath: string): void => {
  const normalized = pathKey(
    posix
      .normalize(relativePath.replace(/\\/g, "/"))
      .replace(/^\.\//, "")
      .replace(/\/$/, ""),
  );
  const protectedPath = pathKey(PROTECTED_RUNNER_PATH);
  if (
    normalized === "." ||
    normalized === protectedPath ||
    normalized.startsWith(`${protectedPath}/`) ||
    protectedPath.startsWith(`${normalized}/`)
  ) {
    throw new Error(
      `Copy path ${relativePath} would expose the protected repository runner to an agent sandbox.`,
    );
  }
};

/** Validate protected directories immediately before using them as host paths. */
export const assertSafeRepositoryRunnerDirectories = (
  repoDir: string,
): void => {
  const runnerDir = join(repoDir, CONFIG_DIR, RUNNER_DIR);
  const maskDir = join(repoDir, CONFIG_DIR, RUNNER_SANDBOX_MASK_DIR);
  for (const [name, path] of [
    ["repository runner", runnerDir],
    ["repository runner sandbox mask", maskDir],
  ] as const) {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `The protected ${name} path must be a real directory: ${path}`,
      );
    }
  }
  if (pathKey(realpathSync(runnerDir)) === pathKey(realpathSync(maskDir))) {
    throw new Error(
      "The protected repository runner and sandbox mask paths must be distinct directories.",
    );
  }
};

export interface ProtectedDirectoryIdentity {
  readonly realPath: string;
  readonly directory: boolean;
  readonly symbolicLink: boolean;
}

/** Adapter-friendly equivalent used by install and lifecycle boundaries. */
export const assertProtectedDirectoryIdentities = async (
  runnerDir: string,
  maskDir: string,
  inspect?: (path: string) => Promise<ProtectedDirectoryIdentity>,
): Promise<void> => {
  if (!inspect) return;
  const runner = await inspect(runnerDir);
  const mask = await inspect(maskDir);
  if (!runner.directory || runner.symbolicLink) {
    throw new Error(
      `The protected repository runner path must be a real directory: ${runnerDir}`,
    );
  }
  if (!mask.directory || mask.symbolicLink) {
    throw new Error(
      `The protected repository runner sandbox mask path must be a real directory: ${maskDir}`,
    );
  }
  if (pathKey(runner.realPath) === pathKey(mask.realPath)) {
    throw new Error(
      "The protected repository runner and sandbox mask paths must be distinct directories.",
    );
  }
};
