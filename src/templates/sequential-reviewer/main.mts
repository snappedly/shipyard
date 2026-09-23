// Sequential Reviewer: one implementation and one independent review per
// activated issue scope. Publication follows successful review.
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
const closeClean = async (sandbox: {
  close: () => Promise<{ preservedWorktreePath?: string }>;
}) => {
  const { preservedWorktreePath } = await sandbox.close();
  if (preservedWorktreePath)
    throw new Error(`Sandbox has uncommitted work at ${preservedWorktreePath}`);
};

const handoffEvidence = (stdout: string): string | undefined =>
  [...stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)].at(-1)?.[1]?.trim();
const blockScope = (
  scope: { id: string; tickets?: Array<{ id: string }> },
  error: unknown,
) => {
  const reason = (error instanceof Error ? error.message : String(error)).slice(
    0,
    3000,
  );
  execFileSync(
    "bash",
    [
      ".shipyard/block-scope.sh",
      scope.id,
      scope.id,
      repository,
      [scope.id, ...(scope.tickets ?? []).map((ticket) => ticket.id)].join(","),
    ],
    { input: reason, encoding: "utf8" },
  );
  console.error(`Shipyard blocked issue #${scope.id}: ${reason}`);
};

for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
  const issues = JSON.parse(
    execFileSync("node", [".shipyard/select-issues.mjs"], { encoding: "utf8" }),
  ) as Array<{
    id: string;
    title: string;
    branch: string;
    kind: "standalone" | "spec";
    body?: string;
    tickets?: Array<{
      id: string;
      title: string;
      body: string;
      state: string;
      blockedBy: Array<{ id: string; title: string; state: string }>;
    }>;
  }>;
  const issue = issues[0];
  if (!issue) break;

  let handedOff = false;
  try {
    const sandbox = await shipyard.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
      hooks,
    });
    let evidence: string;
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
          SCOPE: JSON.stringify(issue),
          SKILL: issue.kind === "spec" ? "/implement-spec" : "/implement",
        },
      });
      const implementationEvidence = handoffEvidence(implement.stdout);
      if (!implement.completionSignal || !implementationEvidence)
        throw new Error(
          `Issue #${issue.id} has no verified implementation evidence: ${implement.stdout.trim().slice(-1200)}`,
        );

      const review = await sandbox.run({
        name: "reviewer",
        maxIterations: 1,
        agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
        promptFile: "./.shipyard/review-prompt.md",
        promptArgs: {
          BRANCH: issue.branch,
          SCOPE: JSON.stringify(issue),
          SKILL: issue.kind === "spec" ? "/implement-spec" : "/implement",
          TASK_ID: issue.id,
        },
      });
      const reviewEvidence = handoffEvidence(review.stdout);
      if (
        !review.completionSignal ||
        !review.stdout.includes("<review>APPROVED</review>") ||
        !reviewEvidence
      ) {
        throw new Error(
          `Issue #${issue.id} has unresolved review findings: ${review.stdout.trim().slice(-1200)}`,
        );
      }
      evidence = `${implementationEvidence}\n\n${reviewEvidence}`;
    } finally {
      await closeClean(sandbox);
    }

    const publication = await shipyard.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
    });
    try {
      const handoff = await publication.exec(
        `bash .shipyard/handoff.sh ${issue.id} ${issue.branch} ${targetBranch} ${repository} ${[issue.id, ...(issue.tickets ?? []).map((ticket) => ticket.id)].join(",")}`,
        { stdin: evidence },
      );
      if (handoff.exitCode !== 0)
        throw new Error(
          `PR handoff for #${issue.id} failed: ${handoff.stderr || handoff.stdout}`,
        );
      console.log(handoff.stdout.trim());
      handedOff = true;
    } finally {
      await publication.close();
    }
  } catch (error) {
    if (handedOff) throw error;
    blockScope(issue, error);
  }
}
