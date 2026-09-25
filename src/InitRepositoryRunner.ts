import { CLI_NAME } from "./runtimeNames.js";
import { REPOSITORY_RUNNER_WORKFLOW_PATH } from "./RepositoryRunnerWake.js";

export const repositoryRunnerNextSteps = (): readonly string[] => [
  `Ensure ${REPOSITORY_RUNNER_WORKFLOW_PATH} is committed and pushed to the repository's default branch`,
  `Keep the foreground controller open with \`npx ${CLI_NAME} runner start\``,
  `Inspect it from another terminal with \`npx ${CLI_NAME} runner status\``,
  `Stop it with \`npx ${CLI_NAME} runner stop\``,
  `Unregister and delete its protected files with \`npx ${CLI_NAME} runner remove\``,
];
