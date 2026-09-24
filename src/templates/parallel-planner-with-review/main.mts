// Plan activated scopes, implement independent tickets in parallel, then
// integrate each scope on one branch for human review.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { z } from "zod";
import { resolvePlannerBranch } from "./planner-branch.mjs";

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
)
  throw new Error("Invalid target branch or GitHub repository");
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
const planSchema = z.object({ issues: z.array(z.object({ id: z.string() })) });
type Ticket = {
  id: string;
  title: string;
  body: string;
  state: string;
  blockedBy: Array<{ id: string; title: string; state: string }>;
};
type Scope = {
  id: string;
  title: string;
  branch: string;
  kind: "standalone" | "spec";
  body?: string;
  tickets?: Ticket[];
  completedTicketIds?: string[];
  outstandingTicketIds?: string[];
};
const complete = (
  result: { stdout: string; completionSignal?: string | null },
  stage: string,
) => {
  const packet = [...result.stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)]
    .at(-1)?.[1]
    ?.trim();
  if (!result.completionSignal || !packet)
    throw new Error(
      `${stage} lacks verified completion evidence: ${result.stdout.trim().slice(-1200)}`,
    );
  return packet;
};
const approved = (
  result: { stdout: string; completionSignal?: string | null },
  stage: string,
) => {
  if (!result.stdout.includes("<review>APPROVED</review>"))
    throw new Error(
      `${stage} has unresolved review findings: ${result.stdout.trim().slice(-1200)}`,
    );
  return complete(result, stage);
};
class TicketFailures extends Error {
  constructor(readonly failures: Array<{ id: string; reason: string }>) {
    super(
      failures.map((failure) => `#${failure.id}: ${failure.reason}`).join("; "),
    );
  }
}
const blockScope = (scope: Scope, failedId: string, reason: string) => {
  reason = reason.slice(0, 3000);
  execFileSync(
    "bash",
    [
      ".shipyard/block-scope.sh",
      scope.id,
      failedId,
      repository,
      [scope.id, ...(scope.tickets ?? []).map((ticket) => ticket.id)].join(","),
      scope.branch,
    ],
    { input: reason, encoding: "utf8" },
  );
  console.error(`Shipyard blocked issue #${failedId}: ${reason}`);
};
const runWorker = async (scope: Scope, ticket: Ticket) => {
  const branch = `shipyard/spec-${scope.id}-issue-${ticket.id}`;
  const sandbox = await shipyard.createSandbox({
    branch,
    baseBranch: scope.branch,
    sandbox: docker(),
    hooks,
  });
  try {
    await sandbox.run({
      name: `triage #${ticket.id}`,
      maxIterations: 1,
      agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
      promptFile: "./.shipyard/triage-prompt.md",
      promptArgs: { TASK_ID: ticket.id },
    });
    verifyTriage(ticket.id);
    const implementation = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
      promptFile: "./.shipyard/implement-prompt.md",
      promptArgs: {
        TASK_ID: ticket.id,
        ISSUE_TITLE: ticket.title,
        BRANCH: branch,
        SCOPE: JSON.stringify(scope),
      },
    });
    let packet = complete(implementation, `Implementation of #${ticket.id}`);
    const review = await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
      promptFile: "./.shipyard/review-prompt.md",
      promptArgs: {
        TASK_ID: ticket.id,
        BRANCH: branch,
        BASE_BRANCH: scope.branch,
        SCOPE: JSON.stringify(scope),
      },
    });
    packet += `\n\n${approved(review, `Review of #${ticket.id}`)}`;
    return { branch, packet };
  } finally {
    await closeClean(sandbox);
  }
};

