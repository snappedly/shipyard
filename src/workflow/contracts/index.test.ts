import { describe, expect, it } from "vitest";
import {
  ContractValidationError,
  WORKFLOW_CONTRACT_VERSION,
  createAssignment,
  createRepositoryPolicy,
  createWorkBrief,
  parseCheckEvidence,
  parsePhaseResult,
  parseRepositoryPolicy,
  parseWorkBrief,
  requireTransition,
  type CheckEvidence,
  type RepositoryPolicy,
  type WorkIdentity,
} from "./index.js";

const identity: WorkIdentity = {
  repository: "snappedly/shipyard",
  itemId: "42",
  kind: "executable-issue",
};

const policy: RepositoryPolicy = {
  contractVersion: WORKFLOW_CONTRACT_VERSION,
  repository: identity.repository,
  revision: "policy-1",
  baseBranch: "main",
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["maintainer"],
    autoStartRisk: ["low"],
  },
  worker: {
    provider: "test",
    model: "fixture",
    sandbox: "test-isolated",
    skillRevision: "skills-1",
  },
  checks: [{ name: "typecheck", command: "npm run typecheck", required: true }],
  phaseBudgets: {
    triage: { maxAttempts: 1, timeoutSeconds: 300 },
    implementation: { maxAttempts: 1, timeoutSeconds: 1800 },
    checking: { maxAttempts: 1, timeoutSeconds: 900 },
    review: { maxAttempts: 1, timeoutSeconds: 900 },
    repair: { maxAttempts: 1, timeoutSeconds: 1800 },
    handoff: { maxAttempts: 1, timeoutSeconds: 300 },
    merge: { maxAttempts: 1, timeoutSeconds: 600 },
    "release-verification": { maxAttempts: 1, timeoutSeconds: 900 },
  },
  repairBudget: { maxBatches: 1, maxFollowUps: 1 },
};

const createBrief = () =>
  createWorkBrief({
    identity,
    source: {
      provider: "github",
      repository: identity.repository,
      itemId: identity.itemId,
      originalBody: "Fix the documented behavior.",
    },
    problem: "The documented behavior is missing.",
    evidence: ["The issue reproduces on the supported runtime."],
    acceptanceCriteria: ["The behavior is covered by a focused test."],
    exclusions: ["No deployment changes."],
    risk: "low",
    verification: {
      checks: ["npm test -- src/example.test.ts", "npm run typecheck"],
      artifacts: ["test output"],
    },
    unresolvedQuestions: [],
    authorization: {
      status: "approved",
      actor: "Jonathan",
      actorRole: "maintainer",
      approvedAt: "2026-09-17T12:00:00.000Z",
    },
    base: { branch: "main", sha: "a".repeat(40) },
    policyRevision: policy.revision,
    skillRevision: policy.worker.skillRevision,
    createdAt: "2026-09-17T12:00:00.000Z",
  });

