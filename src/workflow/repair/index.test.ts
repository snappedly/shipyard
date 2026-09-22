import { describe, expect, it } from "vitest";
import {
  createRepositoryPolicy,
  createWorkBrief,
  WORKFLOW_CONTRACT_VERSION,
  type Finding,
  type RepositoryPolicy,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
} from "../coordinator/index.js";
import {
  GitHubPublication,
  InMemoryGitHubStore,
  type GitHubReadTransport,
  type GitHubWriteTransport,
} from "../../integrations/github/index.js";
import { InMemoryRepairBatchStore, scheduleBoundedRepair } from "./index.js";

const repository = "snappedly/shipyard";
const base = { branch: "main", sha: "a".repeat(40) };
const head = { branch: "shipyard/42-executable-issue", sha: "b".repeat(40) };

const policy: RepositoryPolicy = createRepositoryPolicy({
  repository,
  revision: "policy-1",
  baseBranch: "main",
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["maintainer"],
    autoStartRisk: ["low"],
  },
  worker: {
    provider: "fixture",
    model: "fixture",
    sandbox: "fixture",
    skillRevision: "skills-1",
  },
  checks: [{ name: "typecheck", command: "npm run typecheck", required: true }],
  phaseBudgets: {
    triage: { maxAttempts: 1, timeoutSeconds: 60 },
    implementation: { maxAttempts: 1, timeoutSeconds: 60 },
    checking: { maxAttempts: 1, timeoutSeconds: 60 },
    review: { maxAttempts: 1, timeoutSeconds: 60 },
    repair: { maxAttempts: 1, timeoutSeconds: 60 },
    handoff: { maxAttempts: 1, timeoutSeconds: 60 },
    merge: { maxAttempts: 1, timeoutSeconds: 60 },
    "release-verification": { maxAttempts: 1, timeoutSeconds: 60 },
  },
  repairBudget: { maxBatches: 1, maxFollowUps: 1 },
});

const brief = createWorkBrief({
  identity: { repository, itemId: "42", kind: "executable-issue" },
  source: {
    provider: "github",
    repository,
    itemId: "42",
    originalBody: "Implement the change.",
  },
  problem: "Implement the change",
  evidence: ["The issue is authorized."],
  acceptanceCriteria: ["The behavior is verified."],
  exclusions: [],
  risk: "low",
  verification: { checks: ["typecheck"], artifacts: [] },
  unresolvedQuestions: [],
  authorization: {
    status: "approved",
    actor: "maintainer",
    actorRole: "maintainer",
    approvedAt: "2026-09-17T12:00:00.000Z",
  },
  base,
  policyRevision: policy.revision,
  skillRevision: policy.worker.skillRevision,
  createdAt: "2026-09-17T12:00:00.000Z",
});

const finding = (id: string): Finding => ({
  id,
  severity: "high",
  axis: "spec",
  disposition: "open",
  title: "The acceptance behavior is missing",
  evidence: "The candidate does not exercise the required behavior.",
  requirement: "The approved brief requires the behavior.",
  verification: "Add a focused regression test.",
});

const createHarness = async () => {
  const coordinator = new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: {
      now: () => "2026-09-17T12:00:00.000Z",
      nowMilliseconds: () => 0,
    },
  });
  const ingested = await coordinator.ingest({
    deliveryId: "implementation-42",
    brief,
    policy,
    phase: "implementation",
    relevantRevision: base.sha,
    observedAt: "2026-09-17T12:00:00.000Z",
  });
  const dispatched = await coordinator.dispatchNext({
    repository,
    workerId: "worker-a",
  });
  const candidateLease = await coordinator.acquireBranchLease({
    repository,
    branch: head.branch,
    jobId: ingested.job!.id,
    workerId: "worker-a",
    ttlMs: 60_000,
  });
  await coordinator.recordPhaseResult({
    jobId: ingested.job!.id,
    lease: candidateLease,
    result: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      assignmentId: dispatched.assignment!.id,
      phase: "implementation",
      outcome: "completed",
      identity: brief.identity,
      briefHash: brief.hash,
      base: brief.base,
      head,
      summary: "Published candidate",
      evidence: ["The candidate is ready for repair."],
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          status: "passed",
          summary: "passed",
          baseSha: base.sha,
          headSha: head.sha,
          briefHash: brief.hash,
        },
      ],
      commits: [head.sha],
      artifacts: [],
      questions: [],
      findings: [],
      completedAt: "2026-09-17T12:00:01.000Z",
    },
  });
  const store = new InMemoryGitHubStore();
  const repairStore = new InMemoryRepairBatchStore();
  const createdIssues: string[] = [];
  let pullRequest = {
    number: 100,
    title: "Candidate",
    body: "candidate",
    state: "open" as const,
    draft: false,
    branch: head.branch,
    baseBranch: base.branch,
    headSha: head.sha,
    updatedAt: "2026-09-17T12:00:00.000Z",
    labels: ["ready-for-human"],
  };
  const transport: GitHubReadTransport & GitHubWriteTransport = {
    fetchIssue: async () => undefined,
    fetchPullRequest: async () => pullRequest,
    findCommentByMarker: async () => undefined,
    findBranchByName: async () => undefined,
    findPullRequestByMarker: async () => undefined,
    findCheckByMarker: async () => undefined,
    findIssueByMarker: async () => undefined,
    createComment: async (input) => ({
      id: "comment-1",
      body: input.body,
      updatedAt: "2026-09-17T12:00:00.000Z",
    }),
    createBranch: async (input) => ({
      name: input.branch,
      headSha: input.headSha,
    }),
    updatePullRequest: async (input) => {
      pullRequest = {
        ...pullRequest,
        draft: input.draft ?? pullRequest.draft,
        labels: [...(input.labels ?? pullRequest.labels)],
      };
      return pullRequest;
    },
    createPullRequest: async () => {
      throw new Error("unused");
    },
    createCheck: async () => {
      throw new Error("unused");
    },
    createRepairIssue: async (input) => {
      createdIssues.push(input.body);
      return {
        number: 77,
        title: input.title,
        body: input.body,
        state: "open",
        updatedAt: "2026-09-17T12:00:00.000Z",
        labels: input.labels,
        htmlUrl: "https://github.com/snappedly/shipyard/issues/77",
      };
    },
  };
  return {
    coordinator,
    jobId: ingested.job!.id,
    store,
    repairStore,
    createdIssues,
    publication: new GitHubPublication({
      coordinator,
      transport,
      trackingStore: store,
    }),
  };
};

