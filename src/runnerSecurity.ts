import { posix } from "node:path";
import { CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";

const PROTECTED_RUNNER_PATH = `${CONFIG_DIR}/${RUNNER_DIR}`;
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
  const normalized = posix
    .normalize(relativePath.replace(/\\/g, "/"))
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    normalized === "." ||
    normalized === PROTECTED_RUNNER_PATH ||
    normalized.startsWith(`${PROTECTED_RUNNER_PATH}/`) ||
    PROTECTED_RUNNER_PATH.startsWith(`${normalized}/`)
  ) {
    throw new Error(
      `Copy path ${relativePath} would expose the protected repository runner to an agent sandbox.`,
    );
  }
};