for (let iteration = 0; iteration < 10; iteration++) {
  const scopes = JSON.parse(
    execFileSync("node", [".shipyard/select-issues.mjs"], { encoding: "utf8" }),
  ) as Scope[];
  if (!scopes.length) break;
  const localBranches = execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .filter(Boolean);
  const plannerBranch = await resolvePlannerBranch(localBranches);
  const plan = await shipyard.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    branchStrategy: { type: "branch", branch: plannerBranch },
    maxIterations: 1,
    agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
    promptFile: "./.shipyard/plan-prompt.md",
    output: shipyard.Output.object({ tag: "plan", schema: planSchema }),
  });
  const ids = plan.output.issues.map((item: { id: string }) => item.id);
  if (!ids.length)
    throw new Error("Planner returned no work for activated scopes");
  if (new Set(ids).size !== ids.length)
    throw new Error("Planner duplicated an issue scope");
  for (const id of ids)
    if (!scopes.some((scope) => scope.id === id))
      throw new Error(`Planner selected unknown scope #${id}`);

  const outcomes = await Promise.allSettled(
    ids.map(async (id) => {
      const scope = scopes.find((item) => item.id === id)!;
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
        for (const ticketId of scope.kind === "spec"
          ? (scope.tickets ?? []).map((ticket) => ticket.id)
          : [scope.id])
          execFileSync("gh", [
            "issue",
            "edit",
            ticketId,
            "--repo",
            repository,
            "--add-label",
            "shipyard:pending",
          ]);
        if (
          scope.branch !==
          (scope.kind === "spec"
            ? `shipyard/spec-${id}`
            : `shipyard/issue-${id}`)
        )
          throw new Error(`Invalid branch for #${id}`);
        let workerEvidence = "";
        if (scope.kind === "spec") {
          const seed = await shipyard.createSandbox({
            branch: scope.branch,
            sandbox: docker(),
            hooks,
          });
          await closeClean(seed);
          const tickets = scope.tickets ?? [];
          if (!tickets.length)
            throw new Error(`Spec #${id} has no executable tickets`);
          const remaining = new Map(
            tickets.map((ticket) => [ticket.id, ticket]),
          );
          const completed = new Set<string>(scope.completedTicketIds ?? []);
          while (remaining.size) {
            const ready = [...remaining.values()].filter((ticket) =>
              ticket.blockedBy.every(
                (blocker) =>
                  String(blocker.state).toLowerCase() === "closed" ||
                  completed.has(blocker.id),
              ),
            );
            if (!ready.length)
              throw new Error(
                `Spec #${id} has unresolved or cyclic ticket dependencies`,
              );
            const settled = await Promise.allSettled(
              ready.map((ticket) => runWorker(scope, ticket)),
            );
            const failures = settled.flatMap((outcome, index) =>
              outcome.status === "rejected"
                ? [{ id: ready[index]!.id, reason: String(outcome.reason) }]
                : [],
            );
            if (failures.length) throw new TicketFailures(failures);
            const wave = await shipyard.createSandbox({
              branch: scope.branch,
              sandbox: docker(),
              hooks,
            });
            try {
              for (const [index, outcome] of settled.entries()) {
                if (outcome.status !== "fulfilled") continue;
                const commits = await wave.exec(
                  `git rev-list --reverse HEAD..origin/${outcome.value.branch}`,
                );
                if (commits.exitCode !== 0 || !commits.stdout.trim())
                  throw new TicketFailures([
                    {
                      id: ready[index]!.id,
                      reason: "No committed changes to integrate",
                    },
                  ]);
                const shas = commits.stdout.trim().split(/\s+/);
                if (!shas.every((sha) => /^[a-f0-9]{40}$/.test(sha)))
                  throw new TicketFailures([
                    {
                      id: ready[index]!.id,
                      reason: "Invalid commit on ticket branch",
                    },
                  ]);
                const before = await wave.exec("git rev-parse HEAD");
                if (
                  before.exitCode !== 0 ||
                  !/^[a-f0-9]{40}\s*$/.test(before.stdout)
                )
                  throw new Error(
                    "Could not read spec branch commit before integration",
                  );
                const picked = await wave.exec(
                  `git -c user.name=Shipyard -c user.email=shipyard@users.noreply.github.com cherry-pick -x ${shas.join(" ")}`,
                );
                if (picked.exitCode !== 0) {
                  try {
                    const resolution = await wave.run({
                      name: "conflict-resolver",
                      maxIterations: 10,
                      agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
                      promptFile: "./.shipyard/conflict-prompt.md",
                      promptArgs: {
                        TASK_ID: ready[index]!.id,
                        BRANCH: scope.branch,
                        SCOPE: JSON.stringify(scope),
                        COMMITS: shas.join(","),
                        CONFLICT: picked.stderr || picked.stdout,
                      },
                    });
                    const resolutionEvidence = complete(
                      resolution,
                      `Conflict resolution of #${ready[index]!.id}`,
                    );
                    const status = await wave.exec("git status --porcelain");
                    const pending = await wave.exec(
                      "git rev-parse -q --verify CHERRY_PICK_HEAD",
                    );
                    const after = await wave.exec("git rev-parse HEAD");
                    const integratedCommits = await wave.exec(
                      `git log --format=%B ${before.stdout.trim()}..HEAD`,
                    );
                    if (
                      status.exitCode !== 0 ||
                      status.stdout.trim() ||
                      pending.exitCode === 0 ||
                      after.exitCode !== 0 ||
                      after.stdout.trim() === before.stdout.trim() ||
                      integratedCommits.exitCode !== 0 ||
                      shas.some(
                        (sha) =>
                          !integratedCommits.stdout.includes(
                            `(cherry picked from commit ${sha})`,
                          ),
                      )
                    )
                      throw new Error(
                        "Cherry-pick remains unresolved or ticket commits are missing from the spec branch",
                      );
                    workerEvidence += `\n\n#${ready[index]!.id} conflict: ${resolutionEvidence}`;
                  } catch (error) {
                    throw new TicketFailures([
                      {
                        id: ready[index]!.id,
                        reason: `Cherry-pick conflict: ${error instanceof Error ? error.message : String(error)}`,
                      },
                    ]);
                  }
                }
                workerEvidence += `\n\n#${ready[index]!.id}: ${outcome.value.packet}`;
              }
              const integrated = await wave.run({
                name: "spec-integrator",
                maxIterations: 10,
                agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
                promptFile: "./.shipyard/spec-wave-prompt.md",
                promptArgs: {
                  TASK_ID: id,
                  BRANCH: scope.branch,
                  SCOPE: JSON.stringify(scope),
                  WAVE_BRANCHES: ready
                    .map((ticket) => `shipyard/spec-${id}-issue-${ticket.id}`)
                    .join(","),
                },
              });
              workerEvidence += `\n\n${complete(integrated, `Integration wave of #${id}`)}`;
            } catch (error) {
              try {
                await closeClean(wave);
              } catch (closeError) {
                console.error(
                  `Failed wave cleanup after ${error}: ${closeError}`,
                );
              }
              throw error;
            }
            await closeClean(wave);
            for (const ticket of ready) {
              completed.add(ticket.id);
              remaining.delete(ticket.id);
            }
          }
        }
        const integration = await shipyard.createSandbox({
          branch: scope.branch,
          sandbox: docker(),
          hooks,
        });
        let handoffEvidence: string;
        try {
          if (scope.kind === "standalone") {
            await integration.run({
              name: `triage #${id}`,
              maxIterations: 1,
              agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
              promptFile: "./.shipyard/triage-prompt.md",
              promptArgs: { TASK_ID: id },
            });
            verifyTriage(id);
            const standalone = await integration.run({
              name: "implementer",
              maxIterations: 100,
              agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
              promptFile: "./.shipyard/implement-prompt.md",
              promptArgs: {
                TASK_ID: id,
                ISSUE_TITLE: scope.title,
                BRANCH: scope.branch,
                SCOPE: JSON.stringify(scope),
              },
            });
            workerEvidence = complete(standalone, `Implementation of #${id}`);
          }
          const review = await integration.run({
            name: "reviewer",
            maxIterations: 1,
            agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
            promptFile: "./.shipyard/review-prompt.md",
            promptArgs: {
              TASK_ID: id,
              BRANCH: scope.branch,
              BASE_BRANCH: targetBranch,
              SCOPE: JSON.stringify(scope),
            },
          });
          workerEvidence += `\n\n${approved(review, `Review of #${id}`)}`;
          const final = await integration.run({
            name: "merger",
            maxIterations: 1,
            agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
            promptFile: "./.shipyard/merge-prompt.md",
            promptArgs: {
              TASK_ID: id,
              ISSUE_TITLE: scope.title,
              BRANCH: scope.branch,
              BASE_BRANCH: targetBranch,
              SCOPE: JSON.stringify(scope),
            },
          });
          const finalEvidence = complete(final, `Final integration of #${id}`);
          handoffEvidence = `${workerEvidence}\n\n${finalEvidence}`;
          if (final.commits.length) {
            const finalReview = await integration.run({
              name: "reviewer",
              maxIterations: 1,
              agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
              promptFile: "./.shipyard/review-prompt.md",
              promptArgs: {
                TASK_ID: id,
                BRANCH: scope.branch,
                BASE_BRANCH: targetBranch,
                SCOPE: JSON.stringify(scope),
              },
            });
            handoffEvidence += `\n\n${approved(finalReview, `Final review of #${id}`)}`;
          }
        } finally {
          await closeClean(integration);
        }
        const publication = await shipyard.createSandbox({
          branch: scope.branch,
          sandbox: docker(),
        });
        try {
          const scopeIds = [
            id,
            ...(scope.tickets ?? []).map((ticket) => ticket.id),
          ].join(",");
          publicationUncertain = true;
          const handoff = await publication.exec(
            `bash .shipyard/handoff.sh ${id} ${scope.branch} ${targetBranch} ${repository} ${scopeIds} ${scope.outstandingTicketIds?.join(",") || "-"} ${scope.completedTicketIds?.join(",") || "-"}`,
            { stdin: handoffEvidence },
          );
          publicationUncertain = handoff.exitCode === 75;
          if (handoff.exitCode !== 0)
            throw new Error(
              `PR handoff for #${id} failed: ${handoff.stderr || handoff.stdout}`,
            );
          console.log(handoff.stdout.trim());
          handedOff = true;
        } finally {
          await publication.close();
        }
      } catch (error) {
        if (handedOff || publicationUncertain) throw error;
        if (error instanceof TicketFailures) {
          for (const failure of error.failures)
            blockScope(scope, failure.id, failure.reason);
        } else {
          blockScope(
            scope,
            scope.id,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected")
      throw new Error(`Scope #${ids[index]} failed: ${outcome.reason}`);
  }
}
