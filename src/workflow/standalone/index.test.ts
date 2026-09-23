import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Output } from "../../Output.js";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type RepositoryPolicy,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
} from "../coordinator/index.js";
import {
  createFakePhaseEngineAdapter,
  createInMemoryArtifactStore,
} from "../execution/index.js";
import {
  GitHubPublication,
  InMemoryGitHubStore,
  type GitHubBranchSnapshot,
  type GitHubCheckSnapshot,
  type GitHubCommentSnapshot,
  type GitHubIssueSnapshot,
  type GitHubPullRequestSnapshot,
  type GitHubReadTransport,
  type GitHubWriteTransport,
} from "../../integrations/github/index.js";
import { deliverStandalone } from "./index.js";

const repository = "example/repo";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const branch = "shipyard/issue-42";
const policy: RepositoryPolicy = createRepositoryPolicy({
  repository,
  revision: "policy-1",
  baseBranch: "staging",
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
  phaseBudgets: Object.fromEntries(
    [
      "triage",
      "implementation",
      "checking",
      "review",
      "repair",
      "handoff",
      "merge",
      "release-verification",
    ].map((phase) => [phase, { maxAttempts: 2, timeoutSeconds: 60 }]),
  ) as RepositoryPolicy["phaseBudgets"],
  repairBudget: { maxBatches: 1, maxFollowUps: 1 },
});

const brief = createWorkBrief({
  identity: { repository, itemId: "42", kind: "executable-issue" },
  source: {
    provider: "github",
    repository,
    itemId: "42",
    originalBody: "Implement the bounded change.",
  },
  problem: "Implement the bounded change.",
  evidence: ["Maintainer approved."],
  acceptanceCriteria: ["The change is verified."],
  exclusions: [],
  risk: "low",
  verification: { checks: ["npm run typecheck"], artifacts: [] },
  unresolvedQuestions: [],
  authorization: {
    status: "approved",
    actor: "maintainer",
    actorRole: "maintainer",
    approvedAt: "2026-09-23T00:00:00.000Z",
  },
  base: { branch: "staging", sha: baseSha },
  policyRevision: policy.revision,
  skillRevision: policy.worker.skillRevision,
  createdAt: "2026-09-23T00:00:00.000Z",
});

const harness = () => {
  const coordinator = new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: {
      now: () => "2026-09-23T00:00:00.000Z",
      nowMilliseconds: () => 0,
    },
  });
  const trackingStore = new InMemoryGitHubStore();
  const events: string[] = [];
  let remoteBranch: GitHubBranchSnapshot | undefined;
  let pr: GitHubPullRequestSnapshot | undefined;
  let issue: GitHubIssueSnapshot = {
    number: 42,
    title: "Implement the bounded change.",
    body: brief.source.originalBody,
    state: "open",
    updatedAt: "2026-09-23T00:00:00.000Z",
    labels: ["shipyard"],
  };
  const comments: GitHubCommentSnapshot[] = [];
  const checks: GitHubCheckSnapshot[] = [];
  const transport: GitHubReadTransport & GitHubWriteTransport = {
    fetchIssue: async () => issue,
    fetchPullRequest: async () => pr,
    findCommentByMarker: async ({ marker }) =>
      comments.find((comment) => comment.body.includes(marker)),
    findBranchByName: async () => remoteBranch,
    findPullRequestByMarker: async ({ marker }) =>
      pr?.body.includes(marker) ? pr : undefined,
    findCheckByMarker: async ({ marker }) =>
      checks.find((check) => check.id === marker),
    findIssueByMarker: async () => undefined,
    createComment: async ({ body }) => {
      events.push("comment");
      const comment = {
        id: String(comments.length + 1),
        body,
        updatedAt: "2026-09-23T00:00:00.000Z",
      };
      comments.push(comment);
      return comment;
    },
    createBranch: async ({ branch: name, headSha: sha }) => {
      events.push("branch");
      remoteBranch = { name, headSha: sha };
      return remoteBranch;
    },
    createPullRequest: async ({
      title,
      body,
      branch: name,
      baseBranch,
      draft,
    }) => {
      events.push("draft-pr");
      pr = {
        number: 7,
        title,
        body,
        state: "open",
        draft,
        branch: name,
        baseBranch,
        headSha,
        updatedAt: "2026-09-23T00:00:00.000Z",
        labels: [],
      };
      return pr;
    },
    updatePullRequest: async ({ draft, labels }) => {
      events.push("handoff");
      pr = { ...pr!, draft: draft ?? pr!.draft, labels: labels ?? pr!.labels };
      return pr;
    },
    createCheck: async ({ name, headSha: sha, marker, status, conclusion }) => {
      events.push("check");
      const check = { id: marker, name, headSha: sha, status, conclusion };
      checks.push(check);
      return check;
    },
    createRepairIssue: async () => {
      throw new Error("unused");
    },
    closeIssue: async () => {
      events.push("close-issue");
      issue = { ...issue, state: "closed" };
      return issue;
    },
  };
  return {
    coordinator,
    publication: new GitHubPublication({
      coordinator,
      transport,
      trackingStore,
    }),
    events,
    readCurrent: async () => ({
      base: brief.base,
      head: { branch, sha: pr?.headSha ?? headSha },
      briefHash: brief.hash,
    }),
  };
};

