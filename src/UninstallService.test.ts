import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removeShipyardRepositoryFiles } from "./UninstallService.js";
import {
  REPOSITORY_RUNNER_WORKFLOW,
  REPOSITORY_RUNNER_WORKFLOW_PATH,
} from "./RepositoryRunnerWake.js";

const withTempRepository = async (
  operation: (repoDir: string) => Promise<void>,
): Promise<void> => {
  const repoDir = await mkdtemp(join(tmpdir(), "shipyard-uninstall-"));
  try {
    await operation(repoDir);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
};

describe("removeShipyardRepositoryFiles", () => {
  it.each(["empty", "code-only"] as const)(
    "removes a %s Shipyard configuration directory",
    async (configuration) => {
      await withTempRepository(async (repoDir) => {
        const configDir = join(repoDir, ".shipyard");
        await mkdir(configDir);
        if (configuration === "code-only") {
          await writeFile(join(configDir, "main.ts"), "export {};\n");
        }

        const result = await removeShipyardRepositoryFiles({ repoDir });

        expect(result).toEqual({
          workflowRemoved: false,
          workflowPreserved: false,
          configDirectoryRemoved: true,
        });
        await expect(access(configDir)).rejects.toThrow();
      });
    },
  );

  it("removes the entire Shipyard directory and generated wake workflow", async () => {
    await withTempRepository(async (repoDir) => {
      const configDir = join(repoDir, ".shipyard");
      const logsDir = join(configDir, "logs");
      const worktreeDir = join(configDir, "worktrees", "active-task");
      const patchesDir = join(configDir, "patches");
      const locksDir = join(configDir, "locks");
      const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
      await Promise.all([
        mkdir(logsDir, { recursive: true }),
        mkdir(worktreeDir, { recursive: true }),
        mkdir(patchesDir, { recursive: true }),
        mkdir(locksDir, { recursive: true }),
        mkdir(join(repoDir, ".github", "workflows"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(configDir, "main.ts"), "export {};\n"),
        writeFile(join(configDir, "custom-helper.ts"), "export {};\n"),
        writeFile(join(configDir, ".env"), "GH_TOKEN=keep-me\n"),
        writeFile(join(configDir, ".gitignore"), ".env\nlogs/\n"),
        writeFile(join(logsDir, "run.log"), "evidence"),
        writeFile(join(worktreeDir, "uncommitted.txt"), "work"),
        writeFile(join(patchesDir, "pending.patch"), "patch"),
        writeFile(join(locksDir, "active.lock"), "lock"),
        writeFile(workflowPath, REPOSITORY_RUNNER_WORKFLOW),
      ]);

      const result = await removeShipyardRepositoryFiles({ repoDir });

      expect(result).toEqual({
        workflowRemoved: true,
        workflowPreserved: false,
        configDirectoryRemoved: true,
      });
      await expect(access(configDir)).rejects.toThrow();
      await expect(access(workflowPath)).rejects.toThrow();
    });
  });

  it("preserves a customized workflow instead of deleting an unknown file", async () => {
    await withTempRepository(async (repoDir) => {
      const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
      await mkdir(join(repoDir, ".github", "workflows"), { recursive: true });
      await writeFile(workflowPath, `${REPOSITORY_RUNNER_WORKFLOW}\n# custom`);

      const result = await removeShipyardRepositoryFiles({ repoDir });

      expect(result.workflowRemoved).toBe(false);
      expect(result.workflowPreserved).toBe(true);
      await expect(readFile(workflowPath, "utf8")).resolves.toContain(
        "# custom",
      );
    });
  });

  it("leaves the workflow in place until an installed runner is removed", async () => {
    await withTempRepository(async (repoDir) => {
      const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
      await mkdir(join(repoDir, ".shipyard", "runner"), { recursive: true });
      await mkdir(join(repoDir, ".github", "workflows"), { recursive: true });
      await writeFile(workflowPath, REPOSITORY_RUNNER_WORKFLOW);

      await expect(removeShipyardRepositoryFiles({ repoDir })).rejects.toThrow(
        "Remove the repository runner",
      );
      await expect(readFile(workflowPath, "utf8")).resolves.toBe(
        REPOSITORY_RUNNER_WORKFLOW,
      );
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses a linked config directory before changing repository files",
    async () => {
      await withTempRepository(async (repoDir) => {
        const externalConfig = join(repoDir, "external-config");
        const configPath = join(repoDir, ".shipyard");
        const workflowPath = join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH);
        await mkdir(externalConfig);
        await mkdir(join(repoDir, ".github", "workflows"), {
          recursive: true,
        });
        await symlink(externalConfig, configPath, "dir");
        await writeFile(workflowPath, REPOSITORY_RUNNER_WORKFLOW);

        await expect(
          removeShipyardRepositoryFiles({ repoDir }),
        ).rejects.toThrow("not a real directory");
        await expect(readFile(workflowPath, "utf8")).resolves.toBe(
          REPOSITORY_RUNNER_WORKFLOW,
        );
      });
    },
  );
});
