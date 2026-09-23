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
const reviewSchema = z.object({ findings: z.array(z.string()) });

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
  baseRef: string,
  headSha: string,
  scope: string = `child #${child.id}`,
) => {
  const reviewBranch = `shipyard/review-${group.root.id}-${child.id}-${headSha.slice(0, 12)}`;
  const review = await shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: {
      type: "branch",
      branch: reviewBranch,
      baseBranch: headSha,
    },
    name: "reviewer",
    maxIterations: 1,
    agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
    promptFile: "./.shipyard/review-prompt.md",
    promptArgs: {
      DELIVERY_ID: group.id,
      REVIEW_SCOPE: scope,
      BRANCH: reviewBranch,
      BASE_SHA: baseRef,
      HEAD_SHA: headSha,
    },
    output: shipyard.Output.object({ tag: "review", schema: reviewSchema }),
  });
  if (review.commits.length > 0 || review.completionSignal === undefined)
    throw new Error(`Review did not finish read-only for ${scope}`);
  return review;
};

const runRepair = async (
  group: DeliveryGroup,
  child: Child,
  headSha: string,
  findings: readonly string[],
  scope: string,
) => {
  const repair = await shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: {
      type: "branch",
      branch: `shipyard/repair-${group.root.id}-${child.id}-${headSha.slice(0, 12)}`,
      baseBranch: headSha,
    },
    name: "repair",
    maxIterations: 1,
    agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
    promptFile: "./.shipyard/repair-prompt.md",
    promptArgs: {
      DELIVERY_ID: group.id,
      TASK_ID: child.id,
      REVIEW_SCOPE: scope,
      FINDINGS: findings.map((finding) => `- ${finding}`).join("\n"),
    },
  });
  if (repair.completionSignal === undefined || repair.commits.length === 0)
    throw new Error(`Repair did not complete for ${scope}`);
  return repair;
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
  if (implementation.completionSignal === undefined) {
    return { implementation, review: undefined, commits: [] };
  }
  const headSha = implementation.commits.at(-1)?.sha;
  if (headSha === undefined)
    return { implementation, review: undefined, commits: [] };
  let commits = implementation.commits;
  let review = await runReview(group, child, baseRef, headSha);
  if (review.output.findings.length > 0) {
    const repair = await runRepair(
      group,
      child,
      headSha,
      review.output.findings,
      `child #${child.id}`,
    );
    commits = [...commits, ...repair.commits];
    review = await runReview(
      group,
      child,
      baseRef,
      repair.commits.at(-1)!.sha,
      `follow-up child #${child.id}`,
    );
  }
  if (review.output.findings.length > 0)
    throw new Error(
      `Child #${child.id} has unresolved review findings: ${review.output.findings.join("; ")}`,
    );
  return { implementation, review, commits };
};

const runIntegratedCleanup = async (
  group: DeliveryGroup,
  headSha: string,
): Promise<string> => {
  const cleanup = await shipyard.run({
    hooks,
    copyToWorktree,
    sandbox: docker(),
    branchStrategy: {
      type: "branch",
      branch: group.integrationBranch,
      baseBranch: headSha,
    },
    name: "integrated-cleanup",
    maxIterations: 1,
    agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
    promptFile: "./.shipyard/integrated-cleanup-prompt.md",
    promptArgs: {
      DELIVERY_ID: group.id,
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
    },
  });
  if (cleanup.completionSignal === undefined) {
    throw new Error(`Integrated cleanup did not complete for ${group.id}`);
  }
  return cleanup.commits.at(-1)?.sha ?? headSha;
};

const runStandaloneGroup = async (group: DeliveryGroup) => {
  const child = group.children[0];
  if (child === undefined)
    return { group, children: [] as const, published: false };
  const result = await runChild(group, child, baseSha);
  const headSha = result.commits.at(-1)?.sha;
  if (
    headSha !== undefined &&
    result.implementation.completionSignal !== undefined &&
    result.review !== undefined
  )
    await publishGroup(group, headSha);
  return {
    group,
    children: [{ child, result }],
    published:
      headSha !== undefined &&
      result.implementation.completionSignal !== undefined &&
      result.review !== undefined,
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
          outcome.value.result.implementation.completionSignal !== undefined &&
          outcome.value.result.review !== undefined
        ) {
          completed.add(outcome.value.child.id);
          madeProgress = true;
        } else {
          console.error(
            `Child ${outcome.value.child.id} has no reviewed commit`,
          );
        }
      } else {
        console.error(
          `Child pipeline failed in ${group.id}: ${outcome.reason}`,
        );
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
    const cleanedHead = await runIntegratedCleanup(group, currentHead);
    if (cleanedHead !== currentHead) {
      currentHead = cleanedHead;
      await publishGroup(group, currentHead, true);
    }
    const specRoot = {
      id: group.root.id,
      title: group.root.title,
      dependsOn: [],
    };
    const scope = `integrated planning spec #${group.root.id}`;
    let integratedReview = await runReview(
      group,
      specRoot,
      baseSha,
      currentHead,
      scope,
    );
    if (integratedReview.output.findings.length > 0) {
      const repair = await runRepair(
        group,
        specRoot,
        currentHead,
        integratedReview.output.findings,
        scope,
      );
      const integrated = await shipyard.integrateTemplateDelivery({
        repositoryPath: process.cwd(),
        branch: group.integrationBranch,
        baseBranch,
        commits: repair.commits.map((commit) => commit.sha),
      });
      currentHead = integrated.headSha;
      await publishGroup(group, currentHead, true);
      integratedReview = await runReview(
        group,
        specRoot,
        baseSha,
        currentHead,
        `follow-up ${scope}`,
      );
    }
    if (integratedReview.output.findings.length > 0)
      throw new Error(
        `Planning spec #${group.root.id} has unresolved review findings: ${integratedReview.output.findings.join("; ")}`,
      );
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
