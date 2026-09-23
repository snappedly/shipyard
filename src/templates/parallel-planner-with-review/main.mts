// Parallel Planner with Review: plan, implement and review independent issues
// in parallel, then validate and publish each branch for human review.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { z } from "zod";

if (process.loadEnvFile && existsSync(".shipyard/.env"))
  process.loadEnvFile(".shipyard/.env");
const targetBranch = execFileSync("git", ["branch", "--show-current"], {
  encoding: "utf8",
}).trim();
const repository = execFileSync(
  "gh",
  ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
  { encoding: "utf8" },
).trim();
if (
  !/^[A-Za-z0-9._/-]+$/.test(targetBranch) ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
) {
  throw new Error("Invalid target branch or GitHub repository");
}
process.env.GH_REPO = repository;
const MAX_ITERATIONS = 10;
const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "timeout 300 bash .shipyard/setup.sh", timeoutMs: 300_000 },
    ],
  },
};
const planSchema = z.object({
  issues: z.array(
    z.object({ id: z.string(), title: z.string(), branch: z.string() }),
  ),
});

const handoffEvidence = (stdout: string): string | undefined =>
  [...stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)].at(-1)?.[1]?.trim();

for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  const plan = await shipyard.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    branchStrategy: { type: "branch", branch: "shipyard/planner" },
    maxIterations: 1,
    agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
    promptFile: "./.shipyard/plan-prompt.md",
    output: shipyard.Output.object({ tag: "plan", schema: planSchema }),
  });
  const issues = plan.output.issues;
  if (!issues.length) break;
  for (const issue of issues) {
    if (
      !/^\d+$/.test(issue.id) ||
      issue.branch !== `shipyard/issue-${issue.id}`
    )
      throw new Error(`Invalid planned branch for #${issue.id}`);
  }

  // Each independent branch has its own implementer followed by a distinct
  // reviewer. Pipelines run concurrently; a failed review cannot reach PR handoff.
  const settled = await Promise.allSettled(
    issues.map(async (issue) => {
      const sandbox = await shipyard.createSandbox({
        branch: issue.branch,
        sandbox: docker(),
        hooks,
      });
      try {
        const implement = await sandbox.run({
          name: "implementer",
          maxIterations: 100,
          agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
          promptFile: "./.shipyard/implement-prompt.md",
          promptArgs: {
            TASK_ID: issue.id,
            ISSUE_TITLE: issue.title,
            BRANCH: issue.branch,
          },
        });
        const implementationEvidence = handoffEvidence(implement.stdout);
        if (!implement.completionSignal || !implementationEvidence)
          throw new Error(`No verified implementation for #${issue.id}`);
        const review = await sandbox.run({
          name: "reviewer",
          maxIterations: 1,
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          promptFile: "./.shipyard/review-prompt.md",
          promptArgs: { BRANCH: issue.branch, TASK_ID: issue.id },
        });
        const reviewEvidence = handoffEvidence(review.stdout);
        if (
          !review.completionSignal ||
          !review.stdout.includes("<review>APPROVED</review>") ||
          !reviewEvidence
        ) {
          throw new Error(`Review findings unresolved for #${issue.id}`);
        }
        return {
          issue,
          evidence: `${implementationEvidence}\n\n${reviewEvidence}`,
        };
      } finally {
        await sandbox.close();
      }
    }),
  );

  let completed = 0;
  for (const [index, outcome] of settled.entries()) {
    if (outcome.status === "rejected") {
      console.error(`Issue #${issues[index]!.id} failed: ${outcome.reason}`);
      continue;
    }
    const { issue, evidence } = outcome.value;
    const sandbox = await shipyard.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
      hooks,
    });
    try {
      const merged = await sandbox.run({
        name: "merger",
        maxIterations: 1,
        agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
        promptFile: "./.shipyard/merge-prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
        },
      });
      const finalEvidence = handoffEvidence(merged.stdout);
      if (!merged.completionSignal || !finalEvidence)
        throw new Error(`Final checks incomplete for #${issue.id}`);
      const handoff = await sandbox.exec(
        `bash .shipyard/handoff.sh ${issue.id} ${issue.branch} ${targetBranch} ${repository}`,
        { stdin: `${evidence}\n\n${finalEvidence}` },
      );
      if (handoff.exitCode !== 0)
        throw new Error(
          `PR handoff for #${issue.id} failed: ${handoff.stderr || handoff.stdout}`,
        );
      console.log(handoff.stdout.trim());
      completed++;
    } finally {
      await sandbox.close();
    }
  }
  if (!completed) break;
}