describe("canonical standalone delivery", () => {
  it("reviews, closes, and hands off one remotely published candidate", async () => {
    const state = harness();
    const review = vi.fn(async () => ({
      outcome: "passed" as const,
      axes: ["standards", "spec"] as const,
      findings: [],
      evidence: ["Current candidate passes review."],
      baseSha,
      headSha,
      briefHash: brief.hash,
      commits: [],
      changedFiles: [],
    }));
    const options = {
      coordinator: state.coordinator,
      publication: state.publication,
      brief,
      policy,
      workerId: "worker-1",
      issueNumber: 42,
      branch,
      execution: {
        trusted: {
          brief,
          policy,
          skill: {
            revision: "skills-1",
            content: "Implement only this issue.",
          },
        },
        untrusted: {
          sourceText: brief.source.originalBody,
          repositoryContent: [],
        },
        controls: {
          toolAllowlist: [],
          credentialAllowlist: [],
          timeoutSeconds: 60,
          maxIterations: 1,
        },
        adapter: createFakePhaseEngineAdapter({
          response: {
            stdout: '<phase-result>{"outcome":"completed"}</phase-result>',
            completionSignal: "COMPLETE",
            commits: [headSha],
            branch,
            headSha,
            report: {
              summary: "Implemented the bounded change.",
              evidence: ["The change is verified."],
              checks: [
                {
                  name: "typecheck",
                  command: "npm run typecheck",
                  status: "passed",
                  summary: "passed",
                },
              ],
              commits: [headSha],
              artifacts: [],
              questions: [],
              findings: [],
            },
          },
        }),
        artifactStore: createInMemoryArtifactStore(),
        credentialResolver: { resolve: async () => undefined },
        output: Output.object({
          tag: "phase-result",
          schema: z.object({ outcome: z.literal("completed") }),
        }),
      },
      review: { review },
      readCurrent: state.readCurrent,
      cleanup: async () => {
        state.events.push("cleanup");
        return true;
      },
    } as const;
    const result = await deliverStandalone(options);
    const replay = await deliverStandalone(options);

    expect(result.outcome).toBe("ready-for-human");
    expect(replay.outcome).toBe("ready-for-human");
    expect(state.events.indexOf("cleanup")).toBeLessThan(
      state.events.indexOf("handoff"),
    );
    expect(state.events).not.toContain("close-issue");
    expect(state.events.filter((event) => event === "handoff")).toHaveLength(1);
    expect(review).toHaveBeenCalledOnce();
  });
});
