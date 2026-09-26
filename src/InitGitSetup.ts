import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./runtimeNames.js";
import { REPOSITORY_RUNNER_WORKFLOW_PATH } from "./RepositoryRunnerWake.js";

export interface InitGitSetupResult {
  readonly branch: string;
  readonly commit: string;
  readonly pushError?: string;
}

const errorText = (error: unknown): string => {
  if (error !== null && typeof error === "object" && "stderr" in error) {
    const stderr = error.stderr;
    if (typeof stderr === "string" || Buffer.isBuffer(stderr)) {
      const text = stderr.toString().trim();
      if (text) return text;
    }
  }
  return error instanceof Error ? error.message : String(error);
};

/** Commit generated setup files, then push the current branch to origin. */
export const commitAndPushInitSetup = (repoDir: string): InitGitSetupResult => {
  const branch = execFileSync("git", ["branch", "--show-current"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();
  if (!branch) {
    throw new Error("Cannot push the Shipyard setup from a detached HEAD.");
  }

  const paths = [CONFIG_DIR];
  if (existsSync(join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH))) {
    paths.push(REPOSITORY_RUNNER_WORKFLOW_PATH);
  }
  for (const packageFile of ["package.json", "package-lock.json"]) {
    if (existsSync(join(repoDir, packageFile))) paths.push(packageFile);
  }

  execFileSync("git", ["add", "--", ...paths], {
    cwd: repoDir,
    stdio: "ignore",
  });
  // Keep unrelated staged changes out of the generated setup commit.
  execFileSync(
    "git",
    ["commit", "--only", "-m", "Add Shipyard setup", "--", ...paths],
    { cwd: repoDir, stdio: "pipe" },
  );
  const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
  }).trim();

  try {
    execFileSync("git", ["push", "origin", `HEAD:refs/heads/${branch}`], {
      cwd: repoDir,
      stdio: "pipe",
    });
    return { branch, commit };
  } catch (error) {
    return { branch, commit, pushError: errorText(error) };
  }
};