describe("workflow contracts", () => {
  it("creates and verifies a versioned brief with a stable content hash", () => {
    const brief = createBrief();

    expect(brief.contractVersion).toBe(WORKFLOW_CONTRACT_VERSION);
    expect(brief.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(parseWorkBrief(brief)).toEqual(brief);
    expect(createBrief().hash).toBe(brief.hash);
  });

  it("validates policy budgets and keeps unknown checks explicit", () => {
    expect(parseRepositoryPolicy(policy)).toEqual(policy);
    expect(
      createRepositoryPolicy({
        ...policy,
        revision: "policy-2",
      }),
    ).toMatchObject({ revision: "policy-2" });
    expect(() =>
      parseRepositoryPolicy({
        ...policy,
        phaseBudgets: {
          ...policy.phaseBudgets,
          review: { maxAttempts: 0, timeoutSeconds: 900 },
        },
      }),
    ).toThrow("positive integer");
  });

  it("rejects unknown versions and completed results without evidence", () => {
    expect(() =>
      parseWorkBrief({ ...createBrief(), contractVersion: 999 }),
    ).toThrow(ContractValidationError);

    const incomplete: CheckEvidence = {
      name: "typecheck",
      command: "npm run typecheck",
      status: "unknown",
      summary: "The worker did not return a check result.",
    };
    expect(parseCheckEvidence(incomplete)).toEqual(incomplete);
    expect(() =>
      parseCheckEvidence({ ...incomplete, status: "passed", summary: "" }),
    ).toThrow(ContractValidationError);
  });

  it("does not assign planning work and requires approved executable briefs", () => {
    const planningBrief = createWorkBrief({
      ...createBrief(),
      identity: { ...identity, kind: "planning-spec" },
      hash: undefined,
    });

    expect(() =>
      createAssignment({
        id: "assignment-1",
        phase: "implementation",
        brief: planningBrief,
        policy,
        attempt: 1,
        createdAt: "2026-09-17T12:00:00.000Z",
      }),
    ).toThrow("planning spec");

    const pendingBrief = createWorkBrief({
      ...createBrief(),
      authorization: { status: "pending" },
      hash: undefined,
    });
    expect(() =>
      createAssignment({
        id: "assignment-2",
        phase: "implementation",
        brief: pendingBrief,
        policy,
        attempt: 1,
        createdAt: "2026-09-17T12:00:00.000Z",
      }),
    ).toThrow("authorization");
  });

  it("guards lifecycle transitions and rejects stale or missing evidence", () => {
    expect(() =>
      requireTransition("queued", "implementing", {
        kind: "executable-issue",
        authorization: "approved",
      }),
    ).toThrow("not allowed");

    expect(() =>
      requireTransition("authorized", "implementing", {
        kind: "executable-issue",
        authorization: "approved",
      }),
    ).not.toThrow();

    expect(() =>
      requireTransition("checking", "reviewing", {
        kind: "executable-issue",
        authorization: "approved",
        checks: [
          {
            name: "typecheck",
            command: "npm run typecheck",
            status: "unknown",
            summary: "not run",
          },
        ],
      }),
    ).toThrow("unknown");

    expect(() =>
      requireTransition("checking", "reviewing", {
        kind: "executable-issue",
        authorization: "approved",
        requiredCheckNames: ["typecheck", "test"],
        checkCandidate: {
          baseSha: "a".repeat(40),
          headSha: "b".repeat(40),
          briefHash: createBrief().hash,
        },
        checks: [
          {
            name: "typecheck",
            command: "npm run typecheck",
            status: "passed",
            summary: "ok",
            baseSha: "a".repeat(40),
            headSha: "c".repeat(40),
            briefHash: createBrief().hash,
          },
        ],
      }),
    ).toThrow("required checks");

    expect(() =>
      requireTransition("checking", "reviewing", {
        kind: "executable-issue",
        authorization: "approved",
        requiredCheckNames: ["typecheck"],
        checks: [
          {
            name: "typecheck",
            command: "npm run typecheck",
            status: "passed",
            summary: "ok",
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            briefHash: createBrief().hash,
          },
        ],
      }),
    ).toThrow("required checks");

    expect(() =>
      requireTransition("reviewing", "human-review", {
        kind: "executable-issue",
        authorization: "approved",
        checks: [
          {
            name: "typecheck",
            command: "npm run typecheck",
            status: "passed",
            summary: "ok",
          },
        ],
        review: {
          outcome: "passed",
          axes: ["standards", "spec"],
          findings: [],
          headSha: "b".repeat(40),
          briefHash: createBrief().hash,
        },
      }),
    ).not.toThrow();
  });

  it("retains explicit review axes when a review has no findings", () => {
    const result = parsePhaseResult({
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      assignmentId: "review-assignment",
      phase: "review",
      outcome: "completed",
      identity,
      briefHash: createBrief().hash,
      summary: "All requested review axes passed.",
      evidence: ["Reviewed the pinned candidate."],
      checks: [],
      commits: [],
      artifacts: [],
      questions: [],
      findings: [],
      reviewAxes: ["standards", "spec"],
      completedAt: "2026-09-17T12:00:00.000Z",
    });

    expect(result.reviewAxes).toEqual(["standards", "spec"]);
  });
});
