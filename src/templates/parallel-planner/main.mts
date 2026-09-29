// Plan activated scopes, implement independent tickets in parallel, then
// integrate each scope on one branch for human review.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as shipyard from "@snappedly-tools/shipyard-v1";
import { docker } from "@snappedly-tools/shipyard-v1/sandboxes/docker";
import { z } from "zod";
import {
  fastForwardPlannerBranch,
  resolvePlannerBranch,
} from "./planner-branch.mjs";

if (process.loadEnvFile && existsSync(".shipyard-v1/.env"))
  process.loadEnvFile(".shipyard-v1/.env");
type ModelRole = "routine" | "strong";
const CODEX_PROVIDER = true;
const agentFactory = shipyard.codex;
type AgentModel = Parameters<typeof agentFactory>[0];
const readRoleModel = (role: ModelRole): string | undefined => {
  const envName = `SHIPYARD_V1_${role.toUpperCase()}_MODEL`;
  const model = process.env[envName];
  if (model !== undefined && model.trim().length === 0)
    throw new Error(`${envName} must not be empty`);
  return model;
};
const roleModels = {
  routine: readRoleModel("routine"),
  strong: readRoleModel("strong"),
};
const REASONING_EFFORTS = shipyard.REASONING_EFFORTS;
type ReasoningEffort = shipyard.ReasoningEffort;
const readRoleReasoningEffort = (
  role: ModelRole,
): ReasoningEffort | undefined => {
  const envName = `SHIPYARD_V1_${role.toUpperCase()}_REASONING_EFFORT`;
  const legacyName = `SHIPYARD_V1_CODEX_${role.toUpperCase()}_REASONING_EFFORT`;
  const sharedEffort = process.env[envName]?.trim();
  const effort =
    sharedEffort ||
    (CODEX_PROVIDER ? process.env[legacyName]?.trim() : undefined);
  if (!effort) return undefined;
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort))
    throw new Error(
      `${sharedEffort ? envName : legacyName} must be one of ${REASONING_EFFORTS.join(", ")}; received "${effort}"`,
    );
  return effort as ReasoningEffort;
};
const roleEfforts = {
  routine: readRoleReasoningEffort("routine"),
  strong: readRoleReasoningEffort("strong"),
};
const readCodexRoleModel = (role: ModelRole, defaultModel: AgentModel) => {
  if (!CODEX_PROVIDER || typeof defaultModel === "string") return defaultModel;
  const envName = `SHIPYARD_V1_CODEX_${role.toUpperCase()}_MODEL`;
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
const sandboxAuthOptions = {};
const sandboxProvider = docker({
  env: { GH_REPO: repository },
  ...sandboxAuthOptions,
});
const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "timeout 300 bash .shipyard-v1/setup.sh", timeoutMs: 300_000 },
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
const verifyTriage = (ticketId: string, triageOutput?: string) => {
  try {
    execFileSync(
      "bash",
      [".shipyard-v1/verify-triage.sh", ticketId, repository],
      {
        encoding: "utf8",
      },
    );
  } catch (error) {
    const detail = (error as { stderr?: string | Buffer }).stderr
      ?.toString()
      .trim();
    const reason = detail || `Could not verify triage for #${ticketId}`;
    const output = triageOutput?.trim();
    throw new Error(
      output ? `${reason}; triage output: ${output.slice(-1200)}` : reason,
    );
  }
};
const verifyTriageAccess = async (
  sandbox: {
    exec: (
      command: string,
    ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  },
  ticketId: string,
) => {
  if (!/^\d+$/.test(ticketId))
    throw new Error(`Invalid issue number: ${ticketId}`);
  const result = await sandbox.exec(
    `gh issue view ${ticketId} --repo ${repository} --json number --jq .number`,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `Cannot triage issue #${ticketId}: GitHub access failed in the sandbox: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`}`,
    );
};
const planSchema = z.object({ issues: z.array(z.object({ id: z.string() })) });
type Ticket = {
  id: string;
  title: string;
  body: string;
  state: string;
  blockedBy: Array<{ id: string; title: string; state: string }>;
  triageReady: boolean;
};
type Scope = {
  id: string;
  title: string;
  branch: string;
  kind: "standalone" | "spec";
  triageReady?: boolean;
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
      ".shipyard-v1/block-scope.sh",
      scope.id,
      failedId,
      repository,
      [scope.id, ...(scope.tickets ?? []).map((ticket) => ticket.id)].join(","),
      scope.branch,
    ],
    { input: reason, encoding: "utf8" },
  );
  console.error(`Shipyard V1 blocked issue #${failedId}: ${reason}`);
};
const runWorker = async (scope: Scope, ticket: Ticket) => {
  const branch = `shipyard-v1/spec-${scope.id}-issue-${ticket.id}`;
  const sandbox = await shipyard.createSandbox({
    branch,
    baseBranch: scope.branch,
    sandbox: sandboxProvider,
    hooks,
    copyToWorktree: [".shipyard-v1/setup.sh"],
  });
  try {
    let triageOutput: string | undefined;
    if (!ticket.triageReady) {
      await verifyTriageAccess(sandbox, ticket.id);
      const triage = await sandbox.run({
        name: `triage #${ticket.id}`,
        maxIterations: 1,
        agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
        promptFile: "./.shipyard-v1/triage-prompt.md",
        promptArgs: { TASK_ID: ticket.id, BASE_BRANCH: targetBranch },
      });
      triageOutput = triage.stdout;
    }
    verifyTriage(ticket.id, triageOutput);
    const implementation = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
      promptFile: "./.shipyard-v1/implement-prompt.md",
      promptArgs: {
        TASK_ID: ticket.id,
        ISSUE_TITLE: ticket.title,
        BRANCH: branch,
        SCOPE: JSON.stringify(scope),
      },
    });
    const packet = complete(implementation, `Implementation of #${ticket.id}`);
    return { branch, packet };
  } finally {
    await closeClean(sandbox);
  }
};

