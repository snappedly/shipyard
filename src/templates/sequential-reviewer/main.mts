// Sequential Reviewer: one implementation and one independent review per
// activated standalone issue. Publication follows successful review.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

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

const handoffEvidence = (stdout: string): string | undefined =>
  [...stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)].at(-1)?.[1]?.trim();

for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  const issues = JSON.parse(
    execFileSync("node", [".shipyard/select-issues.mjs"], { encoding: "utf8" }),
  ) as Array<{ id: string; title: string; branch: string }>;
  const issue = issues[0];
  if (!issue) break;

  const sandbox = await shipyard.createSandbox({
    branch: issue.branch,
    sandbox: docker(),
    hooks,
  });
  try {
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 1,
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
      throw new Error(
        `Issue #${issue.id} has no verified implementation evidence`,
      );

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
      throw new Error(`Issue #${issue.id} has unresolved review findings`);
    }
    const handoff = await sandbox.exec(
      `bash .shipyard/handoff.sh ${issue.id} ${issue.branch} ${targetBranch} ${repository}`,
      { stdin: `${implementationEvidence}\n\n${reviewEvidence}` },
    );
    if (handoff.exitCode !== 0)
      throw new Error(
        `PR handoff for #${issue.id} failed: ${handoff.stderr || handoff.stdout}`,
      );
    console.log(handoff.stdout.trim());
  } finally {
    await sandbox.close();
  }
}
