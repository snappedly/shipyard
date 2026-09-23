// Parallel Planner — coordinator-owned delivery-group worker
//
// The planner emits delivery groups, not a flat list of branches. A standalone
// group has one worker. A planning-spec group has dependency-safe child waves;
// unrelated groups still run concurrently. Workers return commits only. The
// coordinator owns serial integration, draft-PR publication, exact-candidate
// review, bounded repair, and the human handoff to `staging`.
//
// This file intentionally keeps the low-level worker loop visible so a target
// repository can replace it with a custom adapter. The canonical adapter should
// feed the same groups to `resolveDeliveryGroup` / `deliverSpec`; it must never
// let a child worker publish, merge, or close its source issue.

import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";

const childSchema = z.object({
  id: z.string(),
  title: z.string(),
  dependsOn: z.array(z.string()),
});

const deliveryGroupSchema = z.object({
  id: z.string(),
  repository: z.string(),
  mode: z.enum(["standalone", "planning-spec"]),
  root: z.object({ id: z.string(), title: z.string() }),
  children: z.array(childSchema),
  integrationBranch: z.string(),
});

const planSchema = z.object({
  deliveryGroups: z.array(deliveryGroupSchema),
});

const MAX_ITERATIONS = 10;
const hooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          "npm install && npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
        timeoutMs: 300_000,
      },
    ],
  },
};
const copyToWorktree = ["node_modules"];
const exec = promisify(execFile);
const command = async (file: string, args: string[]) =>
  (await exec(file, args, { encoding: "utf8" })).stdout.trim();
const repository = JSON.parse(
  await command("gh", ["repo", "view", "--json", "nameWithOwner"]),
).nameWithOwner as string;
const baseBranch = process.env.SHIPYARD_BASE_BRANCH ?? "staging";
await command("git", ["fetch", "origin", baseBranch]);
const baseSha = await command("git", ["rev-parse", "FETCH_HEAD"]);

type DeliveryGroup = z.infer<typeof deliveryGroupSchema>;
type Child = z.infer<typeof childSchema>;

const branchFor = (group: DeliveryGroup, child: Child): string =>
  group.mode === "standalone"
    ? `shipyard/issue-${group.root.id}`
    : `shipyard/spec-${group.root.id}-child-${child.id}`;

const canonicalGroup = (group: DeliveryGroup) => {
  if (group.repository !== repository) {
    throw new Error(`Delivery ${group.id} belongs to another repository`);
  }
  const expectedBranch =
    group.mode === "planning-spec"
      ? `shipyard/spec-${group.root.id}`
      : `shipyard/issue-${group.root.id}`;
  if (group.integrationBranch !== expectedBranch) {
    throw new Error(`Delivery ${group.id} has an unstable integration branch`);
  }
  const kind =
    group.mode === "planning-spec" ? "planning-spec" : "executable-issue";
  const delivery = shipyard.resolveDeliveryGroup({
    issue: { repository: group.repository, itemId: group.root.id, kind },
    children:
      group.mode === "planning-spec"
        ? group.children.map((child) => ({
            repository: group.repository,
            itemId: child.id,
            kind: "executable-issue" as const,
          }))
        : undefined,
    dependencies:
      group.mode === "planning-spec"
        ? group.children.map((child) => ({
            itemId: child.id,
            dependsOn: child.dependsOn,
          }))
        : undefined,
  });
  if (delivery.id !== group.id)
    throw new Error(`Delivery ${group.id} has an unstable identity`);
  if (group.mode === "planning-spec") shipyard.planSpecDelivery(delivery);
  return delivery;
};

const hydrateGroup = async (group: DeliveryGroup): Promise<DeliveryGroup> => {
  if (!/^[1-9]\d*$/.test(group.root.id))
    throw new Error(`Delivery ${group.id} has an invalid issue number`);
  const current = await shipyard.readActivatedDeliveryRoot(
    group.repository,
    Number(group.root.id),
  );
  if (current.mode !== group.mode)
    throw new Error(`Delivery ${group.id} has the wrong issue mode`);
  if (group.mode === "standalone") {
    return {
      ...group,
      root: { ...group.root, title: current.title },
      children: [{ id: group.root.id, title: current.title, dependsOn: [] }],
    };
  }
  const graph = await shipyard.readPlanningSpecGraph(
    group.repository,
    Number(group.root.id),
  );
  return { ...group, root: graph.root, children: graph.children };
};

