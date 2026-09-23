import { describe, expect, it, vi } from "vitest";
import {
  InMemoryCoordinatorStorage,
  resolveDeliveryGroup,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import type { WorkflowCoordinator as WorkflowCoordinatorType } from "../../workflow/coordinator/index.js";
import type {
  GitHubIssueSnapshot,
  GitHubPullRequestSnapshot,
  GitHubReadTransport,
  GitHubWriteTransport,
} from "./types.js";
import { parseGitHubPublicationMetadata } from "./publication.js";
import { createGitHubSpecDeliveryHost } from "./spec-delivery.js";
import { READY_FOR_HUMAN_LABEL } from "./types.js";

const repository = "snappedly/shipyard";
const base = { branch: "staging", sha: "a".repeat(40) };
const head = { branch: "shipyard/spec-100", sha: "b".repeat(40) };

const createFakeGitHub = () => {
  const issues = new Map<number, GitHubIssueSnapshot>([
    [
      100,
      {
        number: 100,
        title: "Planning spec",
        body: "Deliver the full child graph.",
        state: "open",
        updatedAt: "2026-09-23T10:00:00.000Z",
        labels: ["shipyard"],
      },
    ],
    [
      101,
      {
        number: 101,
        title: "Child task",
        body: "Implement one child.",
        state: "open",
        updatedAt: "2026-09-23T10:00:00.000Z",
        labels: ["shipyard"],
      },
    ],
  ]);
  const branches = new Map([
    [head.branch, { name: head.branch, headSha: head.sha }],
  ]);
  const pullRequests = new Map<number, GitHubPullRequestSnapshot>();
  const comments = new Map<
    number,
    { id: string; body: string; updatedAt: string }[]
  >();
  const checks = new Map<
    string,
    {
      id: string;
      name: string;
      headSha: string;
      status: "completed";
      conclusion: "success";
    }
  >();
  const transport: GitHubReadTransport & GitHubWriteTransport = {
    fetchIssue: async ({ issueNumber }) => issues.get(issueNumber),
    fetchPullRequest: async ({ pullRequestNumber }) =>
      pullRequests.get(pullRequestNumber),
    findCommentByMarker: async ({ issueNumber, marker }) =>
      comments
        .get(issueNumber)
        ?.find((comment) => comment.body.includes(marker)),
    findBranchByName: async ({ branch }) => branches.get(branch),
    findPullRequestByMarker: async ({ marker }) =>
      [...pullRequests.values()].find((pullRequest) =>
        pullRequest.body.includes(marker),
      ),
    findCheckByMarker: async ({ marker, headSha }) =>
      [...checks.values()].find(
        (check) => check.headSha === headSha && check.id === marker,
      ),
    findIssueByMarker: async ({ marker }) =>
      [...issues.values()].find((issue) => issue.body.includes(marker)),
    createComment: async ({ issueNumber, body }) => {
      const comment = {
        id: `comment-${comments.get(issueNumber)?.length ?? 0}`,
        body,
        updatedAt: "2026-09-23T10:00:00.000Z",
      };
      comments.set(issueNumber, [
        ...(comments.get(issueNumber) ?? []),
        comment,
      ]);
      return comment;
    },
    createBranch: async ({ branch, headSha }) => {
      const created = { name: branch, headSha };
      branches.set(branch, created);
      return created;
    },
    updateBranch: async ({ branch, headSha }) => {
      const updated = { name: branch, headSha };
      branches.set(branch, updated);
      return updated;
    },
    createPullRequest: async ({ title, body, branch, baseBranch, draft }) => {
      const pullRequest: GitHubPullRequestSnapshot = {
        number: 44,
        title,
        body,
        state: "open",
        draft,
        branch,
        baseBranch,
        headSha: branches.get(branch)?.headSha ?? "",
        updatedAt: "2026-09-23T10:00:01.000Z",
        labels: [],
      };
      pullRequests.set(pullRequest.number, pullRequest);
      return pullRequest;
    },
    updatePullRequest: async ({
      pullRequestNumber,
      title,
      body,
      draft,
      labels,
    }) => {
      const previous = pullRequests.get(pullRequestNumber);
      if (previous === undefined) throw new Error("Missing pull request");
      const updated = {
        ...previous,
        ...(title === undefined ? {} : { title }),
        ...(body === undefined ? {} : { body }),
        ...(draft === undefined ? {} : { draft }),
        ...(labels === undefined ? {} : { labels }),
        updatedAt: "2026-09-23T10:00:02.000Z",
      };
      pullRequests.set(pullRequestNumber, updated);
      return updated;
    },
    createCheck: async ({ name, headSha, marker }) => {
      const check = {
        id: marker,
        name,
        headSha,
        status: "completed" as const,
        conclusion: "success" as const,
      };
      checks.set(marker, check);
      return check;
    },
    createRepairIssue: async () => {
      throw new Error("unused");
    },
    closeIssue: async ({ issueNumber }) => {
      const issue = issues.get(issueNumber);
      if (issue === undefined) throw new Error("Missing issue");
      const closed = { ...issue, state: "closed" as const };
      issues.set(issueNumber, closed);
      return closed;
    },
    ensureLabel: async ({ name, color, description }) => ({
      name,
      color,
      description,
    }),
    updateIssue: async ({ issueNumber, labels }) => {
      const issue = issues.get(issueNumber);
      if (issue === undefined) throw new Error("Missing issue");
      const updated = { ...issue, labels };
      issues.set(issueNumber, updated);
      return updated;
    },
  };
  return { transport, pullRequests, issues, branches, comments };
};

const makeCoordinator = (): WorkflowCoordinatorType =>
  new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: { now: () => "2026-09-23T10:00:00.000Z", nowMilliseconds: () => 0 },
  });

