import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type RepositoryPolicy,
} from "../../workflow/contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  resolveDeliveryGroup,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import {
  GitHubIntegration,
  GitHubPublication,
  InMemoryGitHubStore,
  createGitHubPlanningSpecCompletionHandler,
  serializeGitHubPublicationMetadata,
  verifyGitHubWebhookSignature,
  type GitHubReadTransport,
  type GitHubIssueRelationshipReader,
  type GitHubWriteTransport,
  type GitHubPullRequestReviewHandler,
  type GitHubWebhookSignatureInput,
} from "./index.js";
import {
  InMemoryTriageStore,
  type TriageAssessment,
} from "../../workflow/triage/index.js";

const sign = (body: string, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const repository = "snappedly/shipyard";
const secret = "test-secret";

const policy = (): RepositoryPolicy =>
  createRepositoryPolicy({
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
    checks: [
      { name: "typecheck", command: "npm run typecheck", required: true },
    ],
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

const webhook = (
  eventName: string,
  deliveryId: string,
  payload: unknown,
): { body: string; headers: Record<string, string> } => {
  const body = JSON.stringify(payload);
  return {
    body,
    headers: {
      "x-github-event": eventName,
      "x-github-delivery": deliveryId,
      "x-hub-signature-256": sign(body, secret),
    },
  };
};

const issuePayload = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  action: "opened",
  issue: {
    number: 42,
    title: "Fix the intake path",
    body: "authorization: approved",
    state: "open",
    updated_at: "2026-09-17T12:00:00.000Z",
    html_url: `https://github.com/${repository}/issues/42`,
    user: { login: "maintainer", type: "User" },
    labels: [],
  },
  repository: { full_name: repository, default_branch: "main" },
  sender: { login: "maintainer", type: "User" },
  ...overrides,
});

const createIntegration = (
  store = new InMemoryGitHubStore(),
  reviewHandler?: GitHubPullRequestReviewHandler,
  relationships?: GitHubIssueRelationshipReader,
) => {
  const coordinator = new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
  });
  const integration = new GitHubIntegration({
    coordinator,
    policy: policy(),
    base: { branch: "main", sha: "a".repeat(40) },
    authorization: {
      allowedRepositories: [repository],
      allowedSenders: ["maintainer", "contributor"],
      allowedReviewers: ["maintainer"],
    },
    deliveryStore: store,
    trackingStore: store,
    reviewHandler,
    relationships,
    webhookSecret: secret,
  });
  return { integration, coordinator, store };
};

describe("GitHub webhook signatures", () => {
  it("does not let unauthenticated requests reserve delivery IDs", async () => {
    const { integration, store } = createIntegration();
    const request = webhook("issues", "spoofed-delivery", issuePayload());
    const rejected = await integration.receiveWebhook({
      ...request,
      headers: { ...request.headers, "x-hub-signature-256": "invalid" },
    });
    expect(rejected.status).toBe("rejected");
    expect(await store.getDelivery("spoofed-delivery")).toBeUndefined();
    expect((await integration.receiveWebhook(request)).status).not.toBe(
      "duplicate",
    );
  });

  it("accepts a valid sha256 signature and rejects a changed body", () => {
    const body = JSON.stringify({ action: "opened" });
    const input: GitHubWebhookSignatureInput = {
      body,
      signature: sign(body, "test-secret"),
      secret: "test-secret",
    };

    expect(verifyGitHubWebhookSignature(input)).toBe(true);
    expect(verifyGitHubWebhookSignature({ ...input, body: `${body} ` })).toBe(
      false,
    );
  });

  it("fails closed for missing, malformed, and non-sha256 signatures", () => {
    const body = "{}";
    const secret = "test-secret";

    expect(verifyGitHubWebhookSignature({ body, secret })).toBe(false);
    expect(
      verifyGitHubWebhookSignature({
        body,
        secret,
        signature: "sha1=not-used",
      }),
    ).toBe(false);
    expect(
      verifyGitHubWebhookSignature({
        body,
        secret,
        signature: "sha256=too-short",
      }),
    ).toBe(false);
  });
});

