import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { execHostGit } from "./hostGit.js";

const exec = promisify(execFile);

const setupRepo = async () => {
  const repoDir = await mkdtemp(join(tmpdir(), "host-git-"));
  await exec("git", ["init", "-b", "main"], { cwd: repoDir });
  await exec("git", ["config", "user.email", "test@test.com"], {
    cwd: repoDir,
  });
  await exec("git", ["config", "user.name", "Test"], { cwd: repoDir });
  await writeFile(join(repoDir, "file.txt"), "base\n");
  await exec("git", ["add", "file.txt"], { cwd: repoDir });
  await exec("git", ["commit", "-m", "base"], { cwd: repoDir });
  return repoDir;
};

describe("execHostGit", () => {
  it("disables repository-configured hooks", async () => {
    const repoDir = await setupRepo();
    const sentinel = join(repoDir, "hook-executed");
    await mkdir(join(repoDir, ".githooks"));
    await writeFile(
      join(repoDir, ".githooks", "post-checkout"),
      `#!/bin/sh\ntouch '${sentinel}'\n`,
    );
    await chmod(join(repoDir, ".githooks", "post-checkout"), 0o755);
    await exec("git", ["config", "core.hooksPath", ".githooks"], {
      cwd: repoDir,
    });

    await execHostGit(["checkout", "-b", "topic"], repoDir);

    await expect(stat(sentinel)).rejects.toThrow();
  });

  it("disables repository-configured fsmonitor commands", async () => {
    const repoDir = await setupRepo();
    const sentinel = join(repoDir, "fsmonitor-executed");
    await exec("git", ["config", "core.fsmonitor", `touch '${sentinel}'`], {
      cwd: repoDir,
    });

    await execHostGit(["status", "--porcelain"], repoDir);

    await expect(stat(sentinel)).rejects.toThrow();
  });

  it("replaces named clean, smudge, and process filters", async () => {
    const repoDir = await setupRepo();
    const sentinel = join(repoDir, "filter-executed");
    await writeFile(join(repoDir, ".gitattributes"), "*.txt filter=attack\n");
    await exec("git", ["add", ".gitattributes"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "attributes"], { cwd: repoDir });
    await exec("git", ["checkout", "-b", "topic"], { cwd: repoDir });
    await writeFile(join(repoDir, "file.txt"), "topic\n");
    await exec("git", ["add", "file.txt"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "topic"], { cwd: repoDir });
    await exec("git", ["checkout", "main"], { cwd: repoDir });
    for (const key of ["clean", "smudge", "process"]) {
      await exec(
        "git",
        ["config", `filter.attack.${key}`, `touch '${sentinel}'; cat`],
        { cwd: repoDir },
      );
    }
    await exec("git", ["config", "filter.attack.required", "true"], {
      cwd: repoDir,
    });

    await execHostGit(["checkout", "topic"], repoDir);

    await expect(stat(sentinel)).rejects.toThrow();
  });

  it("does not run a configured merge driver", async () => {
    const repoDir = await setupRepo();
    const sentinel = join(repoDir, "merge-driver-executed");
    await writeFile(join(repoDir, ".gitattributes"), "file.txt merge=attack\n");
    await exec("git", ["add", ".gitattributes"], { cwd: repoDir });
    await exec("git", ["commit", "-m", "attributes"], { cwd: repoDir });
    await exec("git", ["checkout", "-b", "topic"], { cwd: repoDir });
    await writeFile(join(repoDir, "file.txt"), "topic\n");
    await exec("git", ["commit", "-am", "topic"], { cwd: repoDir });
    await exec("git", ["checkout", "main"], { cwd: repoDir });
    await writeFile(join(repoDir, "file.txt"), "main\n");
    await exec("git", ["commit", "-am", "main"], { cwd: repoDir });
    await exec(
      "git",
      ["config", "merge.attack.driver", `touch '${sentinel}'; cp %B %A`],
      { cwd: repoDir },
    );

    await expect(execHostGit(["merge", "topic"], repoDir)).rejects.toThrow();
    await expect(stat(sentinel)).rejects.toThrow();
  });
});
