import { posix } from "node:path";
import { CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";

const PROTECTED_RUNNER_PATH = `${CONFIG_DIR}/${RUNNER_DIR}`;

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
