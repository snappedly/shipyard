// Parallel Planner with Review — coordinator-owned delivery-group worker
//
// Planning emits delivery groups. Unrelated groups run concurrently; children
// inside one planning spec run in dependency-safe waves. Implementers return
// commits and reviewers return read-only findings. A coordinator-owned adapter
// is responsible for serial integration, one draft PR per delivery, bounded
// repair, exact-candidate handoff to `staging`, and all issue effects.

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
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};
const copyToWorktree = ["node_modules"];
const exec = promisify(execFile);
const command = async (file: string, args: string[]) =>
  (await exec(file, args, { encoding: "utf8" })).stdout.trim();
const baseBranch = process.env.SHIPYARD_BASE_BRANCH ?? "staging";
await command("git", ["fetch", "origin", baseBranch]);
const baseSha = await command("git", ["rev-parse", "FETCH_HEAD"]);

type DeliveryGroup = z.infer<typeof deliveryGroupSchema>;
type Child = z.infer<typeof childSchema>;

const branchFor = (group: DeliveryGroup, child: Child): string =>
  group.mode === "standalone"
    ? `shipyard/issue-${group.root.id}`
    : `shipyard/spec-${group.root.id}/child-${child.id}`;

const canonicalGroup = (group: DeliveryGroup) => {
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
    body: `Source issue: #${group.root.id}\n\nScoped children: ${group.children.map((child) => `#${child.id}`).join(", ")}\n\nIntegration candidate: ${headSha}\n\nRead-only review ran; required checks and findings must be resolved before this draft is ready for merge.`,
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

const runReview = async (
  group: DeliveryGroup,
  child: Child,
  branch: string,
) => {
  const reviewBranch = `shipyard/review/${group.id}/${child.id}`;
  const reviewSandbox = await shipyard.createSandbox({
    branch: reviewBranch,
    baseBranch: branch,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });
  try {
    return await reviewSandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
      promptFile: "./.shipyard/review-prompt.md",
      promptArgs: {
        TASK_ID: child.id,
        DELIVERY_ID: group.id,
        BRANCH: reviewBranch,
        TARGET_BRANCH: branch,
      },
    });
  } finally {
    await reviewSandbox.close();
  }
};

const runChild = async (
  group: DeliveryGroup,
  child: Child,
  baseRef: string,
) => {
  const branch = branchFor(group, child);
  const implementation = await shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: { type: "branch", branch, baseBranch: baseRef },
    name: "implementer",
    maxIterations: 100,
    agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
    promptFile: "./.shipyard/implement-prompt.md",
    promptArgs: {
      TASK_ID: child.id,
      ISSUE_TITLE: child.title,
      BRANCH: branch,
      DELIVERY_ID: group.id,
      INTEGRATION_BRANCH: group.integrationBranch,
    },
  });
  if (
    implementation.commits.length === 0 &&
    implementation.completionSignal === undefined
  ) {
    return { implementation, review: undefined };
  }
  const review = await runReview(group, child, branch);
  if (review.commits.length > 0) {
    throw new Error(
      `Reviewer changed child ${child.id}; candidate was not published`,
    );
  }
  return { implementation, review };
};

const runStandaloneGroup = async (group: DeliveryGroup) => {
  const child = group.children[0];
  if (child === undefined)
    return { group, children: [] as const, published: false };
  const result = await runChild(group, child, baseSha);
  const headSha = result.implementation.commits.at(-1)?.sha;
  if (headSha !== undefined) await publishGroup(group, headSha);
  return {
    group,
    children: [{ child, result }],
    published: headSha !== undefined,
  };
};

const runSpecGroup = async (group: DeliveryGroup) => {
  const completed = new Set<string>();
  const results: Array<{
    child: Child;
    result: Awaited<ReturnType<typeof runChild>>;
  }> = [];
  let currentHead = baseSha;
  let published = false;
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
        result: await runChild(group, child, currentHead),
      })),
    );
    let madeProgress = false;
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        results.push(outcome.value);
        completed.add(outcome.value.child.id);
        madeProgress = true;
      } else {
        console.error(
          `Child pipeline failed in ${group.id}: ${outcome.reason}`,
        );
      }
    }
    if (!madeProgress) break;
    const commits = settled.flatMap((outcome) =>
      outcome.status === "fulfilled"
        ? outcome.value.result.implementation.commits.map(
            (commit) => commit.sha,
          )
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
  return { group, children: results, published };
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
