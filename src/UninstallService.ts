import { lstat, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR, RUNNER_DIR } from "./runtimeNames.js";
import {
  REPOSITORY_RUNNER_WORKFLOW,
  REPOSITORY_RUNNER_WORKFLOW_PATH,
} from "./RepositoryRunnerWake.js";

export const SHIPYARD_PACKAGE_NAME = "@snappedly-tools/shipyard";

export interface ShipyardRepositoryUninstallResult {
  readonly workflowRemoved: boolean;
  readonly workflowPreserved: boolean;
  readonly configDirectoryRemoved: boolean;
}

const isMissingPath = (error: unknown): boolean =>
  error !== null &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

const lstatIfPresent = async (path: string) => {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingPath(error)) return undefined;
    throw error;
  }
};

/** Check the config directory before runner cleanup can read from it. */
export const inspectShipyardConfigDirectory = async (
  repoDir: string,
): Promise<boolean> => {
  const configDir = join(repoDir, CONFIG_DIR);
  const info = await lstatIfPresent(configDir);
  if (!info) return false;

  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(
      `Refusing to uninstall because ${configDir} is not a real directory.`,
    );
  }
  return true;
};

const removeWakeWorkflow = async (
  repoDir: string,
): Promise<{ readonly removed: boolean; readonly preserved: boolean }> => {
  const githubDir = join(repoDir, ".github");
  const workflowsDir = join(githubDir, "workflows");
  const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);

  const githubInfo = await lstatIfPresent(githubDir);
  if (!githubInfo) return { removed: false, preserved: false };
  if (!githubInfo.isDirectory() || githubInfo.isSymbolicLink()) {
    return { removed: false, preserved: githubInfo.isSymbolicLink() };
  }

  const workflowsInfo = await lstatIfPresent(workflowsDir);
  if (!workflowsInfo) return { removed: false, preserved: false };
  if (!workflowsInfo.isDirectory() || workflowsInfo.isSymbolicLink()) {
    return {
      removed: false,
      preserved: workflowsInfo.isSymbolicLink(),
    };
  }

  const workflowInfo = await lstatIfPresent(workflowPath);
  if (!workflowInfo) return { removed: false, preserved: false };
  if (!workflowInfo.isFile() || workflowInfo.isSymbolicLink()) {
    return { removed: false, preserved: true };
  }

  const workflow = await readFile(workflowPath, "utf8");
  if (workflow !== REPOSITORY_RUNNER_WORKFLOW) {
    return { removed: false, preserved: true };
  }

  await rm(workflowPath);
  return { removed: true, preserved: false };
};

/**
 * Remove the target repository's entire Shipyard config directory and generated
 * wake workflow. The repository runner must be unregistered before this runs.
 */
export const removeShipyardRepositoryFiles = async (options: {
  readonly repoDir: string;
}): Promise<ShipyardRepositoryUninstallResult> => {
  const configDirExists = await inspectShipyardConfigDirectory(options.repoDir);
  if (configDirExists) {
    const configDir = join(options.repoDir, CONFIG_DIR);
    const runnerDir = join(configDir, RUNNER_DIR);
    if (await lstatIfPresent(runnerDir)) {
      throw new Error(
        `Remove the repository runner at ${runnerDir} before removing Shipyard configuration.`,
      );
    }
  }

  const workflow = await removeWakeWorkflow(options.repoDir);
  if (configDirExists) {
    await rm(join(options.repoDir, CONFIG_DIR), { recursive: true });
  }

  return {
    workflowRemoved: workflow.removed,
    workflowPreserved: workflow.preserved,
    configDirectoryRemoved: configDirExists,
  };
};
