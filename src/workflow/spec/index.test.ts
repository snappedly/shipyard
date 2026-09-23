import { describe, expect, it, vi } from "vitest";
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
  type SpecCurrentCandidate,
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

const currentFor = (
  deliveryId: string,
  head: RevisionReference,
  options: { readonly pullRequestId?: string; readonly draft?: boolean } = {},
): SpecCurrentCandidate => ({
  base,
  head,
  briefHash: brief.hash,
  pullRequest: {
    id: options.pullRequestId ?? "pr-100",
    state: "open",
    draft: options.draft ?? true,
    baseBranch: base.branch,
    headBranch: "shipyard/spec-100",
    baseSha: base.sha,
    headSha: head.sha,
    briefHash: brief.hash,
    deliveryId,
  },
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
    const expandedCoordinator = coordinator();
    const expanded = await expandSpecDeliveryScope({
      coordinator: expandedCoordinator,
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

    const completedMutation = await expandSpecDeliveryScope({
      coordinator: expandedCoordinator,
      delivery: expanded.delivery!,
      addedChildren: [identity("103")],
      addedDependencies: [{ itemId: "101", dependsOn: ["103"] }],
      completedChildIds: ["101"],
    });
    expect(completedMutation.status).toBe("rejected");
    expect(completedMutation.reason).toContain(
      "Completed child 101 cannot be mutated",
    );

    const merged = await expandSpecDeliveryScope({
      coordinator: coordinator(),
      delivery,
      addedChildren: [identity("103")],
      parentState: "merged",
    });
    expect(merged.status).toBe("follow-up-required");
  });

  it("keeps a merged delivery immutable even when callers omit parent state", async () => {
    const owner = coordinator();
    const delivery = deliveryFor(["101"]);
    await owner.resolveDelivery(delivery);
    await owner.markDeliveryMerged(delivery.key, "d".repeat(40));

    const expansion = await expandSpecDeliveryScope({
      coordinator: owner,
      delivery,
      addedChildren: [identity("102")],
    });

    expect(expansion.status).toBe("follow-up-required");
    expect((await owner.getDelivery(delivery.key))?.graph.children).toEqual([
      identity("101"),
    ]);
    await expect(
      owner.resolveDelivery(deliveryFor(["101", "103"])),
    ).rejects.toThrow(/merged/i);
    const replay = await owner.ingest({
      deliveryId: "merged-replay",
      brief,
      policy,
      phase: "triage",
      relevantRevision: base.sha,
      observedAt: "2026-09-23T00:00:00.000Z",
      delivery,
      sourceState: "open",
    });
    expect(replay.disposition).toBe("ignored");
    expect(replay.reason).toBe("merged-delivery");
  });

  it("merges concurrent additions made from stale scope snapshots", async () => {
    const owner = coordinator();
    const initial = deliveryFor(["101"]);
    await owner.resolveDelivery(initial);

    const [first, second] = await Promise.all([
      expandSpecDeliveryScope({
        coordinator: owner,
        delivery: initial,
        addedChildren: [identity("102")],
      }),
      expandSpecDeliveryScope({
        coordinator: owner,
        delivery: initial,
        addedChildren: [identity("103")],
      }),
    ]);

    expect(first.status).toBe("expanded");
    expect(second.status).toBe("expanded");
    expect(
      (await owner.getDelivery(initial.key))?.graph.children.map(
        (child) => child.itemId,
      ),
    ).toEqual(["101", "102", "103"]);

    const beforeReplay = await owner.getDelivery(initial.key);
    const replay = await owner.resolveDelivery(initial);
    expect(replay.graph.children.map((child) => child.itemId)).toEqual([
      "101",
      "102",
      "103",
    ]);
    expect(replay.version).toBe(beforeReplay?.version);
  });
});

