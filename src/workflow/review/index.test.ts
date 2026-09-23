import { describe, expect, it, vi } from "vitest";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type RevisionReference,
} from "../contracts/index.js";
import {
  runIndependentReview,
  type ReviewCandidate,
  type ReviewProvider,
  type ReviewResponse,
} from "./index.js";

const repository = "snappedly/shipyard";
const base: RevisionReference = { branch: "main", sha: "a".repeat(40) };
const head: RevisionReference = {
  branch: "shipyard/issue-13",
  sha: "b".repeat(40),
};
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
  identity: { repository, itemId: "13", kind: "executable-issue" },
  source: {
    provider: "github",
    repository,
    itemId: "13",
    originalBody: "Review the candidate.",
  },
  problem: "The candidate needs an independent review.",
  evidence: ["The implementation is ready for review."],
  acceptanceCriteria: ["Standards and spec are independently checked."],
  exclusions: [],
  risk: "medium",
  verification: { checks: ["npm run typecheck"], artifacts: [] },
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
const candidate: ReviewCandidate = { base, head, brief, policy };

const passingResponse = (
  overrides: Partial<ReviewResponse> = {},
): ReviewResponse => ({
  outcome: "passed",
  axes: ["standards", "spec"],
  findings: [],
  evidence: ["Reviewed the exact base and candidate revisions."],
  headSha: head.sha,
  baseSha: base.sha,
  briefHash: brief.hash,
  ...overrides,
});

const providerFor = (response: ReviewResponse): ReviewProvider => ({
  review: vi.fn(async () => response),
});

const readCurrent = async () => ({
  base,
  head,
  briefHash: brief.hash,
});

describe("independent review", () => {
  it("fails closed before review when no current-state reader is configured", async () => {
    const provider = providerFor(passingResponse());
    const result = await runIndependentReview({
      candidate,
      provider,
    } as unknown as Parameters<typeof runIndependentReview>[0]);

    expect(result.outcome).toBe("blocked");
    expect(result.failure?.message).toContain("current-state reader");
    expect(provider.review).not.toHaveBeenCalled();
  });

  it("does not freeze the caller's cancellation signal", async () => {
    const controller = new AbortController();
    await runIndependentReview({
      candidate,
      provider: providerFor(passingResponse()),
      readCurrent: async () => ({
        base,
        head,
        briefHash: brief.hash,
      }),
      signal: controller.signal,
    });

    expect(() => controller.abort("cancel review")).not.toThrow();
    expect(controller.signal.aborted).toBe(true);
  });

  it("keeps nested candidate identity immutable for the reviewer", async () => {
    const controller = new AbortController();
    let headMutation = true;
    let briefMutation = true;
    let seenSignal: AbortSignal | undefined;
    const result = await runIndependentReview({
      candidate,
      provider: {
        review: async (request) => {
          headMutation = Reflect.set(
            request.candidate.head as object,
            "sha",
            "reviewer-changed-head",
          );
          briefMutation = Reflect.set(
            request.candidate.brief as object,
            "hash",
            "reviewer-changed-brief",
          );
          seenSignal = request.signal;
          return passingResponse();
        },
      },
      readCurrent,
      signal: controller.signal,
    });

    expect(result.outcome).toBe("passed");
    expect(headMutation).toBe(false);
    expect(briefMutation).toBe(false);
    expect(Object.isFrozen(seenSignal)).toBe(false);
    expect(() => controller.abort("cancel review")).not.toThrow();
    expect(result.candidate.head).toEqual(head);
    expect(result.candidate.brief.hash).toBe(brief.hash);
  });

  it("passes explicit Standards and Spec axes without allowing reviewer changes", async () => {
    let seen: Parameters<ReviewProvider["review"]>[0] | undefined;
    const provider: ReviewProvider = {
      review: vi.fn(async (request) => {
        seen = request;
        return passingResponse();
      }),
    };

    const result = await runIndependentReview({
      candidate,
      provider,
      readCurrent,
    });

    expect(result.outcome).toBe("passed");
    expect(result.reviewAxes).toEqual(["standards", "spec"]);
    expect(result.findings).toEqual([]);
    expect(seen?.checkout.immutable).toBe(true);
    expect(Object.isFrozen(seen?.candidate)).toBe(true);
    expect(Object.isFrozen(seen?.checkout)).toBe(true);
  });

  it("returns actionable deduplicated spec findings", async () => {
    const finding = {
      id: "spec-gap-1",
      severity: "high" as const,
      axis: "spec" as const,
      title: "The acceptance criterion is not implemented",
      evidence: "The candidate omits the required transition.",
      location: "src/workflow/contracts/index.ts:700",
      requirement: "The approved spec requires the transition.",
      verification: "Add a transition test before handoff.",
    };
    const result = await runIndependentReview({
      candidate,
      provider: providerFor(
        passingResponse({
          outcome: "actionable-findings",
          findings: [finding, { ...finding, id: "same-finding-again" }],
        }),
      ),
      readCurrent,
    });

    expect(result.outcome).toBe("actionable-findings");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.axis).toBe("spec");
  });

  it("does not let a reviewer dispose of its own finding", async () => {
    const attemptedDisposition = await runIndependentReview({
      candidate,
      provider: providerFor(
        passingResponse({
          findings: [
            {
              id: "heuristic-1",
              severity: "high",
              axis: "spec",
              disposition: "rejected",
              title: "The requirement is missing",
              evidence: "The expected transition is absent.",
            },
          ] as never,
        }),
      ),
      readCurrent,
    });
    expect(attemptedDisposition.outcome).toBe("actionable-findings");
    expect(attemptedDisposition.findings[0]?.disposition).toBe("open");
  });

  it("blocks readiness when an axis is missing or the candidate becomes stale", async () => {
    const missing = await runIndependentReview({
      candidate,
      provider: providerFor(passingResponse({ axes: ["standards"] })),
      readCurrent,
    });
    expect(missing.outcome).toBe("incomplete");
    expect(missing.failure?.message).toContain("spec");

    let reads = 0;
    const stale = await runIndependentReview({
      candidate,
      readCurrent: async () => {
        reads += 1;
        return {
          base,
          head: reads === 1 ? head : { ...head, sha: "c".repeat(40) },
          briefHash: brief.hash,
        };
      },
      provider: providerFor(passingResponse()),
    });
    expect(stale.outcome).toBe("blocked");
    expect(stale.failure?.kind).toBe("stale-candidate");
    expect(stale.reviewAxes).toEqual([]);
    expect(stale.findings).toEqual([]);
    expect(stale.evidence).toEqual([]);
    expect(reads).toBe(2);
  });

  it("rejects malformed output, provider failure, and reviewer mutations", async () => {
    const malformed = await runIndependentReview({
      candidate,
      provider: providerFor(
        passingResponse({
          headSha: "wrong",
        }),
      ),
      readCurrent,
    });
    expect(malformed.outcome).toBe("failed");
    expect(malformed.failure?.kind).toBe("malformed");

    const providerFailure = await runIndependentReview({
      candidate,
      provider: {
        review: async () => {
          throw new Error("review worker exited");
        },
      },
      readCurrent,
    });
    expect(providerFailure.failure?.kind).toBe("provider");

    const mutation = await runIndependentReview({
      candidate,
      provider: providerFor(passingResponse({ commits: ["c".repeat(40)] })),
      readCurrent,
    });
    expect(mutation.outcome).toBe("failed");
    expect(mutation.failure?.kind).toBe("mutation");
  });
});
