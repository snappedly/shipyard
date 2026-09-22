import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_CONTRACT_VERSION,
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

const planningBrief = createWorkBrief({
  identity: { repository, itemId: "100", kind: "planning-spec" },
  source: {
    provider: "github",
    repository,
    itemId: "100",
    originalBody: "Deliver the planning spec.",
  },
  problem: "Deliver the planning spec.",
  evidence: ["The planning spec is authorized."],
  acceptanceCriteria: ["All child work is delivered."],
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

const prepareCandidateJob = async (coordinator: WorkflowCoordinator) => {
  const prepared = await prepareJob(coordinator);
  await coordinator.recordPhaseResult({
    jobId: prepared.jobId,
    lease: prepared.lease,
    result: {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      assignmentId: prepared.dispatched.assignment!.id,
      phase: "implementation",
      outcome: "completed",
      identity: brief.identity,
      briefHash: brief.hash,
      base: brief.base,
      head: { branch: "shipyard/issue-42", sha: "b".repeat(40) },
      summary: "Published candidate",
      evidence: ["The change is verified."],
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          status: "passed",
          summary: "passed",
          baseSha: brief.base.sha,
          headSha: "b".repeat(40),
          briefHash: brief.hash,
        },
      ],
      commits: ["b".repeat(40)],
      artifacts: [],
      questions: [],
      findings: [],
      completedAt: "2026-09-17T12:00:01.000Z",
    },
  });
  return prepared;
};

