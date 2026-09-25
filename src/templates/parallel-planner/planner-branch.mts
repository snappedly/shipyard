import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const PLANNER_BRANCH = "shipyard/planner";

type BranchPrompt = (message: string) => Promise<string>;

const askInTerminal: BranchPrompt = async (message) => {
  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await readline.question(message);
  } finally {
    readline.close();
  }
};

const refsConflict = (left: string, right: string): boolean =>
  left.startsWith(`${right}/`) || right.startsWith(`${left}/`);

const nextPlannerBranch = (localBranches: readonly string[]): string => {
  for (let suffix = 2; ; suffix++) {
    for (const candidate of [
      `${PLANNER_BRANCH}-${suffix}`,
      `shipyard-planner-${suffix}`,
    ]) {
      if (!localBranches.some((branch) => refsConflict(candidate, branch)))
        return candidate;
    }
  }
};

const reusablePlannerBranch = (
  localBranches: readonly string[],
): string | undefined => {
  const candidates = localBranches
    .map((branch) => ({
      branch,
      suffix: /^(?:shipyard\/planner-|shipyard-planner-)(\d+)$/.exec(
        branch,
      )?.[1],
    }))
    .filter((candidate) => candidate.suffix !== undefined)
    .sort((left, right) => Number(left.suffix) - Number(right.suffix));

  return candidates.find(({ branch }) =>
    localBranches.every(
      (other) => other === branch || !refsConflict(branch, other),
    ),
  )?.branch;
};

export const resolvePlannerBranch = async (
  localBranches: readonly string[],
  options: {
    isInteractive?: boolean;
    ask?: BranchPrompt;
    checkedOutBranches?: readonly string[];
    mergedBranches?: readonly string[];
    deleteBranches?: (branches: readonly string[]) => void;
  } = {},
): Promise<string> => {
  const conflicts = localBranches.filter((branch) =>
    refsConflict(PLANNER_BRANCH, branch),
  );
  if (conflicts.length === 0) return PLANNER_BRANCH;

  const reusable = reusablePlannerBranch(localBranches);
  if (reusable) return reusable;

  const alternate = nextPlannerBranch(localBranches);

  const conflictList = conflicts.map((branch) => `  - ${branch}`).join("\n");
  const context =
    `Planner branch '${PLANNER_BRANCH}' conflicts with local branch refs:\n${conflictList}\n` +
    `Git cannot create both names. The listed local branches will be kept unless you choose deletion.`;
  const isInteractive =
    options.isInteractive ??
    Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isInteractive) {
    throw new Error(
      `${context}\nRerun in an interactive terminal to keep them and use '${alternate}', or request local deletion after Git checks that they are merged and not checked out. No branches were changed.`,
    );
  }

  const checkedOutBranches = new Set(
    options.checkedOutBranches ??
      execFileSync("git", ["worktree", "list", "--porcelain"], {
        encoding: "utf8",
      })
        .split(/\r?\n/)
        .filter((line) => line.startsWith("branch refs/heads/"))
        .map((line) => line.slice("branch refs/heads/".length)),
  );
  const mergedBranches = new Set(
    options.mergedBranches ??
      execFileSync(
        "git",
        ["branch", "--merged", "HEAD", "--format=%(refname:short)"],
        { encoding: "utf8" },
      )
        .split(/\r?\n/)
        .filter(Boolean),
  );
  const branchesSafeToDelete = conflicts.every(
    (branch) => !checkedOutBranches.has(branch) && mergedBranches.has(branch),
  );
  const unsafeDeleteReasons = conflicts.flatMap((branch) => {
    if (checkedOutBranches.has(branch))
      return [`'${branch}' is checked out in a worktree`];
    if (!mergedBranches.has(branch))
      return [`'${branch}' has commits not merged into HEAD`];
    return [];
  });

  const ask = options.ask ?? askInTerminal;
  const answer = await ask(
    `${context}\n[Y] Keep them and use '${alternate}' (recommended)\n` +
      `[d] Delete these local branches and use '${PLANNER_BRANCH}'${
        branchesSafeToDelete
          ? ""
          : ` (unavailable: ${unsafeDeleteReasons.join("; ")})`
      }\n` +
      `[n] Abort without changes\nChoose [Y/d/n]: `,
  );
  const choice = answer.trim().toLowerCase();
  if (choice === "" || choice === "y" || choice === "yes") return alternate;
  if (choice === "d" || choice === "delete") {
    if (!branchesSafeToDelete) {
      throw new Error(
        `Cannot safely delete the conflicting branches: ${unsafeDeleteReasons.join("; ")}. No branches were changed. Use '${alternate}' or inspect the listed refs manually.`,
      );
    }
    const deleteBranches =
      options.deleteBranches ??
      ((branches: readonly string[]) => {
        for (const branch of branches)
          execFileSync("git", ["branch", "-d", branch], {
            encoding: "utf8",
          });
      });
    deleteBranches(conflicts);
    return PLANNER_BRANCH;
  }

  throw new Error(
    `Planner branch selection cancelled. No branches were changed. Inspect with 'git worktree list' and 'git branch --list "shipyard/planner*"', then rerun.`,
  );
};
