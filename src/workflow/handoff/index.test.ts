import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_CONTRACT_VERSION,
  createRepositoryPolicy,
  createWorkBrief,
  type CheckEvidence,
  type RepositoryPolicy,
  type ReviewEvidence,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
  type WorkflowJob,
} from "../coordinator/index.js";
import {
  completePlanningSpec,
  completeSourceIssue,
  completeStandaloneIssue,
  closeStandaloneSourceIssue,
  closeSourceIssue,
  evaluateHandoffReadiness,
  formatPlanningSpecCompletionComment,
  invalidateCandidateEvidence,
  mergeProtectedCandidate,
  prepareHumanHandoff,
  processHumanReviewDecision,
  resolveHumanReviewDecision,
} from "./index.js";

const repository = "snappedly/shipyard";
const base = { branch: "main", sha: "a".repeat(40) };
const head = { branch: "shipyard/42", sha: "b".repeat(40) };
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
    originalBody: "Do it",
  },
  problem: "Implement the change",
  evidence: ["The request is approved."],
  acceptanceCriteria: ["The change is verified."],
  exclusions: ["No release automation."],
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
const check: CheckEvidence = {
  name: "typecheck",
  command: "npm run typecheck",
  status: "passed",
  summary: "passed",
  baseSha: base.sha,
  headSha: head.sha,
  briefHash: brief.hash,
};
const review: ReviewEvidence = {
  outcome: "passed",
  axes: ["standards", "spec"],
  findings: [],
  headSha: head.sha,
  baseSha: base.sha,
  briefHash: brief.hash,
};

const job = async (): Promise<WorkflowJob> => {
  const coordinator = new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: { now: () => "2026-09-17T12:00:00.000Z", nowMilliseconds: () => 0 },
  });
  const result = await coordinator.ingest({
    deliveryId: "handoff-42",
    brief,
    policy,
    phase: "implementation",
    relevantRevision: base.sha,
    observedAt: "2026-09-17T12:00:00.000Z",
  });
  return {
    ...result.job!,
    phaseResults: [
      {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: "implementation-42",
        phase: "implementation",
        outcome: "completed",
        identity: brief.identity,
        briefHash: brief.hash,
        base,
        head,
        summary: "Implemented the change.",
        evidence: ["The implementation satisfies the acceptance criterion."],
        checks: [],
        commits: [head.sha],
        artifacts: [],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:00.000Z",
      },
    ],
  };
};

