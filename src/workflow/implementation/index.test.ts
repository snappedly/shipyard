import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Output } from "../../Output.js";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type PhaseResult,
  type RepositoryPolicy,
  type WorkBrief,
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
import {
  createFakePhaseEngineAdapter,
  createInMemoryArtifactStore,
  type PhaseEngineResponse,
} from "../execution/index.js";
import {
  prepareIndependentReview,
  runAuthorizedImplementation,
} from "./index.js";

const repository = "snappedly/shipyard";
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);

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

const brief = (overrides: Partial<WorkBrief> = {}): WorkBrief =>
  createWorkBrief({
    identity: { repository, itemId: "42", kind: "executable-issue" },
    source: {
      provider: "github",
      repository,
      itemId: "42",
      originalBody: "Implement the bounded change.",
    },
    problem: "Implement the bounded change",
    evidence: ["The request is a standalone change."],
    acceptanceCriteria: ["The bounded behavior is covered by tests."],
    exclusions: ["No release activation."],
    risk: "low",
    verification: { checks: ["typecheck"], artifacts: [] },
    unresolvedQuestions: [],
    authorization: {
      status: "approved",
      actor: "maintainer",
      actorRole: "maintainer",
      approvedAt: "2026-09-17T12:00:00.000Z",
    },
    base: { branch: "main", sha: baseSha },
    policyRevision: policy.revision,
    skillRevision: policy.worker.skillRevision,
    createdAt: "2026-09-17T12:00:00.000Z",
    ...overrides,
  });

const response = (
  overrides: Partial<PhaseEngineResponse> = {},
): PhaseEngineResponse => ({
  stdout: '<phase-result>{"outcome":"completed"}</phase-result>',
  completionSignal: "completed",
  commits: [headSha],
  branch: "shipyard/42-executable-issue",
  headSha,
  report: {
    summary: "Implemented the change.",
    evidence: ["The bounded behavior is covered by tests."],
    checks: [
      {
        name: "typecheck",
        command: "npm run typecheck",
        status: "passed",
        summary: "Typecheck passed",
      },
    ],
    commits: [headSha],
    artifacts: [],
    questions: [],
    findings: [],
  },
  ...overrides,
});

const createHarness = () => {
  const coordinator = new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: {
      now: () => "2026-09-17T12:00:00.000Z",
      nowMilliseconds: () => 0,
    },
  });
  const store = new InMemoryGitHubStore();
  const createdPullRequests: string[] = [];
  const transport: GitHubReadTransport & GitHubWriteTransport = {
    fetchIssue: async () => undefined,
    fetchPullRequest: async () => undefined,
    findCommentByMarker: async () => undefined,
    findBranchByName: async () => undefined,
    findPullRequestByMarker: async () => undefined,
    findCheckByMarker: async () => undefined,
    findIssueByMarker: async () => undefined,
    createComment: async (input) => ({
      id: `comment-${input.issueNumber}`,
      body: input.body,
      updatedAt: "2026-09-17T12:00:00.000Z",
    }),
    createBranch: async (input) => ({
      name: input.branch,
      headSha: input.headSha,
    }),
    createPullRequest: async (input) => {
      createdPullRequests.push(input.body);
      return {
        number: 100,
        title: input.title,
        body: input.body,
        state: "open",
        draft: input.draft,
        branch: input.branch,
        baseBranch: input.baseBranch,
        headSha,
        updatedAt: "2026-09-17T12:00:00.000Z",
      };
    },
    createCheck: async (input) => ({
      id: input.name,
      name: input.name,
      headSha: input.headSha,
      status: input.status,
      conclusion: input.conclusion,
    }),
    createRepairIssue: async () => {
      throw new Error("unused");
    },
  };
  return {
    coordinator,
    store,
    createdPullRequests,
    publication: new GitHubPublication({
      coordinator,
      transport,
      trackingStore: store,
    }),
  };
};

