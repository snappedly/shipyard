// Simple loop: select one activated issue scope per iteration, implement it,
// then hand its verified commit to a human through a pull request.
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
const verifyTriage = (ticketId: string) => {
  try {
    execFileSync("bash", [".shipyard/verify-triage.sh", ticketId, repository], {
      encoding: "utf8",
    });
  } catch (error) {
    const detail = (error as { stderr?: string | Buffer }).stderr
      ?.toString()
      .trim();
    throw new Error(detail || `Could not verify triage for #${ticketId}`);
  }
};

const blockScope = (
  scope: { id: string; branch: string; tickets?: Array<{ id: string }> },
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
      scope.branch,
    ],
    { input: reason, encoding: "utf8" },
  );
  console.error(`Shipyard blocked issue #${scope.id}: ${reason}`);
};

for (let iteration = 0; iteration < 3; iteration++) {
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
    completedTicketIds?: string[];
    outstandingTicketIds?: string[];
  }>;
  const issue = issues[0];
  if (!issue) break;

  let handedOff = false;
  let publicationUncertain = false;
  try {
    execFileSync("gh", [
      "label",
      "create",
      "shipyard:pending",
      "--repo",
      repository,
      "--color",
      "1D76DB",
      "--description",
      "Shipyard is working on this ticket",
      "--force",
    ]);
    for (const ticketId of issue.kind === "spec"
      ? (issue.tickets ?? []).map((ticket) => ticket.id)
      : [issue.id])
      execFileSync("gh", [
        "issue",
        "edit",
        ticketId,
        "--repo",
        repository,
        "--add-label",
        "shipyard:pending",
      ]);
    const sandbox = await shipyard.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
      hooks,
    });
    let evidence: string;
    try {
      for (const ticketId of issue.kind === "spec"
        ? (issue.tickets ?? []).map((ticket) => ticket.id)
        : [issue.id]) {
        await sandbox.run({
          name: `triage #${ticketId}`,
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          maxIterations: 1,
          promptFile: "./.shipyard/triage-prompt.md",
          promptArgs: { TASK_ID: ticketId },
        });
        verifyTriage(ticketId);
      }
      const result = await sandbox.run({
        name: "implementer",
        agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
        maxIterations: 1,
        promptFile: "./.shipyard/prompt.md",
        promptArgs: {
          TASK_ID: issue.id,
          ISSUE_TITLE: issue.title,
          BRANCH: issue.branch,
          SCOPE: JSON.stringify(issue),
          SKILL: issue.kind === "spec" ? "/implement-spec" : "/implement",
        },
      });
      const packet = [
        ...result.stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g),
      ]
        .at(-1)?.[1]
        ?.trim();
      if (!result.completionSignal || !packet)
        throw new Error(
          `Issue #${issue.id} has no verified completion evidence: ${result.stdout.trim().slice(-1200)}`,
        );
      evidence = packet;
    } finally {
      await closeClean(sandbox);
    }

    // Sync-out rewrites sandbox commits on the host. Publish from the synced
    // branch so a later invocation can fast-forward the same PR.
    const publication = await shipyard.createSandbox({
      branch: issue.branch,
      sandbox: docker(),
    });
    try {
      publicationUncertain = true;
      const handoff = await publication.exec(
        `bash .shipyard/handoff.sh ${issue.id} ${issue.branch} ${targetBranch} ${repository} ${[issue.id, ...(issue.tickets ?? []).map((ticket) => ticket.id)].join(",")} ${issue.outstandingTicketIds?.join(",") || "-"} ${issue.completedTicketIds?.join(",") || "-"}`,
        { stdin: evidence },
      );
      publicationUncertain = handoff.exitCode === 75;
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
    if (handedOff || publicationUncertain) throw error;
    blockScope(issue, error);
  }
}
