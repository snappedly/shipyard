import { describe, expect, it } from "vitest";
import {
  InMemoryCoordinatorStorage,
  resolveDeliveryGroup,
  WorkflowCoordinator,
} from "../coordinator/index.js";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type RepositoryPolicy,
  type RevisionReference,
  type WorkIdentity,
} from "../contracts/index.js";
import {
  deliverSpec,
  expandSpecDeliveryScope,
  planSpecDelivery,
  reviewAxesForRisk,
  type SpecChildWorker,
  type SpecDeliveryOptions,
  type SpecIntegrationAdapter,
  type SpecReviewProvider,
  type SpecVerificationAdapter,
} from "./index.js";

const repository = "snappedly/shipyard";
const base: RevisionReference = { branch: "staging", sha: "a".repeat(40) };

const phaseBudgets: RepositoryPolicy["phaseBudgets"] = {
  triage: { maxAttempts: 1, timeoutSeconds: 60 },
  implementation: { maxAttempts: 1, timeoutSeconds: 60 },
  checking: { maxAttempts: 1, timeoutSeconds: 60 },
  review: { maxAttempts: 1, timeoutSeconds: 60 },
  repair: { maxAttempts: 1, timeoutSeconds: 60 },
  handoff: { maxAttempts: 1, timeoutSeconds: 60 },
  merge: { maxAttempts: 1, timeoutSeconds: 60 },
  "release-verification": { maxAttempts: 1, timeoutSeconds: 60 },
};

const policy = createRepositoryPolicy({
  repository,
  revision: "policy-1",
  baseBranch: base.branch,
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["maintainer"],
    autoStartRisk: ["low", "medium", "high", "critical"],
  },
  worker: {
    provider: "fixture",
    model: "fixture",
    sandbox: "fixture",
    skillRevision: "skills-1",
  },
  checks: [],
  phaseBudgets,
  repairBudget: { maxBatches: 1, maxFollowUps: 1 },
});

const identity = (
  itemId: string,
  kind: "planning-spec" | "executable-issue" = "executable-issue",
): WorkIdentity => ({ repository, itemId, kind });

const brief = createWorkBrief({
  identity: identity("100", "planning-spec"),
  source: {
    provider: "github",
    repository,
    itemId: "100",
    originalBody: "Deliver the planning spec.",
  },
  problem: "Deliver the planning spec.",
  evidence: ["The planning spec is authorized."],
  acceptanceCriteria: ["The child graph is delivered as one candidate."],
  exclusions: [],
  risk: "low",
  verification: { checks: [], artifacts: [] },
  unresolvedQuestions: [],
  authorization: {
    status: "approved",
    actor: "maintainer",
    actorRole: "maintainer",
    approvedAt: "2026-09-22T17:00:00.000Z",
  },
  base,
  policyRevision: policy.revision,
  skillRevision: policy.worker.skillRevision,
  createdAt: "2026-09-22T17:00:00.000Z",
});

const coordinator = (): WorkflowCoordinator =>
  new WorkflowCoordinator({
    storage: new InMemoryCoordinatorStorage(),
    clock: {
      now: () => "2026-09-22T17:00:00.000Z",
      nowMilliseconds: () => 0,
    },
  });

const verification = (): SpecVerificationAdapter => ({
  verifyChild: async () => ({
    checks: [],
    cleanup: { status: "passed", summary: "Child cleanup passed." },
    evidence: ["Focused child checks passed."],
  }),
  verifyIntegrated: async () => ({
    checks: [],
    cleanup: { status: "passed", summary: "Integrated cleanup passed." },
    evidence: ["Integrated checks passed."],
  }),
});

const review = (): SpecReviewProvider => ({
  review: async (request) => ({
    outcome: "passed",
    axes: request.requiredAxes,
    findings: [],
    evidence: ["Reviewed the exact frozen candidate."],
    headSha: request.candidate.head.sha,
    baseSha: request.candidate.base.sha,
    briefHash: request.candidate.briefHash,
  }),
});

const deliveryFor = (
  children: readonly string[],
  dependencies: readonly {
    itemId: string;
    dependsOn: readonly string[];
  }[] = [],
) =>
  resolveDeliveryGroup({
    issue: identity("100", "planning-spec"),
    children: children.map((itemId) => identity(itemId)),
    dependencies,
  });