describe("bounded PR repair", () => {
  it("deduplicates one repair issue and schedules the existing branch", async () => {
    const harness = await createHarness();
    const input = {
      ...harness,
      store: harness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      sourceIssueNumber: 42,
      pullRequestNumber: 100,
      findings: [finding("finding-1"), finding("finding-duplicate")],
    };
    const first = await scheduleBoundedRepair(input);
    const second = await scheduleBoundedRepair(input);

    expect(first.outcome).toBe("scheduled");
    expect(first.repairIssue?.number).toBe(77);
    expect(second.outcome).toBe("duplicate");
    expect(harness.createdIssues).toHaveLength(1);
    expect(first.handoffInvalidation?.remote?.draft).toBe(true);
    expect(first.handoffInvalidation?.remote?.labels).not.toContain(
      "ready-for-human",
    );
    expect(first.issuePublication?.remote?.labels).toContain(
      "shipyard:pr-repair",
    );
  });

  it("stops stale, closed, non-actionable, and budget-exhausted repairs", async () => {
    const staleHarness = await createHarness();
    const stale = await scheduleBoundedRepair({
      ...staleHarness,
      store: staleHarness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      findings: [finding("stale")],
      readCurrent: async () => ({
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      }),
    });
    expect(stale.outcome).toBe("blocked");

    const closedHarness = await createHarness();
    const closed = await scheduleBoundedRepair({
      ...closedHarness,
      store: closedHarness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      pullRequestState: "closed",
      findings: [finding("closed")],
    });
    expect(closed.outcome).toBe("blocked");

    const emptyHarness = await createHarness();
    const empty = await scheduleBoundedRepair({
      ...emptyHarness,
      store: emptyHarness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      findings: [{ ...finding("accepted"), disposition: "accepted" }],
    });
    expect(empty.outcome).toBe("blocked");

    const budgetHarness = await createHarness();
    const normal = await scheduleBoundedRepair({
      ...budgetHarness,
      store: budgetHarness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      findings: [finding("normal")],
    });
    const followUp = await scheduleBoundedRepair({
      ...budgetHarness,
      store: budgetHarness.repairStore,
      brief,
      policy,
      candidate: {
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      },
      workerId: "worker-a",
      followUp: true,
      findings: [finding("follow-up")],
    });
    const exhausted = await scheduleBoundedRepair({
      ...budgetHarness,
      store: budgetHarness.repairStore,
      brief,
      policy,
      candidate: {
        base,
        head: { ...head, sha: "d".repeat(40) },
        briefHash: brief.hash,
      },
      workerId: "worker-a",
      followUp: true,
      findings: [finding("follow-up-2")],
    });
    expect(normal.outcome).toBe("scheduled");
    expect(followUp.outcome).toBe("scheduled");
    expect(exhausted.outcome).toBe("blocked");
  });

  it("rejects post-merge mutation and requires a follow-up delivery", async () => {
    const harness = await createHarness();
    const result = await scheduleBoundedRepair({
      ...harness,
      store: harness.repairStore,
      brief,
      policy,
      candidate: { base, head, briefHash: brief.hash },
      workerId: "worker-a",
      deliveryState: "merged",
      findings: [finding("post-merge")],
    });

    expect(result.outcome).toBe("blocked");
    expect(result.followUpRequired).toBe(true);
    expect(result.reason).toContain("follow-up delivery");
  });
});