const preparePlanningSpecJob = async (coordinator: WorkflowCoordinator) => {
  const received = await coordinator.ingest({
    deliveryId: "delivery-spec-100",
    brief: planningBrief,
    policy,
    phase: "triage",
    relevantRevision: planningBrief.base.sha,
    observedAt: "2026-09-17T12:00:00.000Z",
    sourceState: "open",
  });
  const lease = await coordinator.acquireBranchLease({
    repository,
    branch: "shipyard/spec-100",
    jobId: received.job!.id,
    workerId: "worker-spec",
    ttlMs: 60_000,
  });
  return { jobId: received.job!.id, lease };
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

  it("updates an existing branch when a new candidate head is published", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareCandidateJob(coordinator);
    const stale = "c".repeat(40);
    const candidate = "b".repeat(40);
    const updateBranch = vi.fn(
      async (input: { readonly branch: string; readonly headSha: string }) => ({
        name: input.branch,
        headSha: input.headSha,
      }),
    );
    const createBranch = vi.fn(async () => {
      throw new Error("createBranch should not be used for an existing branch");
    });
    const transport = {
      fetchIssue: async () => undefined,
      fetchPullRequest: async () => undefined,
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => ({
        name: "shipyard/issue-42",
        headSha: stale,
      }),
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      createComment: async () => {
        throw new Error("unused");
      },
      createBranch,
      updateBranch,
      createPullRequest: async () => {
        throw new Error("unused");
      },
      createCheck: async () => {
        throw new Error("unused");
      },
      createRepairIssue: async () => {
        throw new Error("unused");
      },
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });

    const result = await publication.publishBranch({
      jobId,
      lease,
      branch: "shipyard/issue-42",
      headSha: candidate,
    });

    expect(result.disposition).toBe("published");
    expect(result.effect.marker).toContain(candidate);
    expect(createBranch).not.toHaveBeenCalled();
    expect(updateBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "shipyard/issue-42",
        headSha: candidate,
      }),
    );
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

  it("marks only the current published PR candidate ready for human review", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareCandidateJob(coordinator);
    let pullRequest = {
      number: 100,
      title: "Candidate",
      body: "candidate",
      state: "open" as const,
      draft: true,
      branch: "shipyard/issue-42",
      baseBranch: "main",
      headSha: "b".repeat(40),
      updatedAt: "2026-09-17T12:00:01.000Z",
      labels: [] as string[],
    };
    const updatePullRequest = vi.fn(
      async (input: {
        readonly draft?: boolean;
        readonly labels?: readonly string[];
      }) => {
        pullRequest = {
          ...pullRequest,
          draft: input.draft ?? pullRequest.draft,
          labels: [...(input.labels ?? pullRequest.labels)],
        };
        return pullRequest;
      },
    );
    const transport = {
      fetchIssue: async () => undefined,
      fetchPullRequest: async () => pullRequest,
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => pullRequest,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      createComment: async () => {
        throw new Error("unused");
      },
      createBranch: async () => {
        throw new Error("unused");
      },
      createPullRequest: async () => {
        throw new Error("unused");
      },
      updatePullRequest,
      createCheck: async () => {
        throw new Error("unused");
      },
      createRepairIssue: async () => {
        throw new Error("unused");
      },
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });

    const input = {
      jobId,
      lease,
      pullRequestNumber: 100,
      branch: "shipyard/issue-42",
      baseBranch: "main",
      headSha: "b".repeat(40),
      briefHash: brief.hash,
    };
    const first = await publication.publishPullRequestHandoff(input);
    const replay = await publication.publishPullRequestHandoff(input);

    expect(first.disposition).toBe("published");
    expect(replay.disposition).toBe("already-succeeded");
    expect(pullRequest.draft).toBe(false);
    expect(pullRequest.labels).toEqual(["ready-for-human"]);
    expect(updatePullRequest).toHaveBeenCalledOnce();
  });

  it("records closure evidence and closes a published issue idempotently", async () => {
    const { coordinator } = createPublication();
    const { jobId, lease } = await prepareCandidateJob(coordinator);
    let issue = {
      number: 42,
      title: "Candidate",
      body: "source",
      state: "open" as "open" | "closed",
      updatedAt: "2026-09-17T12:00:01.000Z",
      labels: [] as string[],
    };
    const createComment = vi.fn(async (input: { readonly body: string }) => ({
      id: "closure-comment",
      body: input.body,
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const closeIssue = vi.fn(async () => {
      issue = { ...issue, state: "closed" };
      return issue;
    });
    const transport = {
      fetchIssue: async () => issue,
      fetchPullRequest: async () => ({
        number: 100,
        title: "Candidate",
        body: "candidate",
        state: "open" as const,
        draft: true,
        branch: "shipyard/issue-42",
        baseBranch: "main",
        headSha: "b".repeat(40),
        updatedAt: "2026-09-17T12:00:01.000Z",
      }),
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      createComment,
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
      closeIssue,
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });
    const input = {
      jobId,
      lease,
      issueNumber: 42,
      pullRequestNumber: 100,
      branch: "shipyard/issue-42",
      commitSha: "b".repeat(40),
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          status: "passed" as const,
          summary: "passed",
          baseSha: brief.base.sha,
          headSha: "b".repeat(40),
          briefHash: brief.hash,
        },
      ],
      cleanupCompleted: true,
    };

    const first = await publication.publishStandaloneIssueClosure(input);
    const replay = await publication.publishStandaloneIssueClosure(input);

    expect(first.comment.disposition).toBe("published");
    expect(first.issue.disposition).toBe("published");
    expect(replay.comment.disposition).toBe("already-succeeded");
    expect(replay.issue.disposition).toBe("already-succeeded");
    expect(createComment).toHaveBeenCalledOnce();
    expect(closeIssue).toHaveBeenCalledOnce();
    expect(issue.state).toBe("closed");
    expect(createComment.mock.calls[0]?.[0].body).toContain(
      "Pull request: #100",
    );
  });

  it("publishes one aggregate planning-spec comment and closes the parent once", async () => {
    const { coordinator } = createPublication();
    const prepared = await preparePlanningSpecJob(coordinator);
    let issue = {
      number: 100,
      title: "Planning spec",
      body: "source",
      state: "open" as "open" | "closed",
      updatedAt: "2026-09-17T12:00:01.000Z",
      labels: [],
    };
    const createComment = vi.fn(async (input: { readonly body: string }) => ({
      id: `aggregate-comment-${createComment.mock.calls.length + 1}`,
      body: input.body,
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const closeIssue = vi.fn(async () => {
      issue = { ...issue, state: "closed" };
      return issue;
    });
    const transport = {
      fetchIssue: async () => issue,
      fetchPullRequest: async () => undefined,
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      createComment,
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
      closeIssue,
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });
    const input = {
      jobId: prepared.jobId,
      lease: prepared.lease,
      parentIssueNumber: 100,
      pullRequestNumber: 200,
      pullRequestUrl: "https://github.com/snappedly/shipyard/pull/200",
      mergedSha: "d".repeat(40),
      originalChildren: [
        { number: 101, kind: "child" as const, state: "closed" as const },
      ],
      repairChildren: [
        { number: 201, kind: "repair" as const, state: "closed" as const },
      ],
    };

    const first = await publication.publishPlanningSpecClosure(input);
    const replay = await publication.publishPlanningSpecClosure(input);

    expect(first.comment.disposition).toBe("published");
    expect(first.issue?.disposition).toBe("published");
    expect(replay.comment.disposition).toBe("already-succeeded");
    expect(replay.issue?.disposition).toBe("already-succeeded");
    expect(createComment).toHaveBeenCalledOnce();
    expect(closeIssue).toHaveBeenCalledOnce();
    expect(issue.state).toBe("closed");
    expect(createComment.mock.calls[0]?.[0].body).toContain("Merged revision");
    expect(createComment.mock.calls[0]?.[0].body).toContain("#201");
  });

  it("projects blocked work without leaking diagnostics or adding duplicate PRs", async () => {
    const { coordinator } = createPublication();
    const prepared = await prepareCandidateJob(coordinator);
    let issue = {
      number: 42,
      title: "Candidate",
      body: "source",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:01.000Z",
      labels: ["shipyard", "bug"] as string[],
    };
    let pullRequest = {
      number: 100,
      title: "Candidate",
      body: "candidate",
      state: "open" as const,
      draft: false,
      branch: "shipyard/issue-42",
      baseBranch: "main",
      headSha: "b".repeat(40),
      updatedAt: "2026-09-17T12:00:01.000Z",
      labels: ["ready-for-human", "shipyard"] as string[],
    };
    const ensureLabel = vi.fn(
      async (input: { name: string; color: string; description: string }) => ({
        name: input.name,
        color: input.color,
        description: input.description,
      }),
    );
    const createComment = vi.fn(async (input: { body: string }) => ({
      id: `comment-${createComment.mock.calls.length + 1}`,
      body: input.body,
      updatedAt: "2026-09-17T12:00:01.000Z",
    }));
    const transport = {
      fetchIssue: async () => issue,
      updateIssue: async (input: { labels: readonly string[] }) => {
        issue = { ...issue, labels: [...input.labels] };
        return issue;
      },
      ensureLabel,
      fetchPullRequest: async () => pullRequest,
      updatePullRequest: async (input: {
        draft?: boolean;
        labels?: readonly string[];
      }) => {
        pullRequest = {
          ...pullRequest,
          draft: input.draft ?? pullRequest.draft,
          labels: [...(input.labels ?? pullRequest.labels)],
        };
        return pullRequest;
      },
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      createComment,
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
    } satisfies GitHubReadTransport & GitHubWriteTransport;
    const publication = new GitHubPublication({
      coordinator,
      transport,
      trackingStore: new InMemoryGitHubStore(),
    });

    const projected = await publication.publishBlockedDelivery({
      jobId: prepared.jobId,
      lease: prepared.lease,
      issueNumber: 42,
      parentIssueNumber: 1000,
      pullRequest: {
        number: 100,
        branch: "shipyard/issue-42",
        baseBranch: "main",
        headSha: "b".repeat(40),
      },
      evidence: {
        phase: "checking",
        error: "worker failed token=ghp_secret",
        attempts: 3,
        lastSuccessfulStep: "implementation",
        branch: "shipyard/issue-42",
        commit: "b".repeat(40),
        pullRequest: "#100",
        recovery: "Re-add shipyard",
        occurredAt: "2026-09-17T12:00:02.000Z",
      },
    });

    expect(ensureLabel).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shipyard-blocked", color: "d73a4a" }),
    );
    expect(issue.labels).toEqual(["bug", "shipyard-blocked"]);
    expect(pullRequest.draft).toBe(true);
    expect(pullRequest.labels).toEqual(["shipyard-blocked"]);
    expect(projected.parentComment?.remote?.body).toContain("child issue #42");
    expect(projected.comment.remote?.body).not.toContain("ghp_secret");
    expect(createComment).toHaveBeenCalledTimes(2);
  });
});
