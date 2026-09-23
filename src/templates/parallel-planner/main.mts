// Parallel Planner — coordinator-owned delivery-group worker
//
// The planner emits delivery groups, not a flat list of branches. A standalone
// group has one worker. A planning-spec group has dependency-safe child waves;
// unrelated groups still run concurrently. Workers return commits only. The
// coordinator owns serial integration, draft-PR publication, exact-candidate
// review, bounded repair, and the human handoff to `staging`.
//
// The planner chooses groups. The host hydrates current issue state and routes
// each group through the canonical standalone or spec delivery coordinator.

import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  canonicalizeActivatedGroup,
  deliverPlannedGroups,
  findActivatedDeliveryRoute,
} from "./deliver-groups.js";

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
  activationIssueId: z.string().optional(),
});

const planSchema = z.object({
  deliveryGroups: z.array(deliveryGroupSchema),
});
const phaseReportSchema = z.object({
  outcome: z.enum(["completed", "needs-info"]).optional(),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      status: z.enum(["passed", "failed", "incomplete", "blocked", "unknown"]),
      summary: z.string().min(1),
    }),
  ),
  questions: z.array(z.string()).optional(),
});
const reviewSchema = z.object({
  outcome: z.enum([
    "passed",
    "actionable-findings",
    "incomplete",
    "blocked",
    "failed",
  ]),
  axes: z.array(z.enum(["standards", "spec", "interface"])),
  findings: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      axis: z.enum(["standards", "spec", "interface"]),
      title: z.string().min(1),
      evidence: z.string().min(1),
      location: z.string().optional(),
      requirement: z.string().optional(),
      verification: z.string().optional(),
    }),
  ),
  evidence: z.array(z.string()),
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
const cwd = process.cwd();
const hostEnv = { ...process.env, ...(await shipyard.loadShipyardEnv(cwd)) };
const hostCommand = async (file: string, args: readonly string[]) =>
  (
    await exec(file, [...args], {
      encoding: "utf8",
      env: hostEnv,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const repository =
  hostEnv.GH_REPO ??
  JSON.parse(
    await hostCommand("gh", ["repo", "view", "--json", "nameWithOwner"]),
  ).nameWithOwner;
if (
  typeof repository !== "string" ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
) {
  throw new Error(
    "Set GH_REPO to owner/repository or run inside a GitHub checkout",
  );
}
const baseBranch = hostEnv.SHIPYARD_BASE_BRANCH?.trim() || "staging";
const modelEnvAllowlist = ["__WORKER_ENV_ALLOWLIST__"] as const;
const configuredChecks = z
  .array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      required: z.boolean(),
    }),
  )
  .min(1)
  .parse(
    JSON.parse(
      hostEnv.SHIPYARD_CHECKS ??
        '[{"name":"tests","command":"npm test","required":true}]',
    ),
  );
if (!configuredChecks.some((check) => check.required)) {
  throw new Error("SHIPYARD_CHECKS must include at least one required check");
}
const transport = shipyard.createGitHubCliTransport({ run: hostCommand });
const relationships = shipyard.createGitHubCliRelationshipReader({
  run: hostCommand,
});
const coordinatorRuntime = await shipyard.openPostgresCoordinator({
  databaseUrl: hostEnv.SHIPYARD_DATABASE_URL ?? "",
});
const coordinator = coordinatorRuntime.coordinator;
const trackingStore = new shipyard.InMemoryGitHubStore();
const publication = new shipyard.GitHubPublication({
  coordinator,
  transport,
  trackingStore,
});
const currentBase = async (): Promise<shipyard.RevisionReference> => {
  const output = await hostCommand("git", [
    "ls-remote",
    "origin",
    `refs/heads/${baseBranch}`,
  ]);
  const sha = output.split(/\s+/)[0];
  if (sha === undefined || !/^[a-f0-9]{40,64}$/i.test(sha)) {
    throw new Error(`Could not read the current origin/${baseBranch} head`);
  }
  return { branch: baseBranch, sha };
};