const publishGroup = async (
  group: DeliveryGroup,
  headSha: string,
  retainActivation = false,
) => {
  const briefHash = createHash("sha256")
    .update(JSON.stringify(group))
    .digest("hex");
  const published = await shipyard.publishTemplateDelivery({
    repository: group.repository,
    itemId: group.root.id,
    kind: group.mode === "planning-spec" ? "planning-spec" : "executable-issue",
    branch: group.integrationBranch,
    baseBranch,
    headSha,
    title: `[Shipyard] ${group.root.title}`,
    body: `Source issue: #${group.root.id}\n\nScoped children: ${group.children.map((child) => `#${child.id}`).join(", ")}\n\nIntegration candidate: ${headSha}\n\nRequired checks and independent review must pass before this draft is ready for merge.`,
    metadata: {
      version: 1,
      repository: group.repository,
      itemId: group.root.id,
      kind:
        group.mode === "planning-spec" ? "planning-spec" : "executable-issue",
      briefRevision: 1,
      briefHash,
      baseBranch,
      baseSha,
      branch: group.integrationBranch,
    },
    retainActivation,
  });
  console.log(`Draft PR for ${group.id}: ${published.url}`);
};

const runChild = async (group: DeliveryGroup, child: Child, baseRef: string) =>
  shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: {
      type: "branch",
      branch: branchFor(group, child),
      baseBranch: baseRef,
    },
    name: group.mode === "planning-spec" ? "spec-child" : "implementer",
    maxIterations: 100,
    agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
    promptFile: "./.shipyard/implement-prompt.md",
    promptArgs: {
      TASK_ID: child.id,
      ISSUE_TITLE: child.title,
      BRANCH: branchFor(group, child),
      DELIVERY_ID: group.id,
      INTEGRATION_BRANCH: group.integrationBranch,
    },
  });

const runStandaloneGroup = async (group: DeliveryGroup) => {
  const child = group.children[0];
  if (child === undefined)
    return { group, children: [] as const, published: false };
  const result = await runChild(group, child, baseSha);
  const headSha = result.commits.at(-1)?.sha;
  if (headSha !== undefined && result.completionSignal !== undefined)
    await publishGroup(group, headSha);
  return {
    group,
    children: [{ child, result }],
    published: headSha !== undefined && result.completionSignal !== undefined,
  };
};

const runSpecGroup = async (group: DeliveryGroup) => {
  const completed = new Set<string>();
  const attempted = new Set<string>();
  const results: Array<{
    child: Child;
    result: Awaited<ReturnType<typeof runChild>>;
  }> = [];
  let currentHead = baseSha;
  let published = false;
  while (completed.size < group.children.length) {
    const ready = group.children.filter(
      (child) =>
        !attempted.has(child.id) &&
        child.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) break;
    const settled = await Promise.allSettled(
      ready.map(async (child) => ({
        child,
        result: await runChild(group, child, currentHead),
      })),
    );
    let madeProgress = false;
    for (const [index, outcome] of settled.entries()) {
      attempted.add(ready[index]!.id);
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        if (
          outcome.value.result.commits.length > 0 &&
          outcome.value.result.completionSignal !== undefined
        ) {
          completed.add(outcome.value.child.id);
          madeProgress = true;
        } else {
          console.error(`Child ${outcome.value.child.id} returned no commit`);
        }
      } else {
        console.error(`Child worker failed in ${group.id}: ${outcome.reason}`);
      }
    }
    if (!madeProgress) break;
    const commits = settled.flatMap((outcome) =>
      outcome.status === "fulfilled" && completed.has(outcome.value.child.id)
        ? outcome.value.result.commits.map((commit) => commit.sha)
        : [],
    );
    if (commits.length > 0) {
      const integrated = await shipyard.integrateTemplateDelivery({
        repositoryPath: process.cwd(),
        branch: group.integrationBranch,
        baseBranch,
        commits,
      });
      currentHead = integrated.headSha;
      await publishGroup(group, currentHead, true);
      published = true;
    }
  }
  if (published && completed.size === group.children.length) {
    await publishGroup(group, currentHead);
  }
  return {
    group,
    children: results,
    published: published && completed.size === group.children.length,
  };
};

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  const plan = await shipyard.run({
    hooks,
    sandbox: docker(),
    name: "planner",
    maxIterations: 1,
    agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
    promptFile: "./.shipyard/plan-prompt.md",
    output: shipyard.Output.object({ tag: "plan", schema: planSchema }),
  });

  const groups = plan.output.deliveryGroups;
  if (groups.length === 0) {
    console.log("No delivery groups are ready. Exiting.");
    break;
  }

  const hydrated = await Promise.all(groups.map(hydrateGroup));
  const canonical = hydrated.map((group) => ({
    group,
    delivery: canonicalGroup(group),
  }));
  for (const entry of canonical) {
    console.log(
      `  ${entry.delivery.id}: ${entry.group.mode} → ${entry.group.integrationBranch}`,
    );
  }

  const settled = await Promise.allSettled(
    canonical.map(({ group }) =>
      group.mode === "planning-spec"
        ? runSpecGroup(group)
        : runStandaloneGroup(group),
    ),
  );
  const completed = settled.filter(
    (entry) => entry.status === "fulfilled" && entry.value.published,
  );

  if (completed.length === 0) {
    console.log("No delivery group made progress. Stopping.");
    break;
  }

  console.log(
    "Delivery candidates are published as draft PRs for review and human handoff.",
  );
}

console.log("\nAll done.");
