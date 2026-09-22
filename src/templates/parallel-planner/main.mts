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
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};
const copyToWorktree = ["node_modules"];

type DeliveryGroup = z.infer<typeof deliveryGroupSchema>;
type Child = z.infer<typeof childSchema>;

const branchFor = (group: DeliveryGroup, child: Child): string =>
  group.mode === "standalone"
    ? `shipyard/issue-${group.root.id}`
    : `shipyard/spec-${group.root.id}/child-${child.id}`;

const canonicalGroup = (group: DeliveryGroup) => {
  const kind =
    group.mode === "planning-spec" ? "planning-spec" : "executable-issue";
  const delivery = shipyard.resolveDeliveryGroup({
    issue: { repository: group.repository, itemId: group.root.id, kind },
    children: group.children.map((child) => ({
      repository: group.repository,
      itemId: child.id,
      kind: "executable-issue" as const,
    })),
    dependencies: group.children.map((child) => ({
      itemId: child.id,
      dependsOn: child.dependsOn,
    })),
  });
  if (group.mode === "planning-spec") shipyard.planSpecDelivery(delivery);
  return delivery;
};

const runChild = async (group: DeliveryGroup, child: Child) =>
  shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "branch", branch: branchFor(group, child) },
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
  if (child === undefined) return { group, children: [] as const };
  return {
    group,
    children: [{ child, result: await runChild(group, child) }],
  };
};

const runSpecGroup = async (group: DeliveryGroup) => {
  const completed = new Set<string>();
  const results: Array<{
    child: Child;
    result: Awaited<ReturnType<typeof runChild>>;
  }> = [];
  while (completed.size < group.children.length) {
    const ready = group.children.filter(
      (child) =>
        !completed.has(child.id) &&
        child.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) {
      throw new Error(
        `Delivery group ${group.id} has no dependency-safe child`,
      );
    }
    const settled = await Promise.allSettled(
      ready.map(async (child) => ({
        child,
        result: await runChild(group, child),
      })),
    );
    let madeProgress = false;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        completed.add(outcome.value.child.id);
        madeProgress = true;
      } else {
        console.error(`Child worker failed in ${group.id}: ${outcome.reason}`);
      }
    }
    if (!madeProgress) break;
  }
  return { group, children: results };
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

  const canonical = groups.map((group) => ({
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
    (entry) =>
      entry.status === "fulfilled" &&
      entry.value.children.some(
        (child) =>
          child.result.commits.length > 0 ||
          child.result.completionSignal !== undefined,
      ),
  );

  if (completed.length === 0) {
    console.log("No delivery group made progress. Stopping.");
    break;
  }

  console.log(
    "Workers completed. A coordinator-owned integration adapter must now " +
      "publish one draft PR per delivery, review the exact candidate, and " +
      "stop at human handoff; this template never merges or closes issues.",
  );
}

console.log("\nAll done.");