describe("spec delivery planning", () => {
  it("plans the current child graph into dependency-safe waves", () => {
    const delivery = resolveDeliveryGroup({
      issue: identity("100", "planning-spec"),
      children: [identity("103"), identity("101"), identity("102")],
      dependencies: [
        { itemId: "102", dependsOn: ["101"] },
        { itemId: "103", dependsOn: ["101"] },
      ],
    });

    const plan = planSpecDelivery(delivery);

    expect(plan.waves.map((wave) => wave.map((child) => child.itemId))).toEqual(
      [["101"], ["102", "103"]],
    );
    expect(plan.children.map((child) => child.identity.itemId)).toEqual([
      "101",
      "102",
      "103",
    ]);
  });

  it("adds interface review for high-risk specs", () => {
    expect(reviewAxesForRisk("low")).toEqual(["standards", "spec"]);
    expect(reviewAxesForRisk("high")).toEqual([
      "standards",
      "spec",
      "interface",
    ]);
  });

  it("expands open scope without reopening completed children", async () => {
    const delivery = deliveryFor(["101"]);
    const expanded = await expandSpecDeliveryScope({
      coordinator: coordinator(),
      delivery,
      addedChildren: [identity("102")],
      completedChildIds: ["101"],
    });
    expect(expanded.status).toBe("expanded");
    expect(expanded.candidateInvalidated).toBe(true);
    expect(expanded.draftRequired).toBe(true);
    expect(
      expanded.plan?.waves.map((wave) => wave.map((child) => child.itemId)),
    ).toEqual([["101", "102"]]);

    const merged = await expandSpecDeliveryScope({
      coordinator: coordinator(),
      delivery,
      addedChildren: [identity("103")],
      parentState: "merged",
    });
    expect(merged.status).toBe("follow-up-required");
  });
});