describe("GitHub webhook intake", () => {
  it("routes a native sub-issue with its siblings into the parent spec delivery", async () => {
    const parent = {
      number: 100,
      title: "Planning spec",
      body: "Scope",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: ["planning-spec"],
    };
    const child = {
      number: 42,
      title: "Child",
      body: "Implement child",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: [] as string[],
    };
    const sibling = { ...child, number: 43, title: "Sibling" };
    const relationships: GitHubIssueRelationshipReader = {
      fetchIssue: async ({ issueNumber }) =>
        issueNumber === 100 ? parent : issueNumber === 42 ? child : sibling,
      fetchParentIssue: async () => parent,
      fetchSubIssues: async () => [child, sibling],
    };
    const { integration } = createIntegration(
      new InMemoryGitHubStore(),
      undefined,
      relationships,
    );
    const receipt = await integration.receiveWebhook(
      webhook("issues", "delivery-child-42", issuePayload()),
    );

    expect(receipt.ingest?.job?.deliveryKey).toEqual({
      repository,
      itemId: "100",
    });
    expect(
      receipt.event?.workflowEvent.delivery?.graph.children.map(
        (entry) => entry.itemId,
      ),
    ).toEqual(["42", "43"]);
  });

  it("recognizes a planning-spec parent declared in its body without a label", async () => {
    const parent = {
      number: 100,
      title: "Planning spec",
      body: "**Work item type:** planning spec, not executable",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: [] as string[],
    };
    const child = {
      number: 42,
      title: "Child",
      body: "Implement child",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: [] as string[],
    };
    const relationships: GitHubIssueRelationshipReader = {
      fetchIssue: async () => parent,
      fetchParentIssue: async () => parent,
      fetchSubIssues: async () => [child],
    };
    const { integration } = createIntegration(
      new InMemoryGitHubStore(),
      undefined,
      relationships,
    );
    const receipt = await integration.receiveWebhook(
      webhook("issues", "unlabelled-spec-parent", issuePayload()),
    );
    expect(receipt.ingest?.job?.deliveryKey.itemId).toBe("100");
  });

  it("uses documented parent and child body references when native links are absent", async () => {
    const parent = {
      number: 100,
      title: "Planning spec",
      body: "Shipyard-Children: #42, #43",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: ["planning-spec"],
    };
    const child = {
      number: 42,
      title: "Child",
      body: "Shipyard-Parent: #100",
      state: "open" as const,
      updatedAt: "2026-09-17T12:00:00.000Z",
      labels: [] as string[],
    };
    const sibling = { ...child, number: 43 };
    const relationships: GitHubIssueRelationshipReader = {
      fetchIssue: async ({ issueNumber }) =>
        issueNumber === 100 ? parent : issueNumber === 42 ? child : sibling,
    };
    const { integration } = createIntegration(
      new InMemoryGitHubStore(),
      undefined,
      relationships,
    );
    const payload = issuePayload({
      issue: {
        number: 42,
        title: child.title,
        body: child.body,
        state: "open",
        updated_at: child.updatedAt,
        labels: [],
      },
    });
    const receipt = await integration.receiveWebhook(
      webhook("issues", "delivery-fallback-42", payload),
    );

    expect(receipt.ingest?.job?.deliveryKey.itemId).toBe("100");
    expect(
      receipt.event?.workflowEvent.delivery?.graph.children.map(
        (entry) => entry.itemId,
      ),
    ).toEqual(["42", "43"]);
  });
  it("persists valid issue intake once and never treats issue prose as approval", async () => {
    const { integration, coordinator } = createIntegration();
    const request = webhook("issues", "delivery-1", issuePayload());

    const first = await integration.receiveWebhook(request);
    const replay = await integration.receiveWebhook(request);

    expect(first.status).toBe("accepted");
    expect(first.ingest?.disposition).toBe("accepted");
    expect(first.ingest?.job?.brief.authorization.status).toBe("pending");
    expect(replay.status).toBe("duplicate");

    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    expect(dispatch.status).toBe("dispatched");
    expect(dispatch.assignment?.phase).toBe("triage");
  });

  it("marks an explicit shipyard label re-add as a resume request", async () => {
    const { integration } = createIntegration();
    const resumed = await integration.receiveWebhook(
      webhook(
        "issues",
        "delivery-resume-label",
        issuePayload({
          action: "labeled",
          issue: {
            number: 42,
            title: "Fix the intake path",
            body: "authorization: approved",
            state: "open",
            updated_at: "2026-09-17T12:00:00.000Z",
            html_url: `https://github.com/${repository}/issues/42`,
            user: { login: "maintainer", type: "User" },
            labels: [{ name: "shipyard" }],
          },
          label: { name: "shipyard" },
        }),
      ),
    );

    expect(resumed.status).toBe("accepted");
    expect(resumed.event?.workflowEvent.resumeRequested).toBe(true);
  });

  it("projects exhausted work and clears blocked labels after explicit reclaim", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      infrastructureRetryLimit: 0,
    });
    const store = new InMemoryGitHubStore();
    const publishBlockedDelivery = vi.fn(async () => ({}));
    const resumeBlockedDelivery = vi.fn(async () => ({
      status: "already-reclaimed" as const,
    }));
    const integration = new GitHubIntegration({
      coordinator,
      policy: policy(),
      base: { branch: "main", sha: "a".repeat(40) },
      authorization: {
        allowedRepositories: [repository],
        allowedSenders: ["maintainer"],
        allowedReviewers: ["maintainer"],
      },
      deliveryStore: store,
      trackingStore: store,
      publication: {
        publishBlockedDelivery,
        resumeBlockedDelivery,
      } as unknown as GitHubPublication,
      webhookSecret: secret,
    });
    const received = await integration.receiveWebhook(
      webhook("issues", "blocked-intake", issuePayload()),
    );
    const dispatched = await coordinator.dispatchNext({
      repository,
      workerId: "worker",
    });
    const blocked = await integration.recordInfrastructureFailure({
      jobId: received.ingest!.job!.id,
      assignmentId: dispatched.assignment!.id,
      error: "worker unavailable",
      branch: "shipyard/issue-42",
    });
    expect(blocked.status).toBe("exhausted");
    expect(publishBlockedDelivery).toHaveBeenCalledOnce();

    await integration.receiveWebhook(
      webhook(
        "issues",
        "blocked-resume",
        issuePayload({
          action: "labeled",
          issue: {
            number: 42,
            title: "Fix the intake path",
            body: "authorization: approved",
            state: "open",
            updated_at: "2026-09-17T12:00:00.000Z",
            labels: [{ name: "shipyard" }, { name: "shipyard-blocked" }],
          },
          label: { name: "shipyard" },
        }),
      ),
    );
    expect(resumeBlockedDelivery).toHaveBeenCalledOnce();
    expect(
      (await coordinator.getJob(received.ingest!.job!.id))?.blocked,
    ).toBeUndefined();
  });

  it("replays a blocked projection after publication fails", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      infrastructureRetryLimit: 0,
    });
    const store = new InMemoryGitHubStore();
    const publishBlockedDelivery = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue({});
    const integration = new GitHubIntegration({
      coordinator,
      policy: policy(),
      base: { branch: "main", sha: "a".repeat(40) },
      authorization: {
        allowedRepositories: [repository],
        allowedSenders: ["maintainer"],
        allowedReviewers: ["maintainer"],
      },
      deliveryStore: store,
      trackingStore: store,
      publication: { publishBlockedDelivery } as unknown as GitHubPublication,
      webhookSecret: secret,
    });
    const received = await integration.receiveWebhook(
      webhook("issues", "blocked-intake-replay", issuePayload()),
    );
    const dispatched = await coordinator.dispatchNext({
      repository,
      workerId: "worker",
    });
    await expect(
      integration.recordInfrastructureFailure({
        jobId: received.ingest!.job!.id,
        assignmentId: dispatched.assignment!.id,
        error: "worker unavailable",
        branch: "shipyard/issue-42",
      }),
    ).rejects.toThrow("GitHub unavailable");
    await integration.receiveWebhook(
      webhook("issues", "blocked-projection-replay", issuePayload()),
    );
    expect(publishBlockedDelivery).toHaveBeenCalledTimes(2);
  });

  it("reprocesses a delivery left in received state after a coordinator failure", async () => {
    const { integration, coordinator, store } = createIntegration();
    vi.spyOn(coordinator, "ingest").mockRejectedValueOnce(
      new Error("coordinator unavailable"),
    );
    const request = webhook("issues", "delivery-retry", issuePayload());

    await expect(integration.receiveWebhook(request)).rejects.toThrow(
      "coordinator unavailable",
    );
    const retry = await integration.receiveWebhook(request);

    expect(retry.status).toBe("accepted");
    expect((await store.getDelivery("delivery-retry"))?.status).toBe(
      "accepted",
    );
  });

  it("rejects disallowed repositories and senders before coordinator intake", async () => {
    const { integration, store } = createIntegration();

    const disallowedRepository = await integration.receiveWebhook(
      webhook(
        "issues",
        "delivery-bad-repo",
        issuePayload({
          repository: { full_name: "someone-else/project" },
        }),
      ),
    );
    const disallowedSender = await integration.receiveWebhook(
      webhook(
        "issues",
        "delivery-bad-sender",
        issuePayload({
          sender: { login: "reporter", type: "User" },
        }),
      ),
    );

    expect(disallowedRepository).toMatchObject({
      status: "rejected",
      reason: "disallowed-repository",
    });
    expect(disallowedSender).toMatchObject({
      status: "rejected",
      reason: "disallowed-sender",
    });
    expect((await store.getDelivery("delivery-bad-repo"))?.status).toBe(
      "rejected",
    );
    expect((await store.getDelivery("delivery-bad-sender"))?.status).toBe(
      "rejected",
    );
  });

  it("rejects oversized webhook bodies before JSON parsing", async () => {
    const { integration, store } = createIntegration();
    const body = "x".repeat(10 * 1024 * 1024 + 1);
    const receipt = await integration.receiveWebhook({
      body,
      headers: {
        "x-github-event": "issues",
        "x-github-delivery": "delivery-too-large",
        "x-hub-signature-256": sign(body, secret),
      },
    });

    expect(receipt).toMatchObject({
      status: "rejected",
      reason: "body-too-large",
    });
    expect((await store.getDelivery("delivery-too-large"))?.payload).toBe(
      undefined,
    );
  });

  it("ignores bot loops and external PRs, but accepts updates for tracked PRs", async () => {
    const requestRepair = vi.fn(async () => undefined);
    const reviewHandler: GitHubPullRequestReviewHandler = {
      readCurrent: async ({ candidate }) => candidate,
      requestRepair,
    };
    const { integration, store } = createIntegration(
      new InMemoryGitHubStore(),
      reviewHandler,
    );
    const issue = await integration.receiveWebhook(
      webhook("issues", "delivery-issue", issuePayload()),
    );

    const bot = await integration.receiveWebhook(
      webhook(
        "issues",
        "delivery-bot",
        issuePayload({
          sender: { login: "shipyard[bot]", type: "Bot" },
        }),
      ),
    );
    expect(bot).toMatchObject({ status: "ignored", reason: "bot-originated" });

    const unrelated = await integration.receiveWebhook(
      webhook("pull_request", "delivery-external-pr", {
        action: "synchronize",
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
        pull_request: {
          number: 99,
          title: "External PR",
          body: "not tracked",
          state: "open",
          updated_at: "2026-09-17T12:00:03.000Z",
          head: { ref: "external", sha: "c".repeat(40) },
        },
      }),
    );
    expect(unrelated).toMatchObject({
      status: "ignored",
      reason: "unrelated-pull-request",
    });

    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 99,
      jobId: issue.ingest!.job!.id,
      itemId: "42",
      branch: "shipyard/issue-42",
      headSha: "b".repeat(40),
      marker: "pull-request:tracked",
      brief: issue.ingest!.job!.brief,
      policy: issue.ingest!.job!.policy,
      createdAt: "2026-09-17T12:00:02.000Z",
    });
    const tracked = await integration.receiveWebhook(
      webhook("pull_request", "delivery-tracked-pr", {
        action: "synchronize",
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
        pull_request: {
          number: 99,
          title: "Tracked PR",
          body: "candidate",
          state: "open",
          updated_at: "2026-09-17T12:00:04.000Z",
          head: { ref: "shipyard/issue-42", sha: "d".repeat(40) },
        },
      }),
    );
    expect(tracked.status).toBe("accepted");
    expect(tracked.event?.kind).toBe("tracked-pr-updated");
    expect(tracked.event?.workflowEvent.relevantRevision).toBe("d".repeat(40));

    const humanReview = await integration.receiveWebhook(
      webhook("pull_request_review", "delivery-human-review", {
        action: "submitted",
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
        pull_request: {
          number: 99,
          state: "open",
          updated_at: "2026-09-17T12:00:05.000Z",
          head: { ref: "shipyard/issue-42", sha: "d".repeat(40) },
        },
        review: {
          id: 7,
          state: "CHANGES_REQUESTED",
          commit_id: "e".repeat(40),
          submitted_at: "2026-09-17T12:00:05.000Z",
          user: { login: "maintainer", type: "User" },
          body: "Please add the missing regression test.",
        },
      }),
    );
    expect(humanReview.event?.review).toMatchObject({
      id: "7",
      state: "changes-requested",
      headSha: "e".repeat(40),
      authorLogin: "maintainer",
    });
    expect(humanReview.status).toBe("accepted");
    expect(humanReview.review?.outcome).toBe("repair-needed");
    expect(requestRepair).toHaveBeenCalledWith({
      candidate: {
        base: issue.ingest!.job!.brief.base,
        head: { branch: "shipyard/issue-42", sha: "e".repeat(40) },
        briefHash: issue.ingest!.job!.brief.hash,
      },
      pullRequestNumber: 99,
      reason: "Human review requested changes",
    });

    const unauthorizedReview = await integration.receiveWebhook(
      webhook("pull_request_review", "delivery-contributor-review", {
        action: "submitted",
        repository: { full_name: repository },
        sender: { login: "contributor", type: "User" },
        pull_request: {
          number: 99,
          state: "open",
          updated_at: "2026-09-17T12:00:06.000Z",
          head: { ref: "shipyard/issue-42", sha: "d".repeat(40) },
        },
        review: {
          id: 9,
          state: "APPROVED",
          commit_id: "d".repeat(40),
          submitted_at: "2026-09-17T12:00:06.000Z",
          user: { login: "contributor", type: "User" },
        },
      }),
    );
    expect(unauthorizedReview).toMatchObject({
      status: "rejected",
      reason: "disallowed-reviewer",
    });
  });

  it("fails closed for a tracked review without a review workflow handler", async () => {
    const { integration, store } = createIntegration();
    const issue = await integration.receiveWebhook(
      webhook("issues", "delivery-review-unconfigured-issue", issuePayload()),
    );
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 99,
      jobId: issue.ingest!.job!.id,
      itemId: "42",
      branch: "shipyard/issue-42",
      headSha: "b".repeat(40),
      marker: "pull-request:tracked",
      brief: issue.ingest!.job!.brief,
      policy: issue.ingest!.job!.policy,
      createdAt: "2026-09-17T12:00:02.000Z",
    });
    const review = await integration.receiveWebhook(
      webhook("pull_request_review", "delivery-review-unconfigured", {
        action: "submitted",
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
        pull_request: {
          number: 99,
          state: "open",
          updated_at: "2026-09-17T12:00:05.000Z",
          head: { ref: "shipyard/issue-42", sha: "d".repeat(40) },
        },
        review: {
          id: 8,
          state: "APPROVED",
          commit_id: "d".repeat(40),
          submitted_at: "2026-09-17T12:00:05.000Z",
          user: { login: "maintainer", type: "User" },
        },
      }),
    );
    expect(review).toMatchObject({
      status: "rejected",
      reason: "review-handler-unconfigured",
    });
  });

  it("does not enqueue work for a malformed tracked review event", async () => {
    const { integration, store } = createIntegration();
    const issue = await integration.receiveWebhook(
      webhook("issues", "delivery-malformed-review-issue", issuePayload()),
    );
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 99,
      jobId: issue.ingest!.job!.id,
      itemId: "42",
      branch: "shipyard/issue-42",
      headSha: "b".repeat(40),
      marker: "pull-request:tracked",
      brief: issue.ingest!.job!.brief,
      policy: issue.ingest!.job!.policy,
      createdAt: "2026-09-17T12:00:02.000Z",
    });

    const malformed = await integration.receiveWebhook(
      webhook("pull_request_review", "delivery-malformed-review", {
        action: "submitted",
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
        pull_request: {
          number: 99,
          state: "open",
          updated_at: "2026-09-17T12:00:05.000Z",
          head: { ref: "shipyard/issue-42", sha: "d".repeat(40) },
        },
      }),
    );

    expect(malformed).toMatchObject({
      status: "ignored",
      reason: "unsupported-event",
    });
    expect(malformed.ingest).toBeUndefined();
    expect((await store.getDelivery("delivery-malformed-review"))?.status).toBe(
      "ignored",
    );
  });

  it("can attach automatic triage and resume the same item from one reply", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
    });
    const triageStore = new InMemoryTriageStore();
    const investigator = {
      investigate: async ({
        clarificationReply,
      }: {
        clarificationReply?: { id: string };
      }): Promise<TriageAssessment> => ({
        category: "enhancement",
        evidence: [
          clarificationReply
            ? "The clarification resolved the scope."
            : "The source describes a bounded change.",
        ],
        relevantFiles: ["src/workflow/triage/index.ts"],
        acceptanceCriteria: ["The clarified behavior is tested."],
        exclusions: ["No external activation."],
        risk: "low",
        verification: ["npm run typecheck"],
        unresolvedQuestions: clarificationReply
          ? []
          : ["Which observable behavior should change?"],
        requirementsConfirmed: clarificationReply !== undefined,
      }),
    };
    const integration = new GitHubIntegration({
      coordinator,
      policy: policy(),
      base: { branch: "main", sha: "a".repeat(40) },
      authorization: {
        allowedRepositories: [repository],
        allowedSenders: ["maintainer"],
        allowedReviewers: ["maintainer"],
      },
      deliveryStore: new InMemoryGitHubStore(),
      trackingStore: new InMemoryGitHubStore(),
      triage: { store: triageStore, investigator },
      webhookSecret: secret,
    });
    const first = await integration.receiveWebhook(
      webhook("issues", "triage-issue", issuePayload()),
    );
    const reply = await integration.receiveWebhook(
      webhook("issue_comment", "triage-reply", {
        ...issuePayload({ action: "created" }),
        comment: {
          id: "comment-1",
          body: "The observable behavior is the issue-to-brief transition.",
          updated_at: "2026-09-17T12:01:00.000Z",
          user: { login: "maintainer", type: "User" },
        },
      }),
    );
    expect(first.ingest?.job?.brief.unresolvedQuestions).toHaveLength(1);
    expect(reply.ingest?.job?.brief.revision).toBe(2);
    expect(reply.ingest?.job?.brief.source.originalBody).toBe(
      "authorization: approved",
    );
  });

  it("freezes a planning delivery on a merge webhook before child intake", async () => {
    const { integration, coordinator, store } = createIntegration(
      new InMemoryGitHubStore(),
      undefined,
      {
        fetchIssue: async () => undefined,
        fetchParentIssue: async () => ({
          number: 100,
          title: "Planning spec",
          body: "**Work item type:** planning spec",
          state: "open",
          updatedAt: "2026-09-17T12:00:00.000Z",
          labels: [],
        }),
        fetchSubIssues: async () => [
          {
            number: 42,
            title: "Child",
            body: "Implement child",
            state: "open",
            updatedAt: "2026-09-17T12:00:00.000Z",
            labels: [],
          },
          {
            number: 43,
            title: "New child",
            body: "Implement new child",
            state: "open",
            updatedAt: "2026-09-17T12:01:00.000Z",
            labels: [],
          },
        ],
      },
    );
    const brief = createWorkBrief({
      identity: { repository, itemId: "100", kind: "planning-spec" },
      source: {
        provider: "github",
        repository,
        itemId: "100",
        originalBody: "Planning spec",
      },
      problem: "Planning spec",
      evidence: ["Authorized"],
      acceptanceCriteria: ["Done"],
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
      policyRevision: policy().revision,
      skillRevision: policy().worker.skillRevision,
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    const initial = resolveDeliveryGroup({
      issue: brief.identity,
      children: [{ repository, itemId: "42", kind: "executable-issue" }],
    });
    const received = await coordinator.ingest({
      deliveryId: "spec-before-merge",
      brief,
      policy: policy(),
      phase: "triage",
      relevantRevision: brief.base.sha,
      observedAt: "2026-09-17T12:00:00.000Z",
      delivery: initial,
      sourceState: "open",
    });
    const headSha = "b".repeat(40);
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 200,
      jobId: received.job!.id,
      itemId: "100",
      branch: "shipyard/spec-100",
      headSha,
      marker: "<!-- tracked -->",
      brief,
      policy: policy(),
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    await integration.receiveWebhook(
      webhook("pull_request", "spec-merged", {
        action: "closed",
        pull_request: {
          number: 200,
          title: "Planning spec",
          body: "Planning spec",
          state: "closed",
          merged: true,
          merge_commit_sha: "d".repeat(40),
          updated_at: "2026-09-17T12:01:00.000Z",
          head: { ref: "shipyard/spec-100", sha: headSha },
          base: { ref: "main" },
        },
        repository: { full_name: repository },
        sender: { login: "maintainer", type: "User" },
      }),
    );
    await expect(
      integration.receiveWebhook(
        webhook("issues", "new-child-after-merge", issuePayload()),
      ),
    ).rejects.toThrow("Merged delivery graph is immutable");
    expect(
      (
        await coordinator.getDeliveryWorkflowState({
          repository,
          itemId: "100",
        })
      )?.delivery.graph.children.map((entry) => entry.itemId),
    ).toEqual(["42"]);
  });

  it("reads the current PR merge state before issue reconciliation", async () => {
    const { integration, coordinator, store } = createIntegration();
    const first = await integration.receiveWebhook(
      webhook("issues", "standalone-before-merge", issuePayload()),
    );
    const job = first.ingest!.job!;
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 200,
      jobId: job.id,
      itemId: "42",
      branch: "shipyard/issue-42",
      headSha: "b".repeat(40),
      marker: "<!-- tracked -->",
      brief: job.brief,
      policy: job.policy,
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    await integration.reconcile({
      repository,
      issueNumber: 42,
      transport: {
        fetchIssue: async () => ({
          number: 42,
          title: "Fix the intake path",
          body: "authorization: approved",
          state: "open",
          updatedAt: "2026-09-17T12:01:00.000Z",
          labels: [],
        }),
        fetchPullRequest: async () => ({
          number: 200,
          title: "Issue 42",
          body: "Candidate",
          state: "closed",
          merged: true,
          mergedSha: "d".repeat(40),
          branch: "shipyard/issue-42",
          baseBranch: "main",
          headSha: "b".repeat(40),
          updatedAt: "2026-09-17T12:01:00.000Z",
        }),
      } as unknown as GitHubReadTransport,
    });
    expect(
      (await coordinator.getDelivery({ repository, itemId: "42" }))?.mergedSha,
    ).toBe("d".repeat(40));
  });

  it("fails closed when tracked PR state cannot be read during issue intake", async () => {
    const { integration, store } = createIntegration();
    const first = await integration.receiveWebhook(
      webhook("issues", "tracked-without-reader", issuePayload()),
    );
    const job = first.ingest!.job!;
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 200,
      jobId: job.id,
      itemId: "42",
      branch: "shipyard/issue-42",
      headSha: "b".repeat(40),
      marker: "<!-- tracked -->",
      brief: job.brief,
      policy: job.policy,
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    await expect(
      integration.receiveWebhook(
        webhook("issues", "unverified-pr-state", issuePayload()),
      ),
    ).rejects.toThrow("Current pull request state is required");
  });

  it("reconciles a manually merged planning-spec PR from current provider state and replays safely", async () => {
    const repositoryPolicy = policy();
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      clock: {
        now: () => "2026-09-17T12:00:00.000Z",
        nowMilliseconds: () => 0,
      },
    });
    const store = new InMemoryGitHubStore();
    const planningBrief = createWorkBrief({
      identity: { repository, itemId: "100", kind: "planning-spec" },
      source: {
        provider: "github",
        repository,
        itemId: "100",
        originalBody: "Deliver the planning spec.",
      },
      problem: "Deliver the planning spec.",
      evidence: ["The request is authorized."],
      acceptanceCriteria: ["All children are delivered."],
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
      policyRevision: repositoryPolicy.revision,
      skillRevision: repositoryPolicy.worker.skillRevision,
      createdAt: "2026-09-17T12:00:00.000Z",
    });
    const delivery = resolveDeliveryGroup({
      issue: planningBrief.identity,
      children: [{ repository, itemId: "101", kind: "executable-issue" }],
      dependencies: [],
    });
    const received = await coordinator.ingest({
      deliveryId: "planning-spec-intake",
      brief: planningBrief,
      policy: repositoryPolicy,
      phase: "triage",
      relevantRevision: planningBrief.base.sha,
      observedAt: "2026-09-17T12:00:00.000Z",
      delivery,
      sourceState: "open",
    });
    const sourceHead = "b".repeat(40);
    const mergedSha = "d".repeat(40);
    await store.saveTrackedPullRequest({
      repository,
      pullRequestNumber: 200,
      jobId: received.job!.id,
      itemId: "100",
      branch: "shipyard/spec-100",
      headSha: sourceHead,
      marker: "<!-- shipyard:pull-request:spec-100 -->",
      brief: planningBrief,
      policy: repositoryPolicy,
      createdAt: "2026-09-17T12:00:01.000Z",
    });

    let currentPullRequest = {
      number: 200,
      title: "Planning spec",
      body: serializeGitHubPublicationMetadata({
        version: 1,
        repository,
        itemId: "100",
        kind: "planning-spec",
        briefRevision: planningBrief.revision,
        briefHash: planningBrief.hash,
        baseBranch: "main",
        baseSha: planningBrief.base.sha,
        branch: "shipyard/spec-100",
        headSha: sourceHead,
      }),
      state: "open" as "open" | "closed",
      draft: false,
      branch: "shipyard/spec-100",
      baseBranch: "main",
      headSha: sourceHead,
      updatedAt: "2026-09-17T12:00:02.000Z",
      htmlUrl: "https://github.com/snappedly/shipyard/pull/200",
      merged: false,
      mergedSha: undefined as string | undefined,
      labels: ["ready-for-human"] as string[],
    };
    let parentIssue = {
      number: 100,
      title: "Planning spec",
      body: "source",
      state: "open" as "open" | "closed",
      updatedAt: "2026-09-17T12:00:02.000Z",
      labels: ["planning-spec"] as string[],
    };
    const children = new Map([
      [
        101,
        {
          number: 101,
          title: "Child",
          body: "child",
          state: "closed" as const,
          updatedAt: "2026-09-17T12:00:02.000Z",
          labels: [] as string[],
          htmlUrl: "https://github.com/snappedly/shipyard/issues/101",
        },
      ],
      [
        201,
        {
          number: 201,
          title: "Repair",
          body: "repair",
          state: "closed" as const,
          updatedAt: "2026-09-17T12:00:02.000Z",
          labels: ["shipyard:pr-repair"] as string[],
          htmlUrl: "https://github.com/snappedly/shipyard/issues/201",
        },
      ],
    ]);
    const createComment = vi.fn(async (input: { readonly body: string }) => ({
      id: `aggregate-${createComment.mock.calls.length + 1}`,
      body: input.body,
      updatedAt: "2026-09-17T12:00:03.000Z",
    }));
    const closeIssue = vi.fn(async () => {
      parentIssue = { ...parentIssue, state: "closed" };
      return parentIssue;
    });
    const transport = {
      fetchIssue: async (input: { readonly issueNumber: number }) =>
        input.issueNumber === 100
          ? parentIssue
          : children.get(input.issueNumber),
      fetchPullRequest: async () => currentPullRequest,
      findCommentByMarker: async () => undefined,
      findBranchByName: async () => undefined,
      findPullRequestByMarker: async () => undefined,
      findCheckByMarker: async () => undefined,
      findIssueByMarker: async () => undefined,
      fetchChecks: async () => [
        {
          id: "check-1",
          name: "typecheck",
          headSha: mergedSha,
          status: "completed" as const,
          conclusion: "success" as const,
        },
      ],
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
      trackingStore: store,
    });
    const handler = createGitHubPlanningSpecCompletionHandler({
      coordinator,
      publication,
      scope: {
        read: async ({ transport: current }) => {
          const child = await current.fetchIssue({
            repository,
            issueNumber: 101,
          });
          const repair = await current.fetchIssue({
            repository,
            issueNumber: 201,
          });
          return {
            originalChildren: [
              {
                number: 101,
                kind: "child" as const,
                state: child?.state ?? "open",
                htmlUrl: child?.htmlUrl,
              },
            ],
            repairChildren: [
              {
                number: 201,
                kind: "repair" as const,
                state: repair?.state ?? "open",
                htmlUrl: repair?.htmlUrl,
              },
            ],
          };
        },
      },
    });
    const integration = new GitHubIntegration({
      coordinator,
      policy: repositoryPolicy,
      base: { branch: "main", sha: "a".repeat(40) },
      authorization: {
        allowedRepositories: [repository],
        allowedSenders: ["maintainer"],
        allowedReviewers: ["maintainer"],
      },
      deliveryStore: store,
      trackingStore: store,
      planningSpecCompletion: handler,
      webhookSecret: secret,
    });
    const reconciliation = {
      repository,
      pullRequestNumber: 200,
      transport,
    };

    const premature = await integration.reconcile(reconciliation);
    expect(premature.planningSpecCompletion?.outcome).toBe("open");
    expect(premature.planningSpecCompletion?.reason).toContain("still open");

    currentPullRequest = {
      ...currentPullRequest,
      state: "closed",
    };
    const unmerged = await integration.reconcile(reconciliation);
    expect(unmerged.planningSpecCompletion?.outcome).toBe("open");
    expect(unmerged.planningSpecCompletion?.reason).toContain(
      "without a merge",
    );
    expect(parentIssue.state).toBe("open");

    currentPullRequest = {
      ...currentPullRequest,
      merged: true,
      mergedSha,
    };
    const merged = await integration.reconcile(reconciliation);
    const replay = await integration.reconcile(reconciliation);
    expect(merged.planningSpecCompletion?.outcome).toBe("completed");
    expect(replay.planningSpecCompletion?.outcome).toBe("completed");
    expect(createComment).toHaveBeenCalledOnce();
    expect(closeIssue).toHaveBeenCalledOnce();
    expect(parentIssue.state).toBe("closed");
    expect((await coordinator.getDelivery(delivery.key))?.mergedSha).toBe(
      mergedSha,
    );
  });
});
