import { join } from "node:path";

export const REPOSITORY_RUNNER_WORKFLOW_PATH =
  ".github/workflows/shipyard-wake.yml";
export const REPOSITORY_RUNNER_WAKE_EXECUTABLE = "shipyard-wake";

export const REPOSITORY_RUNNER_WORKFLOW = `name: Shipyard wake-up

on:
  issues:
    types: [labeled]
  workflow_dispatch:

permissions: {}

jobs:
  filter:
    name: Check wake eligibility
    runs-on: ubuntu-latest
    outputs:
      wake: \${{ steps.filter.outputs.wake }}
    steps:
      - name: Match the wake-up trigger
        id: filter
        shell: bash
        env:
          EVENT_NAME: \${{ github.event_name }}
          LABEL_NAME: \${{ github.event.label.name }}
        run: |
          if [[ "$EVENT_NAME" == "workflow_dispatch" ]] || [[ "$EVENT_NAME" == "issues" && "$LABEL_NAME" == "shipyard" ]]; then
            echo "wake=true" >> "$GITHUB_OUTPUT"
          else
            echo "wake=false" >> "$GITHUB_OUTPUT"
          fi

  wake:
    name: Deliver wake-up
    needs: filter
    if: needs.filter.outputs.wake == 'true'
    runs-on: [self-hosted, macOS, shipyard]
    steps:
      - name: Signal the foreground repository runner
        shell: bash
        run: '"$RUNNER_TEMP/../../shipyard-wake"'
`;

export const REPOSITORY_RUNNER_WAKE_SCRIPT = `#!/bin/bash
set -euo pipefail

runner_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
lock_path="$runner_dir/.shipyard-controller.lock"

if [[ ! -r "$lock_path" ]]; then
  echo "::error::The Shipyard repository runner controller is unavailable. Start it with npx shipyard runner start."
  exit 1
fi

controller_pid="$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' "$lock_path" | head -n 1)"
controller_started_at="$(sed -n 's/.*"processStartedAt"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$lock_path" | head -n 1)"
if [[ -z "$controller_pid" ]] || [[ -z "$controller_started_at" ]]; then
  echo "::error::The Shipyard repository runner controller is unavailable. Start it with npx shipyard runner start."
  exit 1
fi
current_started_at="$(ps -p "$controller_pid" -o lstart= 2>/dev/null | awk '{$1=$1; print}' || true)"
if [[ "$current_started_at" != "$controller_started_at" ]] || ! kill -0 "$controller_pid" 2>/dev/null; then
  echo "::error::The Shipyard repository runner controller is unavailable. Start it with npx shipyard runner start."
  exit 1
fi

if ! kill -USR1 "$controller_pid"; then
  echo "::error::The Shipyard repository runner controller could not receive the wake-up."
  exit 1
fi

echo "Wake-up delivered to the Shipyard repository runner controller."
`;

export class RepositoryRunnerWakeError extends Error {
  readonly name = "RepositoryRunnerWakeError";
}