describe("spec delivery orchestration", () => {
  it("runs dependency-safe workers concurrently, integrates serially, and closes only published children", async () => {
    const delivery = deliveryFor(
      ["101", "102", "103"],
      [{ itemId: "103", dependsOn: ["101"] }],
    );
    const events: string[] = [];
    let runningWorkers = 0;
    let maximumWorkers = 0;
    let integrating = false;
    let pullRequestCalls = 0;
    const worker: SpecChildWorker = {
      implement: async (request) => {
        expect(Object.keys(request).sort()).toEqual([
          "base",
          "child",
          "delivery",
          "integrationBranch",
          "lease",
          "signal",
        ]);
        runningWorkers += 1;
        maximumWorkers = Math.max(maximumWorkers, runningWorkers);
        events.push(`start:${request.child.itemId}`);
        await Promise.resolve();
        runningWorkers -= 1;
        return {
          commit: {
            branch: `shipyard/child-${request.child.itemId}`,
            sha: `child-${request.child.itemId}`,
          },
        };
      },
    };
    const integration: SpecIntegrationAdapter = {
      ensureDraftPullRequest: async (request) => {
        pullRequestCalls += 1;
        events.push(`draft:${request.candidate.sha}`);
        return {
          id: "pr-100",
          baseBranch: base.branch,
          headBranch: request.integrationBranch,
          draft: true,
        };
      },
      integrateChild: async (request) => {
        expect(integrating).toBe(false);
        integrating = true;
        events.push(`integrate:${request.child.itemId}`);
        const result = {
          branch: request.integrationBranch,
          sha: `integrated-${request.child.itemId}`,
        };
        integrating = false;
        return result;
      },
      publishCandidate: async (request) => {
        events.push(`publish:${request.candidate.head.sha}`);
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
      },
    };
    const checks = verification();
    const lifecycle = {
      closeChild: async (
        request: Parameters<typeof checks.verifyChild>[0] & {
          verification: Awaited<ReturnType<typeof checks.verifyChild>>;
        },
      ) => {
        events.push(`close:${request.child.itemId}`);
        expect(request.candidate.pullRequest.id).toBe("pr-100");
        expect(Object.isFrozen(request.candidate)).toBe(true);
      },
    };

    const result = await deliverSpec({
      coordinator: coordinator(),
      delivery,
      brief,
      policy,
      workerId: "coordinator-1",
      base,
      integrationBranch: "shipyard/spec-100",
      childWorker: worker,
      integration,
      verification: checks,
      childLifecycle: lifecycle,
      review: review(),
      maxConcurrency: 2,
    });

    expect(result.outcome).toBe("ready-for-human");
    expect(maximumWorkers).toBe(2);
    expect(pullRequestCalls).toBe(1);
    expect(result.children.map((child) => child.child.itemId)).toEqual([
      "101",
      "102",
      "103",
    ]);
    expect(result.candidate).toMatchObject({
      head: { branch: "shipyard/spec-100" },
      pullRequest: { id: "pr-100", draft: true },
    });
    expect(result.parent).toEqual({ state: "open", merged: false });
    expect(result.repairBatches).toBe(0);
    expect(result.followUps).toBe(0);
    expect(
      events.filter((event) => event.startsWith("integrate:")).length,
    ).toBe(3);
    for (const child of ["101", "102", "103"]) {
      const integrated = events.indexOf(`integrate:${child}`);
      const published = events.findIndex(
        (event, index) => index > integrated && event.startsWith("publish:"),
      );
      const closed = events.indexOf(`close:${child}`);
      expect(integrated).toBeGreaterThanOrEqual(0);
      expect(published).toBeGreaterThan(integrated);
      expect(closed).toBeGreaterThan(published);
    }
    expect(events.indexOf("close:101")).toBeLessThan(
      events.indexOf("start:103"),
    );
  });

  it("freezes the exact candidate and enforces one fix batch plus one targeted review", async () => {
    const delivery = deliveryFor(["101"]);
    const reviewModes: string[] = [];
    const reviewedHeads: string[] = [];
    const finding = {
      id: "spec-gap-1",
      severity: "high" as const,
      axis: "spec" as const,
      title: "The child graph evidence is incomplete",
      evidence: "The first candidate omitted the graph evidence.",
      requirement: "The complete child graph must be delivered.",
      verification: "Run the targeted review after the fix.",
    };
    const reviewProvider: SpecReviewProvider = {
      review: async (request) => {
        reviewModes.push(request.mode);
        reviewedHeads.push(request.candidate.head.sha);
        expect(Object.isFrozen(request.candidate)).toBe(true);
        expect(Object.isFrozen(request.checkout)).toBe(true);
        expect(request.checkout.immutable).toBe(true);
        return request.mode === "full"
          ? {
              outcome: "actionable-findings",
              axes: request.requiredAxes,
              findings: [finding],
              evidence: ["The exact candidate was reviewed."],
              headSha: request.candidate.head.sha,
              baseSha: request.candidate.base.sha,
              briefHash: request.candidate.briefHash,
            }
          : {
              outcome: "passed",
              axes: request.requiredAxes,
              findings: [],
              evidence: ["The targeted finding was resolved."],
              headSha: request.candidate.head.sha,
              baseSha: request.candidate.base.sha,
              briefHash: request.candidate.briefHash,
            };
      },
    };
    let fixCalls = 0;
    const fixer = {
      fix: async (
        request: Parameters<
          NonNullable<SpecDeliveryOptions["fixer"]>["fix"]
        >[0],
      ) => {
        fixCalls += 1;
        expect(request.batch).toBe(1);
        expect(request.candidate.head.sha).toBe("integrated-101");
        expect(request.findings).toHaveLength(1);
        return {
          head: { branch: "shipyard/spec-100", sha: "fixed-head" },
          commits: ["fix-1"],
          evidence: ["The consolidated fix was applied."],
        };
      },
    };
    const integration: SpecIntegrationAdapter = {
      ensureDraftPullRequest: async (request) => ({
        id: "pr-100",
        baseBranch: base.branch,
        headBranch: request.integrationBranch,
        draft: true,
      }),
      integrateChild: async (request) => ({
        branch: request.integrationBranch,
        sha: "integrated-101",
      }),
      publishCandidate: async (request) => ({
        pullRequestId: request.candidate.pullRequest.id,
        head: request.candidate.head,
      }),
    };

    const result = await deliverSpec({
      coordinator: coordinator(),
      delivery,
      brief,
      policy,
      workerId: "coordinator-1",
      base,
      integrationBranch: "shipyard/spec-100",
      childWorker: {
        implement: async () => ({
          commit: { branch: "shipyard/child-101", sha: "child-101" },
        }),
      },
      integration,
      verification: verification(),
      childLifecycle: { closeChild: async () => undefined },
      review: reviewProvider,
      fixer,
    });

    expect(result.outcome).toBe("ready-for-human");
    expect(result.repairBatches).toBe(1);
    expect(result.followUps).toBe(1);
    expect(fixCalls).toBe(1);
    expect(reviewModes).toEqual(["full", "targeted"]);
    expect(reviewedHeads).toEqual(["integrated-101", "fixed-head"]);
    expect(result.candidate?.head.sha).toBe("fixed-head");
    expect(result.candidate?.pullRequest.id).toBe("pr-100");
    expect(result.parent).toEqual({ state: "open", merged: false });
  });
});
