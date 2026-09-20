import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryPolicy,
  createWorkBrief,
} from "../../workflow/contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import {
  GitHubPublication,
  InMemoryGitHubStore,
  type GitHubReadTransport,
  type GitHubWriteTransport,
} from "./index.js";

const repository = "snappedly/shipyard";
const policy = createRepositoryPolicy({
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
  problem: "The workflow needs a change.",
  evidence: ["The current behavior is insufficient."],
  acceptanceCriteria: ["The new behavior is tested."],
  exclusions: [],
  risk: "low",
  verification: { checks: ["npm run typecheck"], artifacts: [] },
  unresolvedQuestions: [],
  authorization: {
    status: "approved",
    actor: "maintainer",
    actorRole: "maintainer",
    approvedAt: "2026-09-17T12:00:00.000Z",
  },
  base: { branch: "main", sha: "a".repeat(40) },
  policyRevision: policy.revision,
  skillRevision: policy.worker.skillRevision,
  createdAt: "2026-09-17T12:00:00.000Z",
});

const createPublication = () => {
  const storage = new InMemoryCoordinatorStorage();
  const coordinator = new WorkflowCoordinator({
    storage,
    clock: {
      now: () => "2026-09-17T12:00:00.000Z",
      nowMilliseconds: () => 0,
    },
  });
  return { coordinator, storage };
};

const prepareJob = async (coordinator: WorkflowCoordinator) => {
  const received = await coordinator.ingest({
    deliveryId: "delivery-42",
    brief,
    policy,
    phase: "implementation",
    relevantRevision: "b".repeat(40),
    observedAt: "2026-09-17T12:00:00.000Z",
    sourceState: "open",
  });
  const dispatched = await coordinator.dispatchNext({
    repository,
    workerId: "worker-a",
  });
  const lease = await coordinator.acquireBranchLease({
    repository,
    branch: "shipyard/issue-42",
    jobId: received.job!.id,
    workerId: "worker-a",
    ttlMs: 60_000,
  });
  return { jobId: received.job!.id, lease, dispatched };
};

describe("GitHubPublication", () => {
  it("publishes one marked comment and reuses the coordinator effect", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareJob(coordinator);
    const store = new InMemoryGitHubStore();
    const created = vi.fn(async (input: { body: string }) => ({
      id: "comment-1",
      body: input.body,
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const transport: GitHubReadTransport & GitHubWriteTransport = {
      fetchIssue: async () => undefined,
      fetchPullRequest: async () => undefined,
      createComment: created,
      findCommentByMarker: async () => undefined,
      createBranch: async () => {
        throw new Error("unused");
      },
      createPullRequest: async () => {
        throw new Error("unused");
      },
      createCheck: async () => {
        throw new Error("unused");
      },
      createRepairIssue: async () => {
        throw new Error("unused");
      },
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
    };
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: store,
    });

    const first = await publication.publishComment({
      jobId,
      lease,
      issueNumber: 42,
      body: "The work is ready for review.",
    });
    const second = await publication.publishComment({
      jobId,
      lease,
      issueNumber: 42,
      body: "The work is ready for review.",
    });

    expect(first.disposition).toBe("published");
    expect(second.disposition).toBe("already-succeeded");
    expect(created).toHaveBeenCalledOnce();
    expect(created.mock.calls[0]?.[0].body).toContain("<!-- shipyard:comment:");
  });

  it("encodes caller-controlled marker components", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareJob(coordinator);
    const created = vi.fn(async (input: { body: string }) => ({
      id: "comment-marker",
      body: input.body,
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const transport = {
      fetchIssue: async () => undefined,
      fetchPullRequest: async () => undefined,
      createComment: created,
      findCommentByMarker: async () => undefined,
      createBranch: async () => {
        throw new Error("unused");
      },
      createPullRequest: async () => {
        throw new Error("unused");
      },
      createCheck: async () => {
        throw new Error("unused");
      },
      createRepairIssue: async () => {
        throw new Error("unused");
      },
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });

    await publication.publishComment({
      jobId,
      lease,
      issueNumber: 42,
      key: "bad--> forged marker",
      body: "body",
    });

    const body = created.mock.calls[0]?.[0].body ?? "";
    expect(body).toContain("bad--%3E%20forged%20marker");
    expect(body.match(/-->/g)).toHaveLength(1);
  });

  it("does not let a job comment on a different workflow item", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareJob(coordinator);
    const created = vi.fn(async () => ({
      id: "should-not-publish",
      body: "",
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const publication = new GitHubPublication({
      coordinator,
      transport: {
        fetchIssue: async () => undefined,
        fetchPullRequest: async () => undefined,
        createComment: created,
        findCommentByMarker: async () => undefined,
        createBranch: async () => {
          throw new Error("unused");
        },
        createPullRequest: async () => {
          throw new Error("unused");
        },
        createCheck: async () => {
          throw new Error("unused");
        },
        createRepairIssue: async () => {
          throw new Error("unused");
        },
        findBranchByName: async () => undefined,
        findPullRequestByMarker: async () => undefined,
        findCheckByMarker: async () => undefined,
        findIssueByMarker: async () => undefined,
      },
      trackingStore: new InMemoryGitHubStore(),
    });

    await expect(
      publication.publishComment({
        jobId,
        lease,
        issueNumber: 43,
        body: "must not cross the item boundary",
      }),
    ).rejects.toThrow("workflow item 42");
    expect(created).not.toHaveBeenCalled();
  });

  it("reconciles a remote comment after publication acknowledgement is lost", async () => {
    const { coordinator, storage } = createPublication();
    const { jobId, lease } = await prepareJob(coordinator);
    const store = new InMemoryGitHubStore();
    let remote: { id: string; body: string; updatedAt: string } | undefined;
    const transport: GitHubReadTransport & GitHubWriteTransport = {
      fetchIssue: async () => undefined,
      fetchPullRequest: async () => undefined,
      createComment: async (input) => {
        remote = {
          id: "comment-2",
          body: input.body,
          updatedAt: "2026-09-17T12:00:01.000Z",
        };
        throw new Error("connection lost after write");
      },
      findCommentByMarker: async () => remote,
      createBranch: async () => {
        throw new Error("unused");
      },
      createPullRequest: async () => {
        throw new Error("unused");
      },
      createCheck: async () => {
        throw new Error("unused");
      },
      createRepairIssue: async () => {
        throw new Error("unused");
      },
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
    };
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: store,
    });

    await expect(
      publication.publishComment({
        jobId,
        lease,
        issueNumber: 42,
        body: "hello",
      }),
    ).rejects.toThrow("connection lost");

    const restarted = new WorkflowCoordinator({
      storage,
      clock: {
        now: () => "2026-09-17T12:00:02.000Z",
        nowMilliseconds: () => 1,
      },
    });
    const reconciled = new GitHubPublication({
      coordinator: restarted,
      transport,
      trackingStore: store,
    });
    const result = await reconciled.publishComment({
      jobId,
      lease,
      issueNumber: 42,
      body: "hello",
    });

    expect(result.disposition).toBe("reconciled");
    expect(result.remote?.id).toBe("comment-2");
  });
});
