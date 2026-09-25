// Sequential Reviewer: one implementation and one independent review per
// activated issue scope. Publication follows successful review.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

if (process.loadEnvFile && existsSync(".shipyard/.env"))
  process.loadEnvFile(".shipyard/.env");
type ModelRole = "routine" | "strong";
const CODEX_PROVIDER = true;
const agentFactory = shipyard.codex;
type AgentModel = Parameters<typeof agentFactory>[0];
const readRoleModel = (role: ModelRole): string | undefined => {
  const envName = `SHIPYARD_${role.toUpperCase()}_MODEL`;
  const model = process.env[envName];
  if (model !== undefined && model.trim().length === 0)
    throw new Error(`${envName} must not be empty`);
  return model;
};
const roleModels = {
  routine: readRoleModel("routine"),
  strong: readRoleModel("strong"),
};
const CODEX_REASONING_EFFORTS = shipyard.CODEX_REASONING_EFFORTS;
type CodexReasoningEffort = shipyard.CodexReasoningEffort;
const readCodexReasoningEffort = (
  role: ModelRole,
): CodexReasoningEffort | undefined => {
  if (!CODEX_PROVIDER) return undefined;
  const envName = `SHIPYARD_CODEX_${role.toUpperCase()}_REASONING_EFFORT`;
  const effort = process.env[envName]?.trim();
  if (!effort) return undefined;
  if (!(CODEX_REASONING_EFFORTS as readonly string[]).includes(effort))
    throw new Error(
      `${envName} must be one of ${CODEX_REASONING_EFFORTS.join(", ")}; received "${effort}"`,
    );
  return effort as CodexReasoningEffort;
};
const roleEfforts = {
  routine: readCodexReasoningEffort("routine"),
  strong: readCodexReasoningEffort("strong"),
};
const readCodexRoleModel = (role: ModelRole, defaultModel: AgentModel) => {
  if (!CODEX_PROVIDER || typeof defaultModel === "string") return defaultModel;
  const envName = `SHIPYARD_CODEX_${role.toUpperCase()}_MODEL`;
  const model = process.env[envName]?.trim();
  return model ? { ...defaultModel, model } : defaultModel;
};
const roleAgent = (role: ModelRole, defaultModel: AgentModel) => {
  const model = roleModels[role] ?? readCodexRoleModel(role, defaultModel);
  const effort = roleEfforts[role];
  if (typeof model !== "string")
    return effort === undefined
      ? agentFactory(model)
      : agentFactory(model, { effort });
  return agentFactory(model, { effort: effort ?? null });
};
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
const sandboxAuthOptions = {};
const sandboxProvider = docker({
  env: { GH_REPO: repository },
  ...sandboxAuthOptions,
});
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

const handoffEvidence = (stdout: string): string | undefined =>
  [...stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)].at(-1)?.[1]?.trim();
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
      sandbox: sandboxProvider,
      hooks,
    });
    let evidence: string;
    try {
      for (const ticketId of issue.kind === "spec"
        ? (issue.tickets ?? []).map((ticket) => ticket.id)
        : [issue.id]) {
        await sandbox.run({
          name: `triage #${ticketId}`,
          agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
          maxIterations: 1,
          promptFile: "./.shipyard/triage-prompt.md",
          promptArgs: { TASK_ID: ticketId },
        });
        verifyTriage(ticketId);
      }
      const implement = await sandbox.run({
        name: "implementer",
        maxIterations: 1,
        agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
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
        agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
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
      sandbox: sandboxProvider,
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