describe("handoff gates", () => {
  it("invalidates checks and review evidence after pre-merge scope changes", () => {
    const invalidated = invalidateCandidateEvidence({
      candidate: {
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      },
      checks: [check],
      review,
      reason: "A new child was added before merge",
    });
    expect(invalidated.invalidated).toBe(true);
    expect(invalidated.checks[0]?.status).toBe("unknown");
    expect(invalidated.checks[0]?.summary).toContain("new child");
    expect(invalidated.review).toBeUndefined();
  });

  it("blocks stale checks, missing review axes, and actionable findings", async () => {
    const currentJob = await job();
    const missing = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [],
      review: { ...review, axes: ["standards"], outcome: "incomplete" },
    });
    expect(missing.outcome).toBe("blocked");
    expect(missing.reasons.join(" ")).toContain("typecheck");
    expect(missing.reasons.join(" ")).toContain("spec");

    const stale = evaluateHandoffReadiness({
      job: currentJob,
      candidate: {
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      },
      checks: [check],
      review,
    });
    expect(stale.outcome).toBe("blocked");
    expect(stale.reasons.join(" ")).toContain("candidate head");

    const staleCheck = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [{ ...check, headSha: "c".repeat(40) }],
      review,
    });
    expect(staleCheck.outcome).toBe("blocked");
    expect(staleCheck.reasons.join(" ")).toContain("stale");

    const missingReviewBase = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review: { ...review, baseSha: undefined },
    });
    expect(missingReviewBase.outcome).toBe("blocked");
    expect(missingReviewBase.reasons.join(" ")).toContain("base revision");

    const emptyAxisSelection = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review: { ...review, axes: [] },
      requiredAxes: [],
    });
    expect(emptyAxisSelection.outcome).toBe("blocked");
    expect(emptyAxisSelection.reasons.join(" ")).toContain("standards");

    const partialAxisSelection = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review: { ...review, axes: ["standards"] },
      requiredAxes: ["standards"],
    });
    expect(partialAxisSelection.outcome).toBe("blocked");
    expect(partialAxisSelection.reasons.join(" ")).toContain("spec");

    const staleImplementationEvidence = evaluateHandoffReadiness({
      job: {
        ...currentJob,
        phaseResults: currentJob.phaseResults.map((result) => ({
          ...result,
          briefHash: "f".repeat(64),
        })),
      },
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
    });
    expect(staleImplementationEvidence.outcome).toBe("blocked");
    expect(staleImplementationEvidence.reasons.join(" ")).toContain(
      "acceptance evidence",
    );
  });

  it("requests human review only for a current, clean candidate", async () => {
    const currentJob = await job();
    const requestReview = vi.fn(async () => undefined);
    const result = await prepareHumanHandoff({
      job: currentJob,
      sourceIssueNumber: 42,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
      publisher: { requestReview },
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
    });
    expect(result.outcome).toBe("review-requested");
    expect(requestReview).toHaveBeenCalledOnce();
    expect(result.packet.pullRequest).toBe("#100");
    expect(result.packet.acceptanceCriteria).toEqual(brief.acceptanceCriteria);
    expect(result.packet.acceptanceEvidence).toEqual([
      "The implementation satisfies the acceptance criterion.",
    ]);
    expect(result.packet.acceptanceEvidence).not.toEqual(brief.evidence);

    const readiness = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
    });
    expect(readiness.outcome).toBe("ready-for-review");

    const repairedHead = {
      branch: head.branch,
      sha: "c".repeat(40),
    };
    const repairedJob = {
      ...currentJob,
      phaseResults: [
        ...currentJob.phaseResults,
        {
          ...currentJob.phaseResults[0]!,
          assignmentId: "repair-42",
          phase: "repair" as const,
          head: repairedHead,
          evidence: ["The repaired candidate satisfies the criterion."],
        },
        {
          ...currentJob.phaseResults[0]!,
          assignmentId: "checking-42",
          phase: "checking" as const,
          head: repairedHead,
          evidence: ["The required check passed."],
        },
      ],
    };
    const repaired = evaluateHandoffReadiness({
      job: repairedJob,
      candidate: { base, head: repairedHead, briefHash: brief.hash },
      checks: [{ ...check, headSha: repairedHead.sha }],
      review: { ...review, headSha: repairedHead.sha },
    });
    expect(repaired.outcome).toBe("ready-for-review");
    expect(repaired.packet.acceptanceEvidence).toEqual([
      "The repaired candidate satisfies the criterion.",
    ]);
  });

  it("returns a changes-requested decision to repair on the same PR", async () => {
    const currentJob = await job();
    const requestRepair = vi.fn(async () => undefined);
    const result = await processHumanReviewDecision({
      candidate: { base, head, briefHash: brief.hash },
      pullRequestNumber: 100,
      decision: {
        decision: "changes-requested",
        reason: "The acceptance behavior needs one more regression test.",
      },
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
      requestRepair,
    });

    expect(result.outcome).toBe("repair-needed");
    expect(result.pullRequestNumber).toBe(100);
    expect(requestRepair).toHaveBeenCalledWith({
      candidate: { base, head, briefHash: brief.hash },
      pullRequestNumber: 100,
      reason: "The acceptance behavior needs one more regression test.",
    });

    const stale = await processHumanReviewDecision({
      candidate: { base, head, briefHash: brief.hash },
      pullRequestNumber: 100,
      decision: { decision: "approved" },
      readCurrent: async () => ({
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      }),
      requestRepair: async () => undefined,
    });
    expect(stale.outcome).toBe("blocked");
    expect(stale.reason).toContain("candidate");
  });

  it("requires exact human approval and post-merge checks before completion", async () => {
    const currentJob = await job();
    const transport = {
      mergeProtected: vi.fn(async () => ({ mergedSha: head.sha })),
    };
    const missingApproval = await mergeProtectedCandidate({
      job: currentJob,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
      readBranchProtection: async () => ({
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "2026-09-17T12:00:00.000Z",
      }),
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: "c".repeat(40),
        briefHash: brief.hash,
      },
      transport,
    });
    expect(missingApproval.outcome).toBe("blocked");
    expect(transport.mergeProtected).not.toHaveBeenCalled();

    const staleCandidate = await mergeProtectedCandidate({
      job: currentJob,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
      readCurrent: async () => ({
        base,
        head: { ...head, sha: "c".repeat(40) },
        briefHash: brief.hash,
      }),
      readBranchProtection: async () => ({
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "2026-09-17T12:00:00.000Z",
      }),
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: head.sha,
        briefHash: brief.hash,
      },
      transport,
    });
    expect(staleCandidate.outcome).toBe("blocked");
    expect(staleCandidate.reason).toContain("current candidate");
    expect(transport.mergeProtected).not.toHaveBeenCalled();

    const staleProtectionEvidence = await mergeProtectedCandidate({
      job: currentJob,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
      now: () => "2026-09-17T12:00:00.000Z",
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
      readBranchProtection: async () => ({
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "not-a-timestamp",
      }),
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: head.sha,
        briefHash: brief.hash,
      },
      transport,
    });
    expect(staleProtectionEvidence.outcome).toBe("blocked");
    expect(staleProtectionEvidence.reason).toContain("freshly verified");
    expect(transport.mergeProtected).not.toHaveBeenCalled();

    const staleReadiness = evaluateHandoffReadiness({
      job: currentJob,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      review,
      now: () => "2026-09-17T12:10:00.000Z",
      branchProtection: {
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "2026-09-17T12:00:00.000Z",
      },
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: head.sha,
        briefHash: brief.hash,
      },
    });
    expect(staleReadiness.mergeReady).toBe(false);

    const staleApproval = await mergeProtectedCandidate({
      job: currentJob,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      now: () => "2026-09-17T12:10:00.000Z",
      freshnessWindowSeconds: 300,
      review,
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
      readBranchProtection: async () => ({
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "2026-09-17T12:10:00.000Z",
      }),
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: head.sha,
        briefHash: brief.hash,
      },
      transport,
    });
    expect(staleApproval.outcome).toBe("blocked");
    expect(staleApproval.reason).toContain("approval evidence");
    expect(transport.mergeProtected).not.toHaveBeenCalled();

    const merged = await mergeProtectedCandidate({
      job: currentJob,
      pullRequestNumber: 100,
      candidate: { base, head, briefHash: brief.hash },
      checks: [check],
      now: () => "2026-09-17T12:00:00.000Z",
      review,
      readCurrent: async () => ({ base, head, briefHash: brief.hash }),
      readBranchProtection: async () => ({
        enforced: true,
        humanApprovalRequired: true,
        provider: "github",
        verifiedAt: "2026-09-17T12:00:00.000Z",
      }),
      humanApproval: {
        actor: "maintainer",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
        baseSha: base.sha,
        headSha: head.sha,
        briefHash: brief.hash,
      },
      transport,
    });
    expect(merged.outcome).toBe("merged");
    expect(
      completeSourceIssue({
        policy,
        mergedSha: "d".repeat(40),
        candidate: { base, head, briefHash: brief.hash },
        checks: [{ ...check, headSha: "d".repeat(40) }],
      }).outcome,
    ).toBe("completed");
    expect(
      completeSourceIssue({
        policy,
        mergedSha: head.sha,
        candidate: { base, head, briefHash: brief.hash },
        checks: [{ ...check, status: "failed" }],
      }).outcome,
    ).toBe("open");

    const closeIssue = vi.fn(async () => undefined);
    const closed = await closeSourceIssue({
      policy,
      sourceIssueNumber: 42,
      mergedSha: "d".repeat(40),
      candidate: { base, head, briefHash: brief.hash },
      checks: [{ ...check, headSha: "d".repeat(40) }],
      closer: { closeIssue },
    });
    expect(closed.outcome).toBe("completed");
    expect(closed.closed).toBe(true);
    expect(closeIssue).toHaveBeenCalledWith({
      issueNumber: 42,
      mergedSha: "d".repeat(40),
      checks: [{ ...check, headSha: "d".repeat(40) }],
    });

    const notClosed = await closeSourceIssue({
      policy,
      sourceIssueNumber: 42,
      mergedSha: head.sha,
      candidate: { base, head, briefHash: brief.hash },
      checks: [{ ...check, status: "failed" }],
      closer: { closeIssue },
    });
    expect(notClosed.outcome).toBe("open");
    expect(notClosed.closed).toBe(false);
    expect(closeIssue).toHaveBeenCalledOnce();
    expect(
      resolveHumanReviewDecision({ decision: "changes-requested" }).outcome,
    ).toBe("repair-needed");
  });

  it("closes a standalone issue only after remote publication, checks, and cleanup", async () => {
    const published = {
      branch: head.branch,
      headSha: head.sha,
      pullRequestNumber: 100,
      state: "open" as const,
    };
    const input = {
      policy,
      candidate: { base, head, briefHash: brief.hash },
      published,
      commitSha: head.sha,
      checks: [check],
      cleanupCompleted: true,
    };
    expect(completeStandaloneIssue(input).outcome).toBe("completed");

    const closeIssue = vi.fn(async (input: { readonly comment: string }) => {
      void input;
    });
    const closed = await closeStandaloneSourceIssue({
      ...input,
      sourceIssueNumber: 42,
      closer: { closeIssue },
    });
    expect(closed).toMatchObject({ outcome: "completed", closed: true });
    expect(closeIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        issueNumber: 42,
        commitSha: head.sha,
        pullRequestNumber: 100,
        branch: head.branch,
      }),
    );
    const closureInput = closeIssue.mock.calls[0]?.[0];
    expect(closureInput?.comment).toContain(`#${published.pullRequestNumber}`);

    expect(
      completeStandaloneIssue({ ...input, cleanupCompleted: false }).reason,
    ).toContain("cleanup");
    expect(
      completeStandaloneIssue({
        ...input,
        published: { ...published, headSha: "c".repeat(40) },
      }).reason,
    ).toContain("current candidate");
    expect(
      completeStandaloneIssue({
        ...input,
        checks: [{ ...check, headSha: "c".repeat(40) }],
      }).reason,
    ).toContain("stale");
  });

  it("keeps an aggregate planning spec open until the exact merged candidate is complete", () => {
    const mergedSha = "d".repeat(40);
    const expected = {
      repository,
      itemId: "100",
      kind: "planning-spec" as const,
      briefRevision: 3,
      briefHash: "f".repeat(64),
      baseBranch: "main",
      baseSha: base.sha,
      branch: "shipyard/spec-100",
      headSha: head.sha,
    };
    const candidate = {
      metadata: expected,
      pullRequestNumber: 200,
      pullRequestUrl: "https://github.com/snappedly/shipyard/pull/200",
      state: "closed" as const,
      draft: false,
      merged: true,
      mergedSha,
      branch: expected.branch,
      baseBranch: expected.baseBranch,
      headSha: expected.headSha,
    };
    const checks = [
      {
        name: "typecheck",
        command: "npm run typecheck",
        status: "passed" as const,
        summary: "passed on the merged revision",
        baseSha: base.sha,
        headSha: mergedSha,
        briefHash: expected.briefHash,
      },
    ];
    const originalChildren = [
      { number: 101, kind: "child" as const, state: "closed" as const },
    ];
    const repairChildren = [
      {
        number: 201,
        kind: "repair" as const,
        state: "closed" as const,
        htmlUrl: "https://github.com/snappedly/shipyard/issues/201",
      },
    ];
    const input = {
      policy,
      parentIssueNumber: 100,
      expected,
      candidate,
      checks,
      originalChildren,
      repairChildren,
    };

    expect(
      completePlanningSpec({
        ...input,
        candidate: { ...candidate, state: "open" },
      }),
    ).toMatchObject({
      outcome: "open",
      reason: "Integration pull request is still open",
    });
    expect(
      completePlanningSpec({
        ...input,
        candidate: { ...candidate, merged: false },
      }).reason,
    ).toContain("without a merge");
    expect(
      completePlanningSpec({
        ...input,
        originalChildren: [{ ...originalChildren[0]!, state: "open" }],
      }).reason,
    ).toContain("Child issue #101");
    expect(
      completePlanningSpec({
        ...input,
        checks: [{ ...checks[0]!, status: "failed" }],
      }).reason,
    ).toContain("typecheck is failed");
    expect(
      completePlanningSpec({
        ...input,
        blockers: [{ id: "repair:201", active: true, reason: "blocked" }],
      }).reason,
    ).toContain("repair:201");

    const completed = completePlanningSpec(input);
    expect(completed).toMatchObject({ outcome: "completed", mergedSha });
    expect(
      formatPlanningSpecCompletionComment({
        pullRequestNumber: candidate.pullRequestNumber,
        pullRequestUrl: candidate.pullRequestUrl,
        mergedSha,
        originalChildren: completed.originalChildren,
        repairChildren: completed.repairChildren,
      }),
    ).toEqual(
      [
        "Shipyard completed the planning-spec delivery.",
        "- Pull request: [#200](https://github.com/snappedly/shipyard/pull/200)",
        `- Merged revision: \`${mergedSha}\``,
        "- Child issues: #101",
        "- Repair issues: [#201](https://github.com/snappedly/shipyard/issues/201)",
      ].join("\n"),
    );
  });
});
