import type { RunnerInstallResult } from "./RepositoryRunner.js";
import { CLI_NAME } from "./runtimeNames.js";
import { REPOSITORY_RUNNER_WORKFLOW_PATH } from "./RepositoryRunnerWake.js";

export type RepositoryRunnerInitResult =
  | { readonly status: "declined" }
  | { readonly status: "installed"; readonly result: RunnerInstallResult }
  | { readonly status: "failed"; readonly message: string };

export interface RepositoryRunnerInitOptions {
  readonly interactive: boolean;
  readonly requested?: boolean;
  readonly confirm?: (options: {
    readonly message: string;
    readonly initialValue: boolean;
  }) => Promise<boolean>;
  readonly install: () => Promise<RunnerInstallResult>;
}

/** Decide and perform the optional post-scaffold runner installation. */
export const initializeRepositoryRunner = async (
  options: RepositoryRunnerInitOptions,
): Promise<RepositoryRunnerInitResult> => {
  let shouldInstall = options.requested;
  if (shouldInstall === undefined) {
    shouldInstall = options.interactive
      ? await options.confirm!({
          message:
            "Install a foreground repository runner for labelled GitHub issues?",
          initialValue: true,
        })
      : false;
  }
  if (!shouldInstall) return { status: "declined" };

  try {
    return { status: "installed", result: await options.install() };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
};

export const repositoryRunnerNextSteps = (): readonly string[] => [
  `Ensure ${REPOSITORY_RUNNER_WORKFLOW_PATH} is committed and pushed to the repository's default branch`,
  `Keep the foreground controller open with \`npx ${CLI_NAME} runner start\``,
  `Inspect it from another terminal with \`npx ${CLI_NAME} runner status\``,
  `Stop it with \`npx ${CLI_NAME} runner stop\``,
  `Unregister and delete its protected files with \`npx ${CLI_NAME} runner remove\``,
];