const makeDelivery = () =>
  resolveDeliveryGroup({
    issue: { repository, itemId: "100", kind: "planning-spec" },
    children: [{ repository, itemId: "101", kind: "executable-issue" }],
  });

describe("GitHub spec delivery host", () => {
  it("publishes one candidate, removes activation after handoff, and retracts only after scope changes", async () => {
    const coordinator = makeCoordinator();
    const delivery = await coordinator.resolveDelivery(makeDelivery());
    const lease = await coordinator.acquireDeliveryLease({
      repository,
      key: delivery.key,
      workerId: "spec-host",
      ttlMs: 10_000,
    });
    const { transport, pullRequests, issues } = createFakeGitHub();
    const git = {
      reconcile: vi.fn(async () => ({})),
      integrateChild: vi.fn(async () => head),
    };
    const host = createGitHubSpecDeliveryHost({ coordinator, transport, git });
    const signal = new AbortController().signal;
    const pullRequest = await host.integration.ensureDraftPullRequest({
      delivery,
      candidate: head,
      base,
      integrationBranch: head.branch,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      lease,
      signal,
    });
    const candidate = {
      deliveryId: delivery.id,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      base,
      head,
      pullRequest,
    };

    const published = await host.integration.publishCandidate({
      delivery,
      candidate,
      lease,
      signal,
    });
    expect(published).toEqual({ pullRequestId: "44", head });
    await host.integration.publishHumanHandoff!({
      delivery,
      candidate,
      lease,
      signal,
    });
    expect(pullRequests.get(44)).toMatchObject({
      draft: false,
      headSha: head.sha,
      labels: [READY_FOR_HUMAN_LABEL],
    });
    expect(issues.get(100)?.labels).not.toContain("shipyard");

    const alreadyReady = await host.integration.reconcileDelivery({
      delivery,
      base,
      integrationBranch: head.branch,
      lease,
      signal,
    });
    expect(alreadyReady.pullRequest?.draft).toBe(false);
    expect(pullRequests.get(44)?.state).toBe("open");
    expect(issues.get(100)?.labels).not.toContain("shipyard");

    const resumed = await coordinator.expandDeliveryScope({
      key: delivery.key,
      addedChildren: [{ repository, itemId: "102", kind: "executable-issue" }],
    });
    const resumedState = await host.integration.reconcileDelivery({
      delivery: resumed,
      base,
      integrationBranch: head.branch,
      lease,
      signal,
    });
    expect(resumedState.pullRequest?.draft).toBe(true);
    expect(pullRequests.get(44)?.labels).toEqual([]);
  });

  it("leaves a non-draft pull request rejected when its delivery scope is unchanged", async () => {
    const coordinator = makeCoordinator();
    const delivery = await coordinator.resolveDelivery(makeDelivery());
    const lease = await coordinator.acquireDeliveryLease({
      repository,
      key: delivery.key,
      workerId: "spec-host",
      ttlMs: 10_000,
    });
    const { transport, pullRequests } = createFakeGitHub();
    const host = createGitHubSpecDeliveryHost({
      coordinator,
      transport,
      git: { reconcile: async () => ({}), integrateChild: async () => head },
    });
    const signal = new AbortController().signal;
    const specPullRequest = await host.integration.ensureDraftPullRequest({
      delivery,
      candidate: head,
      base,
      integrationBranch: head.branch,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      lease,
      signal,
    });
    pullRequests.set(44, {
      ...pullRequests.get(44)!,
      draft: false,
      labels: [READY_FOR_HUMAN_LABEL],
    });

    const state = await host.integration.reconcileDelivery({
      delivery,
      base,
      integrationBranch: head.branch,
      lease,
      signal,
    });

    expect(state.pullRequest?.draft).toBe(false);
    expect(specPullRequest.draft).toBe(true);
  });

  it("blocks the failed child, links it from the parent, and clears the label on explicit resume", async () => {
    const coordinator = makeCoordinator();
    const delivery = await coordinator.resolveDelivery(makeDelivery());
    const lease = await coordinator.acquireDeliveryLease({
      repository,
      key: delivery.key,
      workerId: "spec-host",
      ttlMs: 10_000,
    });
    const { transport, issues, comments, pullRequests } = createFakeGitHub();
    const host = createGitHubSpecDeliveryHost({
      coordinator,
      transport,
      git: { reconcile: async () => ({}), integrateChild: async () => head },
    });
    const pullRequest = await host.integration.ensureDraftPullRequest({
      delivery,
      candidate: head,
      base,
      integrationBranch: head.branch,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      lease,
      signal: new AbortController().signal,
    });
    const candidate = {
      deliveryId: delivery.id,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      base,
      head,
      pullRequest,
    };
    await host.integration.publishCandidate({
      delivery,
      candidate,
      lease,
      signal: new AbortController().signal,
    });

    await host.publishBlocked({
      delivery,
      lease,
      blockedChild: {
        repository,
        itemId: "101",
        kind: "executable-issue",
      },
      reason:
        "Worker failed: Authorization: Bearer bearer-secret token=Bearer token-secret OPENAI_API_KEY=openai-secret",
      failureEvidence: {
        phase: "implementation",
        error: "worker failed",
        attempts: 2,
        lastSuccessfulStep: "Draft pull request #44 is available",
        branch: head.branch,
        commit: head.sha,
        pullRequest: "https://github.com/snappedly/shipyard/pull/44",
        recovery: "Fix child #101, then reactivate it.",
        occurredAt: "2026-09-23T10:00:00.000Z",
      },
      candidate,
    });

    await host.publishBlocked({
      delivery,
      lease,
      blockedChild: {
        repository,
        itemId: "101",
        kind: "executable-issue",
      },
      reason:
        "Worker failed: Authorization: Bearer another-secret token=Bearer another-token OPENAI_API_KEY=another-key",
      failureEvidence: {
        phase: "implementation",
        error: "worker failed",
        attempts: 2,
        lastSuccessfulStep: "Draft pull request #44 is available",
        branch: head.branch,
        commit: head.sha,
        pullRequest: "https://github.com/snappedly/shipyard/pull/44",
        recovery: "Fix child #101, then reactivate it.",
        occurredAt: "2026-09-23T10:00:00.000Z",
      },
      candidate,
    });

    expect(issues.get(101)?.labels).toEqual(["shipyard-blocked"]);
    expect(issues.get(100)?.labels).not.toContain("shipyard-blocked");
    expect(issues.get(100)?.labels).toEqual([]);
    expect(pullRequests.get(44)).toMatchObject({
      draft: true,
      labels: ["shipyard-blocked"],
    });
    expect(comments.get(101)?.[0]?.body).toContain("Authorization=[REDACTED]");
    expect(comments.get(101)?.[0]?.body).not.toContain("bearer-secret");
    expect(comments.get(101)?.[0]?.body).not.toContain("token-secret");
    expect(comments.get(101)?.[0]?.body).not.toContain("openai-secret");
    expect(comments.get(101)?.[0]?.body).toContain(
      "- Failed phase: `implementation`",
    );
    expect(comments.get(101)?.[0]?.body).toContain("- Attempts: 2");
    expect(comments.get(101)?.[0]?.body).toContain("- Retry count: 1");
    expect(comments.get(101)?.[0]?.body).toContain(
      "- Last successful step: Draft pull request #44 is available",
    );
    expect(comments.get(101)?.[0]?.body).toContain(
      `- Branch: \`${head.branch}\``,
    );
    expect(comments.get(101)?.[0]?.body).toContain(`- Commit: \`${head.sha}\``);
    expect(comments.get(101)?.[0]?.body).toContain(
      "- Pull request: https://github.com/snappedly/shipyard/pull/44",
    );
    expect(comments.get(101)?.[0]?.body).toContain(
      "- Suggested recovery: Fix child #101, then reactivate it.",
    );
    expect(comments.get(101)).toHaveLength(1);
    expect(comments.get(100)).toHaveLength(1);
    expect(comments.get(100)?.[0]?.body).toContain("#101");

    issues.set(101, {
      ...issues.get(101)!,
      labels: ["shipyard", "shipyard-blocked"],
    });
    await host.childLifecycle.reconcileChild({
      delivery,
      child: { repository, itemId: "101", kind: "executable-issue" },
      lease,
      signal: new AbortController().signal,
    });

    expect(issues.get(101)?.labels).toEqual(["shipyard"]);
  });

  it("replays pending candidate metadata when the branch advanced before PR publication", async () => {
    const coordinator = makeCoordinator();
    const delivery = await coordinator.resolveDelivery(makeDelivery());
    const lease = await coordinator.acquireDeliveryLease({
      repository,
      key: delivery.key,
      workerId: "spec-host",
      ttlMs: 10_000,
    });
    const { transport, pullRequests, branches } = createFakeGitHub();
    const host = createGitHubSpecDeliveryHost({
      coordinator,
      transport,
      git: { reconcile: async () => ({}), integrateChild: async () => head },
    });
    const signal = new AbortController().signal;
    const original = await host.integration.ensureDraftPullRequest({
      delivery,
      candidate: head,
      base,
      integrationBranch: head.branch,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      lease,
      signal,
    });
    const candidateHead = { ...head, sha: "c".repeat(40) };
    branches.set(head.branch, {
      name: head.branch,
      headSha: candidateHead.sha,
    });
    pullRequests.set(44, {
      ...pullRequests.get(44)!,
      headSha: candidateHead.sha,
    });
    const candidate = {
      deliveryId: delivery.id,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      base,
      head: candidateHead,
      pullRequest: {
        id: original.id,
        baseBranch: base.branch,
        headBranch: candidateHead.branch,
        draft: true,
      },
    };
    await coordinator.saveSpecDeliveryCheckpoint(delivery.key, lease, {
      pullRequest: candidate.pullRequest,
      currentHead: candidateHead,
      children: [
        {
          child: { repository, itemId: "101", kind: "executable-issue" },
          status: "publishing",
          workerBase: base,
          sourceCommit: {
            branch: "shipyard/child-101",
            sha: "d".repeat(40),
          },
          candidate,
        },
      ],
    });
    const checkpointedDelivery = await coordinator.getDelivery(delivery.key);
    expect(checkpointedDelivery).toBeDefined();

    const state = await host.integration.reconcileDelivery({
      delivery: checkpointedDelivery!,
      base,
      integrationBranch: head.branch,
      lease,
      signal,
    });

    expect(state.pullRequest).toMatchObject({
      id: original.id,
      draft: true,
    });
    expect(pullRequests.get(44)?.headSha).toBe(candidateHead.sha);
    expect(
      parseGitHubPublicationMetadata(pullRequests.get(44)?.body ?? ""),
    ).toMatchObject({
      deliveryVersion: checkpointedDelivery!.version,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      baseSha: base.sha,
      headSha: candidateHead.sha,
    });
  });
});