export interface RepositoryRunnerWakeFileAdapters {
  readonly exists: (path: string) => Promise<boolean>;
  readonly readText: (path: string) => Promise<string>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly makeDirectory: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface RepositoryRunnerWakeGitHubAdapter {
  readonly run: (
    command: string,
    args: readonly string[],
    options: CommandOptions,
  ) => Promise<CommandResult>;
}

export interface RepositoryRunnerWakeSubscription {
  readonly next: () => Promise<void>;
  readonly close: () => void;
}

const workflowCollisionMessage = (): string =>
  `Refusing to overwrite the differing workflow at ${REPOSITORY_RUNNER_WORKFLOW_PATH}. Replace it with the required Shipyard wake-only workflow, then retry:\n\n${REPOSITORY_RUNNER_WORKFLOW}`;

const publishedWorkflowFailureMessage = (
  repository: string,
  defaultBranch: string,
  error: unknown,
): string => {
  const details = error instanceof Error ? error.message : String(error);
  if (
    /HTTP 403|Resource not accessible by personal access token/i.test(details)
  ) {
    return `The Shipyard wake workflow could not be read for ${repository} on the default branch (${defaultBranch}). GitHub denied Contents: Read access for the host gh login. Authenticate gh with repository administration access, then start the runner again. GitHub reported: ${details}`;
  }
  return `The Shipyard wake workflow is not active for ${repository}. Commit and push ${REPOSITORY_RUNNER_WORKFLOW_PATH} to the default branch (${defaultBranch}), then start the runner again. GitHub reported: ${details}`;
};

export const assertRepositoryRunnerWorkflowCanBeInstalled = async (
  repoDir: string,
  adapters: RepositoryRunnerWakeFileAdapters,
): Promise<void> => {
  const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
  if (!(await adapters.exists(workflowPath))) return;
  if ((await adapters.readText(workflowPath)) !== REPOSITORY_RUNNER_WORKFLOW) {
    throw new RepositoryRunnerWakeError(workflowCollisionMessage());
  }
};

const ensureDirectory = async (
  path: string,
  adapters: RepositoryRunnerWakeFileAdapters,
): Promise<void> => {
  if (!(await adapters.exists(path))) await adapters.makeDirectory(path);
};

export const installRepositoryRunnerWakeFiles = async (
  options: { readonly repoDir: string; readonly runnerDir: string },
  adapters: RepositoryRunnerWakeFileAdapters,
): Promise<void> => {
  await assertRepositoryRunnerWorkflowCanBeInstalled(options.repoDir, adapters);
  const githubDir = join(options.repoDir, ".github");
  const workflowsDir = join(githubDir, "workflows");
  await ensureDirectory(githubDir, adapters);
  await ensureDirectory(workflowsDir, adapters);
  await adapters.writeText(
    join(options.repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH),
    REPOSITORY_RUNNER_WORKFLOW,
  );

  const wakeExecutable = join(
    options.runnerDir,
    REPOSITORY_RUNNER_WAKE_EXECUTABLE,
  );
  await adapters.writeText(wakeExecutable, REPOSITORY_RUNNER_WAKE_SCRIPT);
  await adapters.chmod(wakeExecutable, 0o700);
};

export const requirePublishedRepositoryRunnerWorkflow = async (
  options: {
    readonly repoDir: string;
    readonly repository: string;
    readonly environment: NodeJS.ProcessEnv;
  },
  adapter: RepositoryRunnerWakeGitHubAdapter,
): Promise<void> => {
  let defaultBranch: string;
  try {
    const result = await adapter.run(
      "gh",
      ["api", `repos/${options.repository}`, "--jq", ".default_branch"],
      { cwd: options.repoDir, env: options.environment },
    );
    defaultBranch = result.stdout.trim();
    if (defaultBranch.length === 0) throw new Error("empty default branch");
  } catch (error) {
    throw new RepositoryRunnerWakeError(
      `Could not determine the GitHub default branch for ${options.repository}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let publishedWorkflow: string;
  try {
    const result = await adapter.run(
      "gh",
      [
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.raw+json",
        `repos/${options.repository}/contents/${REPOSITORY_RUNNER_WORKFLOW_PATH}?ref=${encodeURIComponent(defaultBranch)}`,
      ],
      { cwd: options.repoDir, env: options.environment },
    );
    publishedWorkflow = result.stdout;
  } catch (error) {
    throw new RepositoryRunnerWakeError(
      publishedWorkflowFailureMessage(options.repository, defaultBranch, error),
    );
  }

  if (publishedWorkflow !== REPOSITORY_RUNNER_WORKFLOW) {
    throw new RepositoryRunnerWakeError(
      `The Shipyard wake workflow on the default branch (${defaultBranch}) does not match the required workflow. Update and push ${REPOSITORY_RUNNER_WORKFLOW_PATH}, then start the runner again.\n\n${REPOSITORY_RUNNER_WORKFLOW}`,
    );
  }
};

/** Coalesces signal deliveries until the foreground controller consumes them. */
export const createRepositoryRunnerWakeSubscription = (
  subscribe: (listener: () => void) => () => void = (listener) => {
    process.on("SIGUSR1", listener);
    return () => process.removeListener("SIGUSR1", listener);
  },
): RepositoryRunnerWakeSubscription => {
  let pending = false;
  let closed = false;
  let resolveNext: (() => void) | undefined;
  const unsubscribe = subscribe(() => {
    if (closed || pending) return;
    pending = true;
    resolveNext?.();
    resolveNext = undefined;
  });

  return {
    next: async () => {
      if (closed) return;
      if (!pending) {
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
      pending = false;
    },
    close: () => {
      if (closed) return;
      closed = true;
      unsubscribe();
      resolveNext?.();
      resolveNext = undefined;
    },
  };
};