describe("spec delivery orchestration", () => {
  it("fails closed before review when current provider state cannot be read", async () => {
    const reviewer = vi.fn(review().review);
    const integration: SpecIntegrationAdapter = {
      reconcileDelivery: async () => ({}),
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
      delivery: deliveryFor(["101"]),
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
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: { review: reviewer },
    } as unknown as SpecDeliveryOptions);

    expect(result.outcome).toBe("blocked");
    expect(result.reason?.toLowerCase()).toContain("current provider state");
    expect(reviewer).not.toHaveBeenCalled();
  });

  it("invalidates review evidence when the provider candidate changes before handoff", async () => {
    const delivery = deliveryFor(["101"]);
    const candidateHead: RevisionReference = {
      branch: "shipyard/spec-100",
      sha: "integrated-101",
    };
    let publishedHead: RevisionReference = base;
    let currentReads = 0;
    const reviewer = vi.fn(review().review);
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
      integration: {
        reconcileDelivery: async () => ({}),
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
        publishCandidate: async (request) => {
          publishedHead = request.candidate.head;
          return {
            pullRequestId: request.candidate.pullRequest.id,
            head: request.candidate.head,
          };
        },
      },
      verification: verification(),
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: { review: reviewer },
      readCurrent: async () => {
        currentReads += 1;
        return currentReads <= 2
          ? currentFor(delivery.id, publishedHead)
          : currentFor(delivery.id, {
              ...candidateHead,
              sha: "c".repeat(40),
            });
      },
    });

    expect(reviewer).toHaveBeenCalledOnce();
    expect(currentReads).toBe(3);
    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("before human handoff");
    expect(result.reviews).toEqual([]);
  });

  it("invalidates review evidence before refusing a repair on a stale candidate", async () => {
    const delivery = deliveryFor(["101"]);
    const publishedHead: RevisionReference = {
      branch: "shipyard/spec-100",
      sha: "integrated-101",
    };
    let currentReads = 0;
    const fixer = vi.fn(async () => ({
      head: { branch: "shipyard/spec-100", sha: "fixed-head" },
      commits: ["fix-commit"],
      evidence: ["The consolidated fix was applied."],
    }));
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
      integration: {
        reconcileDelivery: async () => ({}),
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
      },
      verification: verification(),
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: {
        review: async (request) => ({
          outcome: "actionable-findings",
          axes: request.requiredAxes,
          findings: [
            {
              id: "needs-fix",
              severity: "high",
              axis: "spec",
              title: "The candidate needs a repair",
              evidence: "A required behavior is missing.",
            },
          ],
          evidence: ["Reviewed the candidate before it changed."],
          headSha: request.candidate.head.sha,
          baseSha: request.candidate.base.sha,
          briefHash: request.candidate.briefHash,
        }),
      },
      readCurrent: async () => {
        currentReads += 1;
        const head =
          currentReads < 3
            ? publishedHead
            : { ...publishedHead, sha: "stale-head" };
        return currentFor(delivery.id, head);
      },
      fixer: { fix: fixer },
    });

    expect(currentReads).toBe(3);
    expect(fixer).not.toHaveBeenCalled();
    expect(result.outcome).toBe("blocked");
    expect(result.reviews).toEqual([]);
  });

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
    let publishedHead: RevisionReference = base;
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
      reconcileDelivery: async () => ({}),
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
        publishedHead = request.candidate.head;
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
      },
    };
    const checks = verification();
    const lifecycle = {
      reconcileChild: async () => "open" as const,
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
      readCurrent: async () => currentFor(delivery.id, publishedHead),
      maxConcurrency: 2,
    });

    expect(result.outcome, result.reason).toBe("ready-for-human");
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
    let publishedHead: RevisionReference = base;
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
      reconcileDelivery: async () => ({}),
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
      publishCandidate: async (request) => {
        publishedHead = request.candidate.head;
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
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
      childWorker: {
        implement: async () => ({
          commit: { branch: "shipyard/child-101", sha: "child-101" },
        }),
      },
      integration,
      verification: verification(),
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: reviewProvider,
      readCurrent: async () => currentFor(delivery.id, publishedHead),
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

  it("resumes a published child after provider closure without repeating its work or closure", async () => {
    const owner = coordinator();
    const delivery = deliveryFor(["101"]);
    const saveCheckpoint = owner.saveSpecDeliveryCheckpoint.bind(owner);
    let failAfterPublication = true;
    vi.spyOn(owner, "saveSpecDeliveryCheckpoint").mockImplementation(
      async (key, lease, nextCheckpoint) => {
        if (
          failAfterPublication &&
          nextCheckpoint.children.some((child) => child.status === "verifying")
        ) {
          failAfterPublication = false;
          throw new Error("runner stopped after candidate publication");
        }
        return saveCheckpoint(key, lease, nextCheckpoint);
      },
    );
    const remote: {
      pullRequest?: {
        id: string;
        baseBranch: string;
        headBranch: string;
        draft: boolean;
      };
      head?: RevisionReference;
      childClosed: boolean;
    } = { childClosed: false };
    const calls = {
      worker: 0,
      integrate: 0,
      ensure: 0,
      publish: 0,
      verify: 0,
      close: 0,
    };
    const integration: SpecIntegrationAdapter = {
      reconcileDelivery: async () => ({
        pullRequest: remote.pullRequest,
        head: remote.head,
      }),
      ensureDraftPullRequest: async (request) => {
        calls.ensure += 1;
        remote.pullRequest = {
          id: "pr-100",
          baseBranch: base.branch,
          headBranch: request.integrationBranch,
          draft: true,
        };
        return {
          id: "pr-100",
          baseBranch: base.branch,
          headBranch: request.integrationBranch,
          draft: true,
        };
      },
      integrateChild: async (request) => {
        calls.integrate += 1;
        return {
          branch: request.integrationBranch,
          sha: "integrated-101",
        };
      },
      publishCandidate: async (request) => {
        calls.publish += 1;
        if (calls.publish === 1) {
          throw new Error("runner stopped before publishing the candidate");
        }
        remote.head = request.candidate.head;
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
      },
    };
    const checks: SpecVerificationAdapter = {
      ...verification(),
      verifyChild: async () => {
        calls.verify += 1;
        return {
          checks: [],
          cleanup: { status: "passed", summary: "Child cleanup passed." },
          evidence: ["Focused child checks passed."],
        };
      },
    };
    const childLifecycle = {
      reconcileChild: async () => (remote.childClosed ? "closed" : "open"),
      closeChild: async () => {
        calls.close += 1;
        remote.childClosed = true;
        throw new Error("runner stopped after GitHub closed the child");
      },
    };
    const run = () =>
      deliverSpec({
        coordinator: owner,
        delivery,
        brief,
        policy,
        workerId: "coordinator-1",
        base,
        integrationBranch: "shipyard/spec-100",
        childWorker: {
          implement: async () => {
            calls.worker += 1;
            return {
              commit: { branch: "shipyard/child-101", sha: "child-101" },
            };
          },
        },
        integration,
        verification: checks,
        childLifecycle,
        review: review(),
        readCurrent: async () =>
          currentFor(delivery.id, remote.head ?? base, {
            pullRequestId: remote.pullRequest?.id,
            draft: remote.pullRequest?.draft,
          }),
      });

    const interrupted = await run();
    expect(interrupted.outcome).toBe("blocked");
    expect(
      (await owner.getDelivery(delivery.key))?.specCheckpoint?.children,
    ).toMatchObject([{ child: identity("101"), status: "publishing" }]);

    const stoppedAfterPublication = await run();
    expect(stoppedAfterPublication.outcome).toBe("blocked");
    expect(remote.head?.sha).toBe("integrated-101");
    expect(
      (await owner.getDelivery(delivery.key))?.specCheckpoint?.children,
    ).toMatchObject([{ child: identity("101"), status: "publishing" }]);

    const stoppedAfterClosure = await run();
    expect(stoppedAfterClosure.outcome).toBe("blocked");
    expect(
      (await owner.getDelivery(delivery.key))?.specCheckpoint?.children,
    ).toMatchObject([{ child: identity("101"), status: "closing" }]);

    const resumed = await run();

    expect(resumed.outcome, resumed.reason).toBe("ready-for-human");
    expect(resumed.children.map((child) => child.child.itemId)).toEqual([
      "101",
    ]);
    expect(calls).toEqual({
      worker: 1,
      integrate: 1,
      ensure: 1,
      publish: 2,
      verify: 1,
      close: 1,
    });

    remote.pullRequest = { ...remote.pullRequest!, draft: false };
    const nonDraftResume = await run();
    expect(nonDraftResume.outcome).toBe("blocked");
    expect(nonDraftResume.reason).toContain(
      "return it to draft before resuming",
    );
    remote.pullRequest = { ...remote.pullRequest!, draft: true };

    const changedDependency = await expandSpecDeliveryScope({
      coordinator: owner,
      delivery,
      addedChildren: [identity("102")],
      addedDependencies: [{ itemId: "101", dependsOn: ["102"] }],
    });
    expect(changedDependency.status).toBe("rejected");
    expect(changedDependency.reason).toContain("Completed child 101");

    remote.head = {
      branch: "shipyard/spec-100",
      sha: "contradictory-remote-head",
    };
    const contradiction = await run();
    expect(contradiction.outcome).toBe("blocked");
    expect(contradiction.reason).toContain(
      "contradicts the coordinator checkpoint",
    );
    expect(calls.worker).toBe(1);
  });

  it("refreshes retracted PR metadata after a scope change before resuming children", async () => {
    const owner = coordinator();
    const original = deliveryFor(["101"]);
    const resolved = await owner.resolveDelivery(original);
    const initialLease = await owner.acquireDeliveryLease({
      repository,
      key: resolved.key,
      workerId: "coordinator-before-scope-change",
      ttlMs: 10_000,
    });
    const integratedHead: RevisionReference = {
      branch: "shipyard/spec-100",
      sha: "b".repeat(40),
    };
    const completedCandidate = {
      deliveryId: resolved.id,
      briefRevision: brief.revision,
      briefHash: brief.hash,
      base,
      head: integratedHead,
      pullRequest: {
        id: "pr-100",
        baseBranch: base.branch,
        headBranch: integratedHead.branch,
        draft: false,
      },
    };
    await owner.saveSpecDeliveryCheckpoint(resolved.key, initialLease, {
      pullRequest: completedCandidate.pullRequest,
      currentHead: integratedHead,
      children: [
        {
          child: identity("101"),
          status: "closed",
          workerBase: base,
          sourceCommit: { branch: "shipyard/child-101", sha: "c".repeat(40) },
          candidate: completedCandidate,
          verification: {
            checks: [],
            cleanup: { status: "passed", summary: "Clean." },
            evidence: ["Child verified."],
          },
          closedAt: "2026-09-23T10:00:00.000Z",
        },
      ],
    });
    const expanded = await owner.expandDeliveryScope({
      key: resolved.key,
      addedChildren: [identity("102")],
      completedChildIds: ["101"],
    });
    const delivery = deliveryFor(["101", "102"]);
    const calls = { ensure: 0, worker: 0, integrate: 0, publish: 0 };
    const integration: SpecIntegrationAdapter = {
      reconcileDelivery: async () => ({
        pullRequest: {
          ...completedCandidate.pullRequest,
          draft: true,
        },
        scopeVersionChanged: true,
        scopeChangeRetracted: true,
        head: integratedHead,
      }),
      ensureDraftPullRequest: async (request) => {
        calls.ensure += 1;
        expect(request.delivery.version).toBe(
          (await owner.getDelivery(resolved.key))?.version,
        );
        expect(request.briefRevision).toBe(brief.revision);
        expect(request.candidate).toEqual(integratedHead);
        return {
          ...completedCandidate.pullRequest,
          draft: true,
        };
      },
      integrateChild: async () => {
        calls.integrate += 1;
        return integratedHead;
      },
      publishCandidate: async (request) => {
        calls.publish += 1;
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
      },
    };
    const result = await deliverSpec({
      coordinator: owner,
      delivery,
      brief,
      policy,
      workerId: "coordinator-before-scope-change",
      base,
      integrationBranch: integratedHead.branch,
      childWorker: {
        implement: async () => {
          calls.worker += 1;
          throw new Error("stop after current PR metadata is refreshed");
        },
      },
      integration,
      verification: verification(),
      childLifecycle: {
        reconcileChild: async ({ child }) =>
          child.itemId === "101" ? "closed" : "open",
        closeChild: async () => undefined,
      },
      review: review(),
      readCurrent: async () => currentFor(delivery.id, integratedHead),
    });

    expect(result.outcome).toBe("blocked");
    expect(result.reason).toContain("stop after current PR metadata");
    expect(result.blockedChild?.itemId).toBe("102");
    expect(calls).toEqual({ ensure: 1, worker: 1, integrate: 0, publish: 0 });
    expect(
      (await owner.getDelivery(resolved.key))?.specCheckpoint?.pullRequest,
    ).toMatchObject({ id: "pr-100", draft: true });
  });

  it("recovers a child integration published remotely before its checkpoint", async () => {
    const owner = coordinator();
    const delivery = deliveryFor(["101"]);
    const saveCheckpoint = owner.saveSpecDeliveryCheckpoint.bind(owner);
    let stopAfterRemoteIntegration = true;
    vi.spyOn(owner, "saveSpecDeliveryCheckpoint").mockImplementation(
      async (key, lease, nextCheckpoint) => {
        if (
          stopAfterRemoteIntegration &&
          nextCheckpoint.children.some((child) => child.status === "publishing")
        ) {
          stopAfterRemoteIntegration = false;
          throw new Error("runner stopped after pushing child integration");
        }
        return saveCheckpoint(key, lease, nextCheckpoint);
      },
    );
    const sourceCommit = {
      branch: "shipyard/child-101",
      sha: "child-101",
    };
    const remote: {
      pullRequest?: {
        id: string;
        baseBranch: string;
        headBranch: string;
        draft: true;
      };
      head?: RevisionReference;
      integratedChild?: {
        child: WorkIdentity;
        sourceCommit: RevisionReference;
        head: RevisionReference;
      };
    } = {};
    const calls = { worker: 0, integrate: 0, ensure: 0, publish: 0 };
    const integration: SpecIntegrationAdapter = {
      reconcileDelivery: async () => ({
        pullRequest: remote.pullRequest,
        head: remote.head,
        integratedChild: remote.integratedChild,
      }),
      ensureDraftPullRequest: async (request) => {
        calls.ensure += 1;
        remote.pullRequest = {
          id: "pr-100",
          baseBranch: base.branch,
          headBranch: request.integrationBranch,
          draft: true,
        };
        return remote.pullRequest;
      },
      integrateChild: async (request) => {
        calls.integrate += 1;
        const head = {
          branch: request.integrationBranch,
          sha: "integrated-101",
        };
        remote.head = head;
        remote.integratedChild = {
          child: request.child,
          sourceCommit: request.sourceCommit,
          head,
        };
        return head;
      },
      publishCandidate: async (request) => {
        calls.publish += 1;
        remote.head = request.candidate.head;
        return {
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        };
      },
    };
    const run = () =>
      deliverSpec({
        coordinator: owner,
        delivery,
        brief,
        policy,
        workerId: "coordinator-1",
        base,
        integrationBranch: "shipyard/spec-100",
        childWorker: {
          implement: async () => {
            calls.worker += 1;
            return { commit: sourceCommit };
          },
        },
        integration,
        verification: verification(),
        childLifecycle: {
          reconcileChild: async () => "open",
          closeChild: async () => undefined,
        },
        review: review(),
        readCurrent: async () => currentFor(delivery.id, remote.head ?? base),
      });

    const interrupted = await run();
    expect(interrupted.outcome).toBe("blocked");
    expect(
      (await owner.getDelivery(delivery.key))?.specCheckpoint?.children,
    ).toMatchObject([{ child: identity("101"), status: "integrating" }]);
    expect(remote.head?.sha).toBe("integrated-101");

    const resumed = await run();
    expect(resumed.outcome, resumed.reason).toBe("ready-for-human");
    expect(calls).toEqual({ worker: 1, integrate: 1, ensure: 1, publish: 1 });
  });

  it("renews the delivery lease during long work and aborts promptly after lease loss", async () => {
    const storage = new InMemoryCoordinatorStorage();
    const owner = new WorkflowCoordinator({
      storage,
      clock: {
        now: () => new Date().toISOString(),
        nowMilliseconds: () => Date.now(),
      },
    });
    const delivery = deliveryFor(["101"]);
    let startWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      startWorker = resolve;
    });
    let finishWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => {
      finishWorker = resolve;
    });
    const work = deliverSpec({
      coordinator: owner,
      delivery,
      brief,
      policy,
      workerId: "coordinator-1",
      base,
      integrationBranch: "shipyard/spec-100",
      leaseTtlMs: 30,
      childWorker: {
        implement: async () => {
          startWorker();
          await workerGate;
          return {
            commit: { branch: "shipyard/child-101", sha: "child-101" },
          };
        },
      },
      integration: {
        reconcileDelivery: async () => ({}),
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
      },
      verification: verification(),
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: review(),
      readCurrent: async () =>
        currentFor(delivery.id, {
          branch: "shipyard/spec-100",
          sha: "integrated-101",
        }),
    });

    await workerStarted;
    await new Promise((resolve) => setTimeout(resolve, 90));
    await expect(
      owner.acquireDeliveryLease({
        repository,
        key: delivery.key,
        workerId: "competing-coordinator",
        ttlMs: 30,
      }),
    ).rejects.toThrow(/leased/i);
    finishWorker();
    await expect(work).resolves.toMatchObject({ outcome: "ready-for-human" });

    const lostOwner = coordinator();
    const originalHeartbeat = lostOwner.heartbeatDeliveryLease.bind(lostOwner);
    let loseNextHeartbeat = false;
    vi.spyOn(lostOwner, "heartbeatDeliveryLease").mockImplementation(
      async (lease) => {
        if (loseNextHeartbeat) throw new Error("lease fenced by another owner");
        return originalHeartbeat(lease);
      },
    );
    let workerAborted = false;
    let deliveryReturned = false;
    let workerMutatedAfterReturn = false;
    let integrationsAfterLoss = 0;
    let startedLostWorker!: () => void;
    const lostWorkerStarted = new Promise<void>((resolve) => {
      startedLostWorker = resolve;
    });
    const lost = deliverSpec({
      coordinator: lostOwner,
      delivery,
      brief,
      policy,
      workerId: "lost-coordinator",
      base,
      integrationBranch: "shipyard/spec-100",
      leaseTtlMs: 30,
      childWorker: {
        implement: (request) =>
          new Promise((_resolve, reject) => {
            startedLostWorker();
            request.signal.addEventListener(
              "abort",
              () => {
                workerAborted = true;
                setTimeout(() => {
                  if (deliveryReturned) workerMutatedAfterReturn = true;
                  reject(new Error("worker observed lease cancellation"));
                }, 15);
              },
              { once: true },
            );
          }),
      },
      integration: {
        reconcileDelivery: async () => ({}),
        ensureDraftPullRequest: async (request) => ({
          id: "pr-lost",
          baseBranch: base.branch,
          headBranch: request.integrationBranch,
          draft: true,
        }),
        integrateChild: async (request) => {
          integrationsAfterLoss += 1;
          return {
            branch: request.integrationBranch,
            sha: "integrated-lost",
          };
        },
        publishCandidate: async (request) => ({
          pullRequestId: request.candidate.pullRequest.id,
          head: request.candidate.head,
        }),
      },
      verification: verification(),
      childLifecycle: {
        reconcileChild: async () => "open",
        closeChild: async () => undefined,
      },
      review: review(),
      readCurrent: async () =>
        currentFor(
          delivery.id,
          { branch: "shipyard/spec-100", sha: "integrated-lost" },
          { pullRequestId: "pr-lost" },
        ),
    });
    await lostWorkerStarted;
    loseNextHeartbeat = true;
    await expect(lost).resolves.toMatchObject({
      outcome: "blocked",
      reason: expect.stringContaining("lease lost"),
    });
    deliveryReturned = true;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(workerAborted).toBe(true);
    expect(workerMutatedAfterReturn).toBe(false);
    expect(integrationsAfterLoss).toBe(0);
  });
});
