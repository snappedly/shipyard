// Plan activated scopes, implement independent tickets in parallel, then
// integrate each scope on one branch for human review.
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
};
const evidence = (stdout: string): string | undefined =>
  [...stdout.matchAll(/<handoff>([\s\S]*?)<\/handoff>/g)].at(-1)?.[1]?.trim();
const complete = (
  result: { stdout: string; completionSignal?: string | null },
  stage: string,
) => {
  const packet = evidence(result.stdout);
  if (!result.completionSignal || !packet)
    throw new Error(`${stage} lacks verified completion evidence`);
  return packet;
};
const approved = (
  result: { stdout: string; completionSignal?: string | null },
  stage: string,
) => {
  if (!result.stdout.includes("<review>APPROVED</review>"))
    throw new Error(`${stage} has unresolved review findings`);
  return complete(result, stage);
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
    const implementation = await sandbox.run({
      name: "implementer",
      maxIterations: 100,
      agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
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
      agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
      promptFile: "./.shipyard/review-prompt.md",
      promptArgs: {
        TASK_ID: ticket.id,
        BRANCH: branch,
        TARGET_BRANCH: scope.branch,
        SCOPE: JSON.stringify(scope),
      },
    });
    packet += `\n\n${approved(review, `Review of #${ticket.id}`)}`;
    return { branch, packet };
  } finally {
    await sandbox.close();
  }
};

for (let iteration = 0; iteration < 10; iteration++) {
  const scopes = JSON.parse(
    execFileSync("node", [".shipyard/select-issues.mjs"], { encoding: "utf8" }),
  ) as Scope[];
  if (!scopes.length) break;
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
      if (
        scope.branch !==
        (scope.kind === "spec" ? `shipyard/spec-${id}` : `shipyard/issue-${id}`)
      )
        throw new Error(`Invalid branch for #${id}`);
      let workerEvidence = "";
      if (scope.kind === "spec") {
        const seed = await shipyard.createSandbox({
          branch: scope.branch,
          sandbox: docker(),
          hooks,
        });
        await seed.close();
        const tickets = scope.tickets ?? [];
        if (!tickets.length)
          throw new Error(`Spec #${id} has no executable tickets`);
        const remaining = new Map(tickets.map((ticket) => [ticket.id, ticket]));
        const completed = new Set<string>();
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
          for (const [index, outcome] of settled.entries()) {
            if (outcome.status === "rejected")
              throw new Error(
                `Ticket #${ready[index]!.id} failed: ${outcome.reason}`,
              );
          }
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
                throw new Error(
                  `Ticket #${ready[index]!.id} has no committed changes to integrate`,
                );
              const shas = commits.stdout.trim().split(/\s+/);
              if (!shas.every((sha) => /^[a-f0-9]{40}$/.test(sha)))
                throw new Error(
                  `Invalid commit in ticket #${ready[index]!.id}`,
                );
              const picked = await wave.exec(
                `git -c user.name=Shipyard -c user.email=shipyard@users.noreply.github.com cherry-pick ${shas.join(" ")}`,
              );
              if (picked.exitCode !== 0)
                throw new Error(
                  `Cherry-pick of #${ready[index]!.id} failed: ${picked.stderr || picked.stdout}`,
                );
              workerEvidence += `\n\n#${ready[index]!.id}: ${outcome.value.packet}`;
            }
            const integrated = await wave.run({
              name: "spec-integrator",
              maxIterations: 10,
              agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
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
          } finally {
            await wave.close();
          }
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
      try {
        if (scope.kind === "standalone") {
          const standalone = await integration.run({
            name: "implementer",
            maxIterations: 100,
            agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
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
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          promptFile: "./.shipyard/review-prompt.md",
          promptArgs: {
            TASK_ID: id,
            BRANCH: scope.branch,
            TARGET_BRANCH: targetBranch,
            SCOPE: JSON.stringify(scope),
          },
        });
        workerEvidence += `\n\n${approved(review, `Review of #${id}`)}`;
        const final = await integration.run({
          name: "merger",
          maxIterations: 1,
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          promptFile: "./.shipyard/merge-prompt.md",
          promptArgs: {
            TASK_ID: id,
            ISSUE_TITLE: scope.title,
            BRANCH: scope.branch,
            TARGET_BRANCH: targetBranch,
            SCOPE: JSON.stringify(scope),
          },
        });
        const finalEvidence = complete(final, `Final integration of #${id}`);
        const scopeIds = [
          id,
          ...(scope.tickets ?? []).map((ticket) => ticket.id),
        ].join(",");
        const handoff = await integration.exec(
          `bash .shipyard/handoff.sh ${id} ${scope.branch} ${targetBranch} ${repository} ${scopeIds}`,
          { stdin: `${workerEvidence}\n\n${finalEvidence}` },
        );
        if (handoff.exitCode !== 0)
          throw new Error(
            `PR handoff for #${id} failed: ${handoff.stderr || handoff.stdout}`,
          );
        console.log(handoff.stdout.trim());
      } finally {
        await integration.close();
      }
    }),
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected")
      throw new Error(`Scope #${ids[index]} failed: ${outcome.reason}`);
  }
}