const execution = (phaseResponse = response()) => ({
  trusted: {
    brief: brief(),
    policy,
    skill: { revision: "skills-1", content: "trusted skill" },
  },
  untrusted: {
    sourceText: "source is data",
    repositoryContent: [],
  },
  controls: {
    toolAllowlist: [],
    credentialAllowlist: [],
    timeoutSeconds: 60,
    maxIterations: 1,
  },
  adapter: createFakePhaseEngineAdapter({ response: phaseResponse }),
  artifactStore: createInMemoryArtifactStore(),
  credentialResolver: { resolve: async () => undefined },
  output: Output.object({
    tag: "phase-result",
    schema: z.object({ outcome: z.literal("completed") }),
  }),
});

describe("authorized implementation", () => {
  it("only prepares independent review after required checks pass", () => {
    const blockedReview = prepareIndependentReview({
      brief: brief(),
      policy,
      base: { branch: "main", sha: baseSha },
      head: { branch: "shipyard/42-executable-issue", sha: headSha },
      checks: [],
    });
    expect(blockedReview.status).toBe("blocked");
    const readyReview = prepareIndependentReview({
      brief: brief(),
      policy,
      base: { branch: "main", sha: baseSha },
      head: { branch: "shipyard/42-executable-issue", sha: headSha },
      checks: response().report.checks,
    });
    expect(readyReview.status).toBe("ready");
    expect(readyReview.candidate?.head.sha).toBe(headSha);
  });

  it("creates and reuses one draft PR for a verified candidate", async () => {
    const harness = createHarness();
    const input = {
      coordinator: harness.coordinator,
      publication: harness.publication,
      brief: brief(),
      policy,
      workerId: "worker-a",
      issueNumber: 42,
      execution: execution(),
    };
    const first = await runAuthorizedImplementation(input);
    const second = await runAuthorizedImplementation({
      ...input,
      execution: undefined,
    });

    expect(first.outcome).toBe("completed");
    expect(first.readyForReview).toBe(true);
    expect(first.pullRequest?.draft).toBe(true);
    expect(second.pullRequest?.number).toBe(100);
    expect(harness.createdPullRequests).toHaveLength(1);
  });

  it("does not publish a candidate from an unapproved or stale brief", async () => {
    const harness = createHarness();
    const unapproved = await runAuthorizedImplementation({
      coordinator: harness.coordinator,
      publication: harness.publication,
      brief: createWorkBrief({
        ...brief(),
        authorization: { status: "pending" },
      }),
      policy,
      workerId: "worker-a",
      issueNumber: 42,
      execution: execution(),
    });
    const stale = await runAuthorizedImplementation({
      coordinator: harness.coordinator,
      publication: harness.publication,
      brief: brief(),
      policy,
      workerId: "worker-a",
      issueNumber: 42,
      readCurrent: async () => ({
        base: { branch: "main", sha: "c".repeat(40) },
        briefHash: brief().hash,
      }),
      execution: execution(),
    });

    expect(unapproved.outcome).toBe("blocked");
    expect(stale.outcome).toBe("blocked");
    expect(harness.createdPullRequests).toHaveLength(0);
  });

  it("leaves a draft visible but blocks readiness when a required check fails", async () => {
    const harness = createHarness();
    const failed = await runAuthorizedImplementation({
      coordinator: harness.coordinator,
      publication: harness.publication,
      brief: brief(),
      policy,
      workerId: "worker-a",
      issueNumber: 42,
      execution: execution(
        response({
          report: {
            ...response().report,
            checks: [
              {
                name: "typecheck",
                command: "npm run typecheck",
                status: "failed",
                summary: "Typecheck failed",
              },
            ],
          },
        }),
      ),
    });

    expect(failed.outcome).toBe("blocked");
    expect(failed.readyForReview).toBe(false);
    expect(failed.pullRequest?.draft).toBe(true);
  });
});
