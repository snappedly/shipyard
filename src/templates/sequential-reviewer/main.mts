// Sequential Reviewer: one implementation and one independent review per
// activated issue scope. Publication follows successful review.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

if (process.loadEnvFile && existsSync(".shipyard/.env"))
  process.loadEnvFile(".shipyard/.env");
const modelRoles = shipyard.CODEX_MODELS;
type ModelRole = "routine" | "strong";
const maxStrongRunsPerIssue = Number(
  process.env.SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE ?? "8",
);
if (!Number.isSafeInteger(maxStrongRunsPerIssue) || maxStrongRunsPerIssue < 0)
  throw new Error(
    "SHIPYARD_MAX_STRONG_RUNS_PER_ISSUE must be a nonnegative integer",
  );
const strongRuns = new Map<string, number>();
const writeUsageRecord = (record: Record<string, unknown>): void => {
  try {
    mkdirSync(".shipyard/logs", { recursive: true });
    appendFileSync(
      ".shipyard/logs/model-usage.jsonl",
      JSON.stringify(record) + "\n",
    );
  } catch (error) {
    console.warn(
      `shipyard: could not record model usage: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};
const roleAgent = (role: ModelRole) => ({
  ...shipyard.codex(modelRoles[role].model, {
    effort: modelRoles[role].effort,
    disableSubagents: true,
  }),
  role,
});
const recordModelRun = async <
  T extends {
    completionSignal?: string;
    iterations?: Array<{ usage?: shipyard.IterationUsage }>;
  },
>(
  issueId: string,
  phase: string,
  agent: ReturnType<typeof roleAgent>,
  operation: Promise<T>,
  attempt = 1,
  escalationReason?: string,
  issueIds: string[] = [issueId],
): Promise<T> => {
  let result: T | undefined;
  let status: "completed" | "returned-without-signal" | "failed" = "failed";
  try {
    result = await operation;
    status = result.completionSignal ? "completed" : "returned-without-signal";
    return result;
  } finally {
    const measured =
      result?.iterations?.flatMap((iteration) =>
        iteration.usage ? [iteration.usage] : [],
      ) ?? [];
    const usage = measured.length
      ? measured.reduce(
          (total, item) => ({
            inputTokens: total.inputTokens + item.inputTokens,
            cacheCreationInputTokens:
              total.cacheCreationInputTokens + item.cacheCreationInputTokens,
            cacheReadInputTokens:
              total.cacheReadInputTokens + item.cacheReadInputTokens,
            outputTokens: total.outputTokens + item.outputTokens,
          }),
          {
            inputTokens: 0,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            outputTokens: 0,
          },
        )
      : null;
    writeUsageRecord({
      issueId,
      issueIds,
      attempt,
      escalationReason: escalationReason ?? null,
      phase,
      role: agent.role,
      provider: agent.name,
      model: agent.model ?? null,
      effort: agent.effort ?? null,
      status,
      iterations: result?.iterations?.length ?? null,
      measuredIterations: measured.length,
      usage,
      childUsage: { builtIn: "disabled", external: "unknown" },
    });
  }
};
const guardStrongRun = (
  issueId: string,
  phase: string,
  agent: ReturnType<typeof roleAgent>,
): void => {
  if (agent.role !== "strong") return;
  const used = strongRuns.get(issueId) ?? 0;
  if (used < maxStrongRunsPerIssue) {
    strongRuns.set(issueId, used + 1);
    return;
  }
  writeUsageRecord({
    issueId,
    issueIds: [issueId],
    attempt: used + 1,
    escalationReason: null,
    phase,
    role: agent.role,
    provider: agent.name,
    model: agent.model ?? null,
    effort: agent.effort ?? null,
    status: "budget-exhausted",
    usage: null,
    childUsage: { builtIn: "disabled", external: "unknown" },
  });
  throw new Error(
    `Issue #${issueId} reached the strong model run limit (${maxStrongRunsPerIssue})`,
  );
};
const trackSandbox = (sandbox: shipyard.Sandbox): void => {
  const run = sandbox.run.bind(sandbox);
  sandbox.run = (options) => {
    const agent = options.agent as ReturnType<typeof roleAgent>;
    const issueId = String(options.promptArgs?.TASK_ID ?? "selection");
    const phase = options.name ?? "agent";
    guardStrongRun(issueId, phase, agent);
    return recordModelRun(
      issueId,
      phase,
      agent,
      run(options),
      phase === "implementer-escalation" ? 2 : 1,
      phase === "implementer-escalation"
        ? "routine implementation returned without a completion signal"
        : undefined,
    );
  };
};
const escalateRoutineFailures =
  process.env.SHIPYARD_ESCALATE_ROUTINE_FAILURES === "true";
const escalatedIssues = new Set<string>();
const runImplementation = async (
  sandbox: shipyard.Sandbox,
  options: shipyard.SandboxRunOptions,
): Promise<shipyard.SandboxRunResult> => {
  const result = await sandbox.run(options);
  const issueId = String(options.promptArgs?.TASK_ID ?? "selection");
  if (
    result.completionSignal ||
    !escalateRoutineFailures ||
    escalatedIssues.has(issueId)
  )
    return result;
  escalatedIssues.add(issueId);
  const handoff = [
    ...result.stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g),
  ].at(-1)?.[1];
  const fields = ["Facts", "Checks", "Blocker"].map((field) =>
    handoff?.match(new RegExp(`^${field}:\\s*(.+)$`, "m"))?.[1]?.trim(),
  );
  if (fields.some((field) => !field)) return result;
  const failureEvidence = ["Facts", "Checks", "Blocker"]
    .map((field, index) => `${field}: ${fields[index]!.slice(0, 400)}`)
    .join("\n");
  return sandbox.run({
    ...options,
    name: "implementer-escalation",
    agent: roleAgent("strong"),
    maxIterations: 1,
    promptFile: "./.shipyard/escalation-prompt.md",
    promptArgs: {
      ...options.promptArgs,
      ROUTINE_EVIDENCE: failureEvidence,
    },
  });
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

const runTriage = async (sandbox: shipyard.Sandbox, ticketId: string) => {
  const triage = await sandbox.run({
    name: `triage #${ticketId}`,
    agent: roleAgent("routine"),
    maxIterations: 1,
    promptFile: "./.shipyard/triage-prompt.md",
    promptArgs: { TASK_ID: ticketId },
  });
  if (triage.stdout.trim().endsWith("<risk>strong-review</risk>"))
    await sandbox.run({
      name: `risk-review #${ticketId}`,
      agent: roleAgent("strong"),
      maxIterations: 1,
      promptFile: "./.shipyard/risk-triage-prompt.md",
      promptArgs: { TASK_ID: ticketId },
    });
  verifyTriage(ticketId);
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
      sandbox: docker(),
      hooks,
    });
    trackSandbox(sandbox);
    let evidence: string;
    try {
      for (const ticketId of issue.kind === "spec"
        ? (issue.tickets ?? []).map((ticket) => ticket.id)
        : [issue.id]) {
        await runTriage(sandbox, ticketId);
      }
      const implement = await runImplementation(sandbox, {
        name: "implementer",
        maxIterations: 1,
        agent: roleAgent("routine"),
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
        agent: roleAgent("strong"),
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
    trackSandbox(publication);
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
