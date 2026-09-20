import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Container cp creates root-owned files; session files may have mode 0600. */
export const copyIntoContainer = async (
  engine: "docker",
  container: string,
  owner: string,
  hostPath: string,
  sandboxPath: string,
): Promise<void> => {
  try {
    await exec(engine, [
      "exec",
      container,
      "mkdir",
      "-p",
      "--",
      posix.dirname(sandboxPath),
    ]);
    await exec(engine, ["cp", hostPath, `${container}:${sandboxPath}`]);
    await exec(engine, [
      "exec",
      "--user",
      "0:0",
      container,
      "chown",
      "-hR",
      "--",
      owner,
      sandboxPath,
    ]);
  } catch (error) {
    throw new Error(
      `${engine} cp (in) failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
