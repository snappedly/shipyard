import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  assertRepositoryRunnerWorkflowCanBeInstalled,
  installRepositoryRunnerWakeFiles,
  REPOSITORY_RUNNER_WAKE_SCRIPT,
  REPOSITORY_RUNNER_WORKFLOW,
  REPOSITORY_RUNNER_WORKFLOW_PATH,
  requirePublishedRepositoryRunnerWorkflow,
  type RepositoryRunnerWakeFileAdapters,
  type RepositoryRunnerWakeGitHubAdapter,
} from "./RepositoryRunnerWake.js";

const repoDir = "/repo";
const runnerDir = join(repoDir, ".shipyard-v1", "runner");

describe("repository runner wake workflow", () => {
  it("renders a valid wake-only workflow with an exact lowercase label gate", () => {
    const workflow = parse(REPOSITORY_RUNNER_WORKFLOW) as {
      readonly on: Record<string, unknown>;
      readonly permissions: Record<string, unknown>;
      readonly jobs: Record<string, unknown>;
    };

    expect(workflow.on).toHaveProperty("issues");
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    expect(workflow.permissions).toEqual({});
    expect(workflow.jobs).toHaveProperty("filter");
    expect(workflow.jobs).toHaveProperty("wake");
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain(
      "on:\n  issues:\n    types: [labeled]\n  workflow_dispatch:",
    );
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain("permissions: {}");
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain(
      '[[ "$EVENT_NAME" == "issues" && "$LABEL_NAME" == "shipyard-v1" ]]',
    );
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain(
      '[[ "$EVENT_NAME" == "workflow_dispatch" ]]',
    );
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain(
      "runs-on: [self-hosted, macOS, shipyard-v1]",
    );
    expect(REPOSITORY_RUNNER_WORKFLOW).toContain(
      '"$RUNNER_TEMP/../../shipyard-v1-wake"',
    );
    expect(REPOSITORY_RUNNER_WORKFLOW).not.toMatch(/actions\/checkout/i);
    expect(REPOSITORY_RUNNER_WORKFLOW).not.toMatch(/secrets\.|GH_TOKEN/);
    expect(REPOSITORY_RUNNER_WORKFLOW).not.toContain("shipyard-v1 run");
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      'if [[ ! -r "$lock_path" ]]',
    );
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      '! kill -0 "$controller_pid"',
    );
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain('"processStartedAt"');
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      'ps -p "$controller_pid" -o lstart=',
    );
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      "awk '{$1=$1; print}' || true",
    );
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      '[[ "$current_started_at" != "$controller_started_at" ]]',
    );
    expect(REPOSITORY_RUNNER_WAKE_SCRIPT).toContain(
      "repository runner controller is unavailable",
    );
  });

  it("installs the workflow and protected wake executable", async () => {
    const files = new Map<string, string>();
    const directories = new Set([
      repoDir,
      join(repoDir, ".shipyard-v1"),
      runnerDir,
    ]);
    const modes = new Map<string, number>();
    const adapters: RepositoryRunnerWakeFileAdapters = {
      exists: async (path) => directories.has(path) || files.has(path),
      readText: async (path) => files.get(path) ?? "",
      writeText: async (path, content) => {
        files.set(path, content);
      },
      makeDirectory: async (path) => {
        directories.add(path);
      },
      chmod: async (path, mode) => {
        modes.set(path, mode);
      },
    };

    await assertRepositoryRunnerWorkflowCanBeInstalled(repoDir, adapters);
    await installRepositoryRunnerWakeFiles({ repoDir, runnerDir }, adapters);

    expect(files.get(join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH))).toBe(
      REPOSITORY_RUNNER_WORKFLOW,
    );
    expect(files.get(join(runnerDir, "shipyard-v1-wake"))).toBe(
      REPOSITORY_RUNNER_WAKE_SCRIPT,
    );
    expect(modes.get(join(runnerDir, "shipyard-v1-wake"))).toBe(0o700);
  });

  it("refuses to overwrite a differing workflow and shows the required content", async () => {
    const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
    const adapters: RepositoryRunnerWakeFileAdapters = {
      exists: async (path) => path === workflowPath,
      readText: async () => "name: Existing workflow\n",
      writeText: async () => undefined,
      makeDirectory: async () => undefined,
      chmod: async () => undefined,
    };

    const error = await assertRepositoryRunnerWorkflowCanBeInstalled(
      repoDir,
      adapters,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(REPOSITORY_RUNNER_WORKFLOW_PATH);
    expect((error as Error).message).toContain(REPOSITORY_RUNNER_WORKFLOW);
  });

  it("requires the exact generated workflow on the GitHub default branch", async () => {
    const calls: string[][] = [];
    const adapter: RepositoryRunnerWakeGitHubAdapter = {
      run: async (_command, args) => {
        calls.push([...args]);
        return calls.length === 1
          ? { stdout: "main\n", stderr: "" }
          : { stdout: REPOSITORY_RUNNER_WORKFLOW, stderr: "" };
      },
    };

    await requirePublishedRepositoryRunnerWorkflow(
      {
        repoDir,
        repository: "snappedly/shipyard-v1",
        environment: { GH_TOKEN: "repo-token" },
      },
      adapter,
    );

    expect(calls).toEqual([
      ["api", "repos/snappedly/shipyard-v1", "--jq", ".default_branch"],
      [
        "api",
        "--method",
        "GET",
        "-H",
        "Accept: application/vnd.github.raw+json",
        "repos/snappedly/shipyard-v1/contents/.github/workflows/shipyard-v1-wake.yml?ref=main",
      ],
    ]);
  });

  it("reports how to publish a missing remote workflow", async () => {
    const adapter: RepositoryRunnerWakeGitHubAdapter = {
      run: async (_command, args) => {
        if (args.includes("--jq")) return { stdout: "main\n", stderr: "" };
        throw new Error("HTTP 404");
      },
    };

    await expect(
      requirePublishedRepositoryRunnerWorkflow(
        {
          repoDir,
          repository: "snappedly/shipyard-v1",
          environment: {},
        },
        adapter,
      ),
    ).rejects.toThrow(
      "Commit and push .github/workflows/shipyard-v1-wake.yml to the default branch (main)",
    );
  });

  it("explains when GitHub denies access to the published workflow", async () => {
    const adapter: RepositoryRunnerWakeGitHubAdapter = {
      run: async (_command, args) => {
        if (args.includes("--jq")) return { stdout: "staging\n", stderr: "" };
        throw new Error(
          "Command failed: gh api\ngh: Resource not accessible by personal access token (HTTP 403)",
        );
      },
    };

    await expect(
      requirePublishedRepositoryRunnerWorkflow(
        {
          repoDir,
          repository: "snappedly/shipyard-v1",
          environment: {},
        },
        adapter,
      ),
    ).rejects.toThrow(
      "GitHub denied Contents: Read access for the host gh login",
    );
  });
});
