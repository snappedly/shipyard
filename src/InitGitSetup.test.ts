import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { commitAndPushInitSetup } from "./InitGitSetup.js";

describe("commitAndPushInitSetup", () => {
  it("pushes package manifests with setup without committing unrelated staged files", () => {
    const dir = mkdtempSync(join(tmpdir(), "shipyard-init-git-"));
    const repoDir = join(dir, "repo");
    const remoteDir = join(dir, "remote.git");
    mkdirSync(repoDir);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();

    try {
      execFileSync("git", ["init", "--bare", remoteDir], { stdio: "ignore" });
      git("init", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      git("remote", "add", "origin", remoteDir);
      writeFileSync(join(repoDir, "package.json"), '{"name":"app"}\n');
      writeFileSync(join(repoDir, "package-lock.json"), '{"name":"app"}\n');
      git("add", "package.json", "package-lock.json");
      git("commit", "-m", "Initial commit");
      git("push", "-u", "origin", "main");

      writeFileSync(
        join(repoDir, "package.json"),
        '{"name":"app","devDependencies":{"@snappedly-tools/shipyard":"^0.9.1"}}\n',
      );
      writeFileSync(
        join(repoDir, "package-lock.json"),
        '{"lockfileVersion":3}\n',
      );
      mkdirSync(join(repoDir, ".shipyard"));
      writeFileSync(join(repoDir, ".shipyard", "main.mts"), "export {};\n");
      writeFileSync(join(repoDir, ".shipyard", ".gitignore"), ".env\n");
      writeFileSync(join(repoDir, ".shipyard", ".env"), "GH_TOKEN=secret\n");
      mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(repoDir, ".github", "workflows", "shipyard-wake.yml"),
        "name: Shipyard\n",
      );
      writeFileSync(join(repoDir, "unrelated.txt"), "keep staged\n");
      git("add", "unrelated.txt");

      const result = commitAndPushInitSetup(repoDir);

      expect(result).toMatchObject({ branch: "main" });
      expect(result.pushError).toBeUndefined();
      expect(
        git("show", "--pretty=format:", "--name-only", "HEAD").split("\n"),
      ).toEqual([
        ".github/workflows/shipyard-wake.yml",
        ".shipyard/.gitignore",
        ".shipyard/main.mts",
        "package-lock.json",
        "package.json",
      ]);
      expect(git("status", "--short")).toBe("A  unrelated.txt");
      expect(git("rev-parse", "HEAD")).toBe(
        git("rev-parse", "refs/remotes/origin/main"),
      );
      expect(readFileSync(join(repoDir, ".shipyard", ".env"), "utf8")).toBe(
        "GH_TOKEN=secret\n",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
