import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryPolicy,
  type RepositoryPolicy,
} from "../../workflow/contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import {
  GitHubIntegration,
  InMemoryGitHubStore,
  verifyGitHubWebhookSignature,
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

  it("ignores an ambiguous triage source edit without falling back to a brief", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
    });
    const store = new InMemoryGitHubStore();
    const triageStore = new InMemoryTriageStore();
    const ingest = vi.spyOn(coordinator, "ingest");
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
      triage: {
        store: triageStore,
        investigator: {
          investigate: async (): Promise<TriageAssessment> => ({
            category: "enhancement",
            evidence: ["The request describes a bounded change."],
            relevantFiles: [],
            acceptanceCriteria: ["The requested behavior is implemented."],
            exclusions: [],
            risk: "low",
            verification: [],
            unresolvedQuestions: [],
            requirementsConfirmed: true,
          }),
        },
      },
      webhookSecret: secret,
    });
    const initialPayload = issuePayload();
    const initialIssue = initialPayload.issue as Record<string, unknown>;

    const first = await integration.receiveWebhook(
      webhook("issues", "delivery-triage-source", initialPayload),
    );
    const conflict = await integration.receiveWebhook(
      webhook(
        "issues",
        "delivery-triage-source-conflict",
        issuePayload({
          action: "edited",
          issue: {
            ...initialIssue,
            body: "Conflicting body with the same source timestamp.",
          },
        }),
      ),
    );

    expect(first.status).toBe("accepted");
    expect(conflict).toMatchObject({
      status: "ignored",
      reason: "triage-source-conflict",
    });
    expect(conflict.ingest).toBeUndefined();
    expect(ingest).toHaveBeenCalledOnce();
  });
});