type DeliveryGroup = z.infer<typeof deliveryGroupSchema>;

const resolveGroupDelivery = (group: DeliveryGroup) => {
  const kind =
    group.mode === "planning-spec" ? "planning-spec" : "executable-issue";
  return shipyard.resolveDeliveryGroup({
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
};

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
  const delivery = resolveGroupDelivery(group);
  if (delivery.id !== group.id)
    throw new Error(`Delivery ${group.id} has an unstable identity`);
  if (group.mode === "planning-spec") shipyard.planSpecDelivery(delivery);
  return delivery;
};

const hydrateGroup = async (group: DeliveryGroup): Promise<DeliveryGroup> => {
  if (!/^[1-9]\d*$/.test(group.root.id))
    throw new Error(`Delivery ${group.id} has an invalid issue number`);
  const current = await findActivatedDeliveryRoute(
    group,
    async (issueNumber) => {
      try {
        return await shipyard.readActivatedDeliveryGroup(
          group.repository,
          issueNumber,
          relationships,
        );
      } catch (error) {
        if (
          error instanceof shipyard.GitHubDeliveryRouteError &&
          error.message === `Delivery #${issueNumber} is no longer activated`
        ) {
          return undefined;
        }
        throw error;
      }
    },
  );
  if (current === undefined) {
    throw new Error(
      `Delivery ${group.id} has no activated root or child issue`,
    );
  }
  return canonicalizeActivatedGroup(
    group,
    current,
    (hydrated) => resolveGroupDelivery(hydrated).id,
  );
};

const policy = shipyard.createRepositoryPolicy({
  repository,
  revision: "parallel-planner-v1",
  baseBranch,
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["policy"],
    autoStartRisk: ["low", "medium"],
  },
  worker: {
    provider: "__WORKER_PROVIDER__",
    model: "__WORKER_MODEL__",
    sandbox: "isolated-docker",
    skillRevision: "bundled-skills",
  },
  checks: configuredChecks,
  phaseBudgets: {
    triage: { maxAttempts: 1, timeoutSeconds: 60 },
    implementation: { maxAttempts: 1, timeoutSeconds: 1800 },
    checking: { maxAttempts: 1, timeoutSeconds: 900 },
    review: { maxAttempts: 1, timeoutSeconds: 900 },
    repair: { maxAttempts: 1, timeoutSeconds: 1800 },
    handoff: { maxAttempts: 1, timeoutSeconds: 300 },
    merge: { maxAttempts: 1, timeoutSeconds: 600 },
    "release-verification": { maxAttempts: 1, timeoutSeconds: 900 },
  },
  repairBudget: { maxBatches: 0, maxFollowUps: 0 },
});

const createBrief = (input: {
  issue: shipyard.GitHubIssueSnapshot;
  kind: "executable-issue" | "planning-spec";
  base: shipyard.RevisionReference;
  revision: number;
  problem?: string;
  acceptanceCriteria?: readonly string[];
}): shipyard.WorkBrief =>
  shipyard.createWorkBrief({
    id: `${repository}:${input.kind}:${input.issue.number}`,
    revision: input.revision,
    identity: {
      repository,
      itemId: String(input.issue.number),
      kind: input.kind,
    },
    source: {
      provider: "github",
      repository,
      itemId: String(input.issue.number),
      url: input.issue.htmlUrl,
      originalBody: input.issue.body || "(empty issue body)",
      author: input.issue.authorLogin,
    },
    problem:
      input.problem ??
      `${input.issue.title}\n\n${input.issue.body || "(empty issue body)"}`,
    evidence: ["Issue is open and carries the shipyard activation label."],
    acceptanceCriteria: input.acceptanceCriteria ?? [
      `Implement the request in issue #${input.issue.number} and verify it with the configured checks.`,
    ],
    exclusions: ["Workers must not publish, merge, or close source issues."],
    risk: "medium",
    verification: {
      checks: configuredChecks
        .filter((check) => check.required)
        .map((check) => check.command),
      artifacts: ["commit", "focused check output", "review evidence"],
    },
    unresolvedQuestions: [],
    authorization: {
      status: "approved",
      actor: "shipyard activation policy",
      actorRole: "policy",
      approvedAt: "1970-01-01T00:00:00.000Z",
    },
    base: input.base,
    policyRevision: policy.revision,
    skillRevision: policy.worker.skillRevision,
    createdAt: input.issue.updatedAt,
  });