for (let iteration = 0; iteration < 10; iteration++) {
  const scopes = JSON.parse(
    execFileSync("node", [".shipyard-v1/select-issues.mjs"], {
      encoding: "utf8",
    }),
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
  fastForwardPlannerBranch(plannerBranch, targetBranch);
  const plan = await shipyard.run({
    hooks,
    sandbox: sandboxProvider,
    copyToWorktree: [".shipyard-v1/setup.sh"],
    name: "planner",
    branchStrategy: { type: "branch", branch: plannerBranch },
    maxIterations: 1,
    agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
    promptFile: "./.shipyard-v1/plan-prompt.md",
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
          "shipyard-v1:pending",
          "--repo",
          repository,
          "--color",
          "1D76DB",
          "--description",
          "Shipyard V1 is working on this ticket",
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
            "shipyard-v1:pending",
            "--remove-label",
            "shipyard-v1",
          ]);
        if (
          scope.branch !==
          (scope.kind === "spec"
            ? `shipyard-v1/spec-${id}`
            : `shipyard-v1/issue-${id}`)
        )
          throw new Error(`Invalid branch for #${id}`);
        let workerEvidence = "";
        if (scope.kind === "spec") {
          const seed = await shipyard.createSandbox({
            branch: scope.branch,
            sandbox: sandboxProvider,
            hooks,
            copyToWorktree: [".shipyard-v1/setup.sh"],
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
              sandbox: sandboxProvider,
              hooks,
              copyToWorktree: [".shipyard-v1/setup.sh"],
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
                  `git -c user.name=Shipyard V1 -c user.email=shipyard-v1@users.noreply.github.com cherry-pick -x ${shas.join(" ")}`,
                );
                if (picked.exitCode !== 0) {
                  try {
                    const resolution = await wave.run({
                      name: "conflict-resolver",
                      maxIterations: 10,
                      agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
                      promptFile: "./.shipyard-v1/conflict-prompt.md",
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
                promptFile: "./.shipyard-v1/spec-wave-prompt.md",
                promptArgs: {
                  TASK_ID: id,
                  BRANCH: scope.branch,
                  SCOPE: JSON.stringify(scope),
                  WAVE_BRANCHES: ready
                    .map(
                      (ticket) => `shipyard-v1/spec-${id}-issue-${ticket.id}`,
                    )
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
          sandbox: sandboxProvider,
          hooks,
          copyToWorktree: [".shipyard-v1/setup.sh"],
        });
        let handoffEvidence: string;
        try {
          if (scope.kind === "standalone") {
            let triageOutput: string | undefined;
            if (!scope.triageReady) {
              await verifyTriageAccess(integration, id);
              const triage = await integration.run({
                name: `triage #${id}`,
                maxIterations: 1,
                agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
                promptFile: "./.shipyard-v1/triage-prompt.md",
                promptArgs: { TASK_ID: id, BASE_BRANCH: targetBranch },
              });
              triageOutput = triage.stdout;
            }
            verifyTriage(id, triageOutput);
            const standalone = await integration.run({
              name: "implementer",
              maxIterations: 100,
              agent: roleAgent("routine", shipyard.CODEX_MODELS.routine),
              promptFile: "./.shipyard-v1/implement-prompt.md",
              promptArgs: {
                TASK_ID: id,
                ISSUE_TITLE: scope.title,
                BRANCH: scope.branch,
                SCOPE: JSON.stringify(scope),
              },
            });
            workerEvidence = complete(standalone, `Implementation of #${id}`);
          }
          const final = await integration.run({
            name: "merger",
            maxIterations: 1,
            agent: roleAgent("strong", shipyard.CODEX_MODELS.strong),
            promptFile: "./.shipyard-v1/merge-prompt.md",
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
        } finally {
          await closeClean(integration);
        }
        const publication = await shipyard.createSandbox({
          branch: scope.branch,
          sandbox: sandboxProvider,
          copyToWorktree: [".shipyard-v1/handoff.sh"],
        });
        try {
          const scopeIds = [
            id,
            ...(scope.tickets ?? []).map((ticket) => ticket.id),
          ].join(",");
          publicationUncertain = true;
          const handoff = await publication.exec(
            `bash .shipyard-v1/handoff.sh ${id} ${scope.branch} ${targetBranch} ${repository} ${scopeIds} ${scope.outstandingTicketIds?.join(",") || "-"} ${scope.completedTicketIds?.join(",") || "-"}`,
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