const assertActivated = async (
  group: DeliveryGroup,
): Promise<shipyard.GitHubIssueSnapshot> => {
  const route = await shipyard.readActivatedDeliveryGroup(
    repository,
    Number(group.activationIssueId ?? group.root.id),
    relationships,
  );
  if (
    route.mode !== group.mode ||
    route.root.number !== Number(group.root.id)
  ) {
    throw new Error(
      `Activated issue no longer resolves to delivery ${group.id}`,
    );
  }
  return route.root;
};

const candidateChecks = async (
  candidate: Pick<shipyard.HandoffCandidate, "base" | "head" | "briefHash">,
  signal?: AbortSignal,
): Promise<shipyard.CheckEvidence[]> => {
  const sandbox = await shipyard.createSandbox({
    branch: `shipyard/check-${candidate.head.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    baseBranch: candidate.head.sha,
    sandbox: docker(),
    cwd,
    copyToWorktree,
    envAllowlist: [],
  });
  try {
    const evidence: shipyard.CheckEvidence[] = [];
    for (const check of configuredChecks) {
      const startedAt = new Date().toISOString();
      const controller = new AbortController();
      const relayAbort = () => controller.abort(signal?.reason);
      if (signal?.aborted) relayAbort();
      else signal?.addEventListener("abort", relayAbort, { once: true });
      const timer = setTimeout(
        () => controller.abort("check timed out"),
        900_000,
      );
      try {
        const result = await sandbox.exec(check.command, {
          signal: controller.signal,
          maxOutputBytes: 4 * 1024 * 1024,
        });
        evidence.push({
          name: check.name,
          command: check.command,
          status: result.exitCode === 0 ? "passed" : "failed",
          summary:
            `${result.stdout}\n${result.stderr}`.trim().slice(-2000) ||
            (result.exitCode === 0 ? "Check passed." : "Check failed."),
          exitCode: result.exitCode,
          baseSha: candidate.base.sha,
          headSha: candidate.head.sha,
          briefHash: candidate.briefHash,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", relayAbort);
      }
    }
    return evidence;
  } finally {
    await sandbox.close();
  }
};

const cleanupCandidate = async (
  candidate: Pick<shipyard.HandoffCandidate, "head">,
): Promise<boolean> => {
  const sandbox = await shipyard.createSandbox({
    branch: `shipyard/cleanup-${candidate.head.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
    baseBranch: candidate.head.sha,
    sandbox: docker(),
    cwd,
    copyToWorktree,
    envAllowlist: [],
  });
  try {
    const result = await sandbox.exec("git diff --check", {
      maxOutputBytes: 1024 * 1024,
    });
    return result.exitCode === 0;
  } finally {
    await sandbox.close();
  }
};

const reviewCandidate = async (input: {
  readonly scope: string;
  readonly base: shipyard.RevisionReference;
  readonly head: shipyard.RevisionReference;
  readonly brief: shipyard.WorkBrief;
  readonly requiredAxes?: readonly ("standards" | "spec" | "interface")[];
}): Promise<z.infer<typeof reviewSchema>> => {
  const reviewed = await shipyard.run({
    name: "reviewer",
    agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
    sandbox: docker(),
    cwd,
    hooks,
    copyToWorktree,
    prompt: [
      `Review ${input.scope} in ${repository}.`,
      `Inspect exactly base ${input.base.sha} and head ${input.head.sha}.`,
      `Request:\n${input.brief.problem}`,
      `Acceptance criteria:\n${input.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
      "Use the exact diff. Do not edit files, create commits, or run GitHub commands.",
      `Return required axes ${input.requiredAxes?.join(", ") ?? "standards, spec"}, findings, and evidence as JSON.`,
    ].join("\n\n"),
    output: shipyard.Output.object({
      tag: "review-report",
      schema: reviewSchema,
    }),
    completionSignal: "<promise>COMPLETE</promise>",
    maxIterations: 1,
    envAllowlist: modelEnvAllowlist,
    branchStrategy: {
      type: "branch",
      branch: `shipyard/review-${input.head.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      baseBranch: input.head.sha,
    },
  });
  if (
    reviewed.completionSignal === undefined ||
    reviewed.commits.length > 0 ||
    reviewed.preservedWorktreePath !== undefined
  ) {
    throw new Error("Independent review did not complete read-only");
  }
  return reviewed.output;
};

const assertStandaloneIssue = async (
  group: DeliveryGroup,
  expectedProblem: string,
): Promise<void> => {
  const issue = await assertActivated(group);
  const problem = `${issue.title}\n\n${issue.body || "(empty issue body)"}`;
  if (problem !== expectedProblem) {
    throw new Error(`Issue #${group.root.id} changed during delivery`);
  }
};

const pullRequestsFor = async (branch: string) =>
  JSON.parse(
    await hostCommand("gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      "number,state,isDraft,headRefOid,baseRefName,headRefName,body,labels,url",
    ]),
  ) as Array<{
    number: number;
    state: string;
    isDraft: boolean;
    headRefOid: string;
    baseRefName: string;
    headRefName: string;
    body: string;
    labels: Array<{ name: string }>;
    url: string;
  }>;

const readStandaloneCurrent = async (input: {
  group: DeliveryGroup;
  brief: shipyard.WorkBrief;
  branch: string;
}): Promise<shipyard.HandoffCandidate> => {
  await assertStandaloneIssue(input.group, input.brief.problem);
  const base = await currentBase();
  const branch = await transport.findBranchByName({
    repository,
    branch: input.branch,
  });
  const pullRequests = await pullRequestsFor(input.branch);
  if (branch === undefined) {
    if (pullRequests.length > 0) {
      throw new Error("A pull request exists without its remote issue branch");
    }
    return {
      base,
      head: { branch: input.branch, sha: base.sha },
      briefHash: input.brief.hash,
    };
  }
  if (
    pullRequests.length !== 1 ||
    pullRequests[0]?.state !== "OPEN" ||
    pullRequests[0].headRefOid !== branch.headSha ||
    pullRequests[0].baseRefName !== baseBranch ||
    pullRequests[0].headRefName !== input.branch
  ) {
    throw new Error("Remote issue branch has no matching open pull request");
  }
  return {
    base,
    head: { branch: input.branch, sha: branch.headSha },
    briefHash: input.brief.hash,
  };
};

const createStandaloneExecution = async (input: {
  issue: shipyard.GitHubIssueSnapshot;
  brief: shipyard.WorkBrief;
  branch: string;
}) => {
  const workerPrompt = (
    await readFile("./.shipyard/implement-prompt.md", "utf8")
  )
    .replaceAll("{{TASK_ID}}", String(input.issue.number))
    .replaceAll("{{ISSUE_TITLE}}", input.issue.title)
    .replaceAll("{{BRANCH}}", input.branch);
  const worker = shipyard.codex(shipyard.CODEX_MODELS.routine);
  const sandbox = docker();
  const phaseAdapter = shipyard.createCredentialIsolatedRunPhaseEngineAdapter({
    agent: worker,
    sandbox,
    workerEnvAllowlist: modelEnvAllowlist,
    run: async (options) => {
      const requestedBranch =
        options.branchStrategy?.type === "branch"
          ? options.branchStrategy.branch
          : undefined;
      if (requestedBranch !== input.branch) {
        throw new Error("Implementation adapter received an unexpected branch");
      }
      if (
        await transport.findBranchByName({ repository, branch: input.branch })
      ) {
        throw new Error(
          "A remote issue branch exists without coordinator candidate evidence",
        );
      }
      const pullRequests = await pullRequestsFor(input.branch);
      if (pullRequests.length > 0) {
        throw new Error(
          "A pull request exists without coordinator candidate evidence",
        );
      }
      const localBranch = await hostCommand("git", [
        "branch",
        "--list",
        input.branch,
      ]);
      if (localBranch.length > 0) {
        const currentBranch = await hostCommand("git", [
          "branch",
          "--show-current",
        ]);
        if (currentBranch === input.branch) {
          throw new Error(
            "The issue branch is checked out in the host worktree",
          );
        }
        const oldHead = await hostCommand("git", [
          "rev-parse",
          `refs/heads/${input.branch}`,
        ]);
        const orphan = `shipyard/orphan-${input.issue.number}-${oldHead.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
        await hostCommand("git", ["branch", "-m", input.branch, orphan]);
      }
      return shipyard.run({
        ...options,
        sandbox,
        hooks,
        copyToWorktree,
        output: shipyard.Output.object({
          tag: "phase-result",
          schema: phaseReportSchema,
        }),
        completionSignal: "<promise>COMPLETE</promise>",
        maxIterations: 1,
        envAllowlist: modelEnvAllowlist,
      });
    },
  });
  return {
    trusted: {
      brief: input.brief,
      policy,
      skill: { revision: policy.worker.skillRevision, content: workerPrompt },
    },
    untrusted: { sourceText: input.issue.body, repositoryContent: [] },
    controls: {
      toolAllowlist: [],
      credentialAllowlist: modelEnvAllowlist,
      timeoutSeconds: policy.phaseBudgets.implementation.timeoutSeconds,
      maxIterations: 1,
    },
    adapter: phaseAdapter,
    artifactStore: shipyard.createInMemoryArtifactStore(),
    credentialResolver: { resolve: async (name: string) => hostEnv[name] },
    output: shipyard.Output.object({
      tag: "phase-result",
      schema: phaseReportSchema,
    }),
  };
};

const deliverStandaloneGroup = async ({
  group,
}: {
  group: DeliveryGroup;
  delivery: ReturnType<typeof canonicalGroup>;
}) => {
  const issue = await assertActivated(group);
  if (group.mode !== "standalone")
    throw new Error("Expected standalone delivery");
  const base = await currentBase();
  const identity: shipyard.WorkIdentity = {
    repository,
    itemId: String(issue.number),
    kind: "executable-issue",
  };
  const previous = await coordinator.getCurrentJob(identity);
  const problem = `${issue.title}\n\n${issue.body || "(empty issue body)"}`;
  const brief =
    previous?.brief.problem === problem && previous.brief.base.sha === base.sha
      ? previous.brief
      : createBrief({
          issue,
          kind: "executable-issue",
          base,
          revision: previous === undefined ? 1 : previous.brief.revision + 1,
        });
  const branch = `shipyard/issue-${issue.number}`;
  const execution = await createStandaloneExecution({ issue, brief, branch });
  const reviewProvider: shipyard.ReviewProvider = {
    review: async (request) => {
      const result = await reviewCandidate({
        scope: `issue #${issue.number}`,
        base: request.candidate.base,
        head: request.candidate.head,
        brief: request.candidate.brief,
      });
      return {
        ...result,
        baseSha: request.candidate.base.sha,
        headSha: request.candidate.head.sha,
        briefHash: request.candidate.brief.hash,
        commits: [],
      };
    },
  };
  const result = await shipyard.deliverStandalone({
    coordinator,
    publication,
    brief,
    policy,
    workerId: `parallel-planner-${randomUUID()}`,
    issueNumber: issue.number,
    branch,
    leaseTtlMs: 7_200_000,
    execution,
    review: reviewProvider,
    readCurrent: () => readStandaloneCurrent({ group, brief, branch }),
    verifyChecks: (candidate) => candidateChecks(candidate),
    cleanup: cleanupCandidate,
  });
  if (result.outcome === "ready-for-human") {
    console.log(`Issue #${issue.number} ready for human handoff.`);
  } else {
    console.error(
      `Issue #${issue.number} blocked: ${result.reason ?? "delivery incomplete"}`,
    );
  }
  return result;
};

const specGitAdapter: shipyard.GitHubSpecDeliveryGitAdapter = {
  reconcile: async (input) => {
    const pending = input.delivery.specCheckpoint?.children.find(
      (child) => child.status === "integrating",
    );
    if (pending?.sourceCommit === undefined) return {};
    const branch = await transport.findBranchByName({
      repository,
      branch: input.integrationBranch,
    });
    if (branch === undefined) return {};
    await hostCommand("git", ["fetch", "origin", input.integrationBranch]);
    const cherry = await hostCommand("git", [
      "cherry",
      `origin/${input.integrationBranch}`,
      pending.sourceCommit.sha,
      `${pending.sourceCommit.sha}^`,
    ]);
    if (!cherry.trimStart().startsWith("-")) return {};
    return {
      integratedChild: {
        child: pending.child,
        sourceCommit: pending.sourceCommit,
        head: { branch: input.integrationBranch, sha: branch.headSha },
      },
    };
  },
  integrateChild: async (input) => {
    const integrated = await shipyard.integrateTemplateDelivery({
      repositoryPath: cwd,
      branch: input.integrationBranch,
      baseBranch,
      commits: [input.sourceCommit.sha],
      run: hostCommand,
    });
    return { branch: input.integrationBranch, sha: integrated.headSha };
  },
};
const specHost = shipyard.createGitHubSpecDeliveryHost({
  coordinator,
  transport,
  git: specGitAdapter,
});

const specCurrent = async (input: {
  group: DeliveryGroup;
  brief: shipyard.WorkBrief;
  integrationBranch: string;
  deliveryId: string;
  deliveryVersion: number;
}) => {
  const issue = await assertActivated(input.group);
  const currentProblem = `${issue.title}\n\n${issue.body || "(empty issue body)"}`;
  if (currentProblem !== input.brief.problem) {
    throw new Error("Planning spec changed during delivery");
  }
  const base = await currentBase();
  const branch = await transport.findBranchByName({
    repository,
    branch: input.integrationBranch,
  });
  const pullRequests = await pullRequestsFor(input.integrationBranch);
  if (branch === undefined || pullRequests.length !== 1) {
    throw new Error("Planning spec has no exact open integration pull request");
  }
  const pullRequest = pullRequests[0]!;
  const metadata = shipyard.parseGitHubPublicationMetadata(pullRequest.body);
  if (
    pullRequest.state !== "OPEN" ||
    pullRequest.headRefOid !== branch.headSha ||
    pullRequest.baseRefName !== baseBranch ||
    pullRequest.headRefName !== input.integrationBranch ||
    metadata?.repository !== repository ||
    metadata.itemId !== String(issue.number) ||
    metadata.kind !== "planning-spec" ||
    metadata.deliveryVersion !== input.deliveryVersion ||
    metadata.briefRevision !== input.brief.revision ||
    metadata.briefHash !== input.brief.hash ||
    metadata.baseBranch !== baseBranch ||
    metadata.baseSha !== base.sha ||
    metadata.branch !== input.integrationBranch ||
    metadata.headSha !== branch.headSha
  ) {
    throw new Error(
      "Remote spec pull request does not match the current candidate",
    );
  }
  return {
    base,
    head: { branch: input.integrationBranch, sha: branch.headSha },
    briefHash: input.brief.hash,
    pullRequest: {
      id: String(pullRequest.number),
      state: "open" as const,
      draft: pullRequest.isDraft,
      baseBranch: pullRequest.baseRefName,
      headBranch: pullRequest.headRefName,
      baseSha: metadata.baseSha,
      headSha: metadata.headSha,
      briefHash: metadata.briefHash,
      deliveryId: input.deliveryId,
      readyForHuman: pullRequest.labels.some(
        (label) => label.name.toLowerCase() === shipyard.READY_FOR_HUMAN_LABEL,
      ),
    },
  };
};

const runSpecChecks = async (input: {
  delivery: shipyard.DeliveryRecord;
  candidate: shipyard.SpecCandidate;
  lease: shipyard.DeliveryLease;
  signal: AbortSignal;
  key: string;
}) => {
  const checks = await candidateChecks(input.candidate, input.signal);
  for (const check of checks) {
    await specHost.publishCheck({
      delivery: input.delivery,
      candidate: input.candidate,
      check,
      key: input.key,
      lease: input.lease,
      signal: input.signal,
    });
  }
  return checks;
};

const deliverSpecGroup = async ({
  group,
  delivery: plannedDelivery,
}: {
  group: DeliveryGroup;
  delivery: ReturnType<typeof canonicalGroup>;
}) => {
  if (group.mode !== "planning-spec")
    throw new Error("Expected planning-spec delivery");
  const issue = await assertActivated(group);
  const base = await currentBase();
  const delivery = await coordinator.resolveDelivery(plannedDelivery);
  const brief = createBrief({
    issue,
    kind: "planning-spec",
    base,
    revision: delivery.version,
    problem: `${issue.title}\n\n${issue.body || "(empty issue body)"}`,
    acceptanceCriteria: [
      `Complete all ${delivery.graph.children.length} executable child issues in the current dependency graph.`,
      "Integrate and verify each child before closing it.",
    ],
  });
  const childWorker: shipyard.SpecChildWorker = {
    implement: async (request) => {
      const issueNumber = Number(request.child.itemId);
      const childIssue = await transport.fetchIssue({
        repository,
        issueNumber,
      });
      if (childIssue === undefined || childIssue.state !== "open") {
        throw new Error(`Child issue #${issueNumber} is not open`);
      }
      const branch = `shipyard/spec-${issue.number}-child-${issueNumber}-${randomUUID().slice(0, 8)}`;
      const run = await shipyard.run({
        hooks,
        copyToWorktree,
        sandbox: docker(),
        branchStrategy: {
          type: "branch",
          branch,
          baseBranch: request.base.sha,
        },
        name: "spec-child",
        maxIterations: 100,
        agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
        promptFile: "./.shipyard/implement-prompt.md",
        promptArgs: {
          TASK_ID: request.child.itemId,
          ISSUE_TITLE: childIssue.title,
          ISSUE_BODY: childIssue.body || "(empty issue body)",
          BRANCH: branch,
          DELIVERY_ID: request.delivery.id,
          INTEGRATION_BRANCH: request.integrationBranch,
        },
        output: shipyard.Output.object({
          tag: "phase-result",
          schema: phaseReportSchema,
        }),
        completionSignal: "<promise>COMPLETE</promise>",
        envAllowlist: modelEnvAllowlist,
      });
      const lastCommit = run.commits.at(-1);
      if (run.completionSignal === undefined || lastCommit === undefined) {
        throw new Error(`Child issue #${issueNumber} returned no commit`);
      }
      if (run.commits.length !== 1) {
        throw new Error(
          `Child issue #${issueNumber} must return one commit for serial integration`,
        );
      }
      return {
        commit: { branch, sha: lastCommit.sha },
        evidence: run.output.evidence,
      };
    },
  };
  const verification: shipyard.SpecVerificationAdapter = {
    verifyChild: async (request) => ({
      checks: await runSpecChecks({
        ...request,
        key: `child-${request.child.itemId}-${request.sourceCommit.sha}`,
      }),
      cleanup: {
        status: (await cleanupCandidate(request.candidate))
          ? "passed"
          : "failed",
        summary: "Focused candidate cleanup/self-check.",
      },
      evidence: [
        `Child #${request.child.itemId} integrated at ${request.candidate.head.sha}.`,
      ],
    }),
    verifyIntegrated: async (request) => ({
      checks: await runSpecChecks({ ...request, key: "integrated" }),
      cleanup: {
        status: (await cleanupCandidate(request.candidate))
          ? "passed"
          : "failed",
        summary: "Integrated candidate cleanup/self-check.",
      },
      evidence: [
        `Integrated candidate ${request.candidate.head.sha} was verified.`,
      ],
    }),
  };
  const review: shipyard.SpecReviewProvider = {
    review: async (request) => {
      const report = await reviewCandidate({
        scope: `planning spec #${issue.number}`,
        base: request.checkout.base,
        head: request.checkout.candidate,
        brief,
        requiredAxes: request.requiredAxes,
      });
      return {
        ...report,
        baseSha: request.checkout.base.sha,
        headSha: request.checkout.candidate.sha,
        briefHash: brief.hash,
      };
    },
  };
  const result = await shipyard.deliverSpec({
    coordinator,
    delivery: plannedDelivery,
    brief,
    policy,
    workerId: `parallel-planner-${randomUUID()}`,
    base,
    integrationBranch: group.integrationBranch,
    childWorker,
    integration: specHost.integration,
    verification,
    childLifecycle: specHost.childLifecycle,
    review,
    readCurrent: async () => {
      const current = await coordinator.getDelivery(delivery.key);
      if (current === undefined)
        throw new Error("Spec delivery record disappeared");
      return specCurrent({
        group,
        brief,
        integrationBranch: group.integrationBranch,
        deliveryId: current.id,
        deliveryVersion: current.version,
      });
    },
    maxConcurrency: 2,
    leaseTtlMs: 7_200_000,
  });
  if (result.outcome === "blocked" && result.lease !== undefined) {
    try {
      const current = await coordinator.getDelivery(result.delivery.key);
      if (current !== undefined) {
        const sameVersionNotDraft =
          result.reason?.includes("not a draft") ?? false;
        await specHost.publishBlocked({
          delivery: current,
          lease: result.lease,
          reason: result.reason ?? "Spec delivery blocked",
          ...(result.blockedChild === undefined
            ? {}
            : { blockedChild: result.blockedChild }),
          ...(result.blockedEvidence === undefined
            ? {}
            : { failureEvidence: result.blockedEvidence }),
          ...(sameVersionNotDraft || result.candidate === undefined
            ? {}
            : { candidate: result.candidate }),
        });
      }
    } catch (error) {
      console.error(
        `Could not publish blocked state for #${issue.number}: ${String(error)}`,
      );
    }
  }
  if (result.outcome === "ready-for-human") {
    console.log(`Planning spec #${issue.number} ready for human handoff.`);
  } else {
    console.error(
      `Planning spec #${issue.number} blocked: ${result.reason ?? "delivery incomplete"}`,
    );
  }
  return result;
};

try {
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
      envAllowlist: modelEnvAllowlist,
    });
    const result = await deliverPlannedGroups({
      groups: plan.output.deliveryGroups,
      hydrate: hydrateGroup,
      resolve: canonicalGroup,
      deliverStandalone: deliverStandaloneGroup,
      deliverSpec: deliverSpecGroup,
    });
    if (result.outcome === "no-work") {
      console.log("No delivery groups are ready. Exiting.");
      break;
    }
    if (result.outcome === "blocked") {
      console.log("No delivery group reached human handoff. Stopping.");
      break;
    }
    console.log("Completed delivery groups through canonical host workflows.");
  }
} finally {
  await coordinatorRuntime.close();
}

console.log("\nAll done.");
