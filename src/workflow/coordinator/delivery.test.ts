import { describe, expect, it } from "vitest";
import {
  createRepositoryPolicy,
  createWorkBrief,
  type WorkIdentity,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  parseDeliveryRecord,
  resolveDeliveryGroup,
  WorkflowCoordinator,
} from "./index.js";

const repository = "snappedly/shipyard";

const policy = createRepositoryPolicy({
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
  checks: [],
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

const identity = (
  itemId: string,
  kind: WorkIdentity["kind"] = "executable-issue",
): WorkIdentity => ({ repository, itemId, kind });

const brief = (itemId: string): ReturnType<typeof createWorkBrief> =>
  createWorkBrief({
    identity: identity(itemId),
    source: {
      provider: "github",
      repository,
      itemId,
      originalBody: `Implement #${itemId}.`,
    },
    problem: `Implement #${itemId}.`,
    evidence: ["The issue is authorized by the maintainer."],
    acceptanceCriteria: ["The behavior is covered by tests."],
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
    base: { branch: "staging", sha: "a".repeat(40) },
    policyRevision: policy.revision,
    skillRevision: policy.worker.skillRevision,
    createdAt: "2026-09-22T17:00:00.000Z",
  });

describe("delivery groups", () => {
  it("keys a standalone issue by itself", () => {
    const group = resolveDeliveryGroup({ issue: identity("42") });

    expect(group).toMatchObject({
      id: `${repository}#42`,
      mode: "standalone",
      key: { repository, itemId: "42" },
      graph: { root: identity("42"), children: [], dependencies: [] },
    });
  });

  it("promotes a child to one planning-spec delivery and normalizes dependencies", () => {
    const group = resolveDeliveryGroup({
      issue: identity("101"),
      parent: identity("100", "planning-spec"),
      children: [identity("102")],
      dependencies: [{ itemId: "102", dependsOn: ["101", "101"] }],
    });

    expect(group).toMatchObject({
      id: `${repository}#100`,
      mode: "planning-spec",
      key: { repository, itemId: "100" },
    });
    expect(group.graph.children.map((child) => child.itemId)).toEqual([
      "101",
      "102",
    ]);
    expect(group.graph.dependencies).toEqual([
      { itemId: "102", dependsOn: ["101"] },
    ]);
  });

  it("rejects dependency references outside the current graph and cycles", () => {
    expect(() =>
      resolveDeliveryGroup({
        issue: identity("101"),
        parent: identity("100", "planning-spec"),
        dependencies: [{ itemId: "101", dependsOn: ["999"] }],
      }),
    ).toThrow("not a child");

    expect(() =>
      resolveDeliveryGroup({
        issue: identity("101"),
        parent: identity("100", "planning-spec"),
        children: [identity("102")],
        dependencies: [
          { itemId: "101", dependsOn: ["102"] },
          { itemId: "102", dependsOn: ["101"] },
        ],
      }),
    ).toThrow("dependency cycle");
  });

  it("parses durable spec completion evidence from a delivery record", () => {
    const delivery = resolveDeliveryGroup({
      issue: identity("100", "planning-spec"),
      children: [identity("101")],
    });
    const record = parseDeliveryRecord({
      ...delivery,
      createdAt: "2026-09-22T17:00:00.000Z",
      updatedAt: "2026-09-22T17:01:00.000Z",
      version: 3,
      specCheckpoint: {
        pullRequest: {
          id: "pr-100",
          baseBranch: "staging",
          headBranch: "shipyard/spec-100",
          draft: true,
        },
        currentHead: {
          branch: "shipyard/spec-100",
          sha: "integrated-101",
        },
        children: [
          {
            child: identity("101"),
            status: "closed",
            workerBase: { branch: "shipyard/spec-100", sha: "base-100" },
            sourceCommit: { branch: "shipyard/child-101", sha: "child-101" },
            candidate: {
              deliveryId: delivery.id,
              briefHash: "brief-hash",
              base: { branch: "staging", sha: "a".repeat(40) },
              head: { branch: "shipyard/spec-100", sha: "integrated-101" },
              pullRequest: {
                id: "pr-100",
                baseBranch: "staging",
                headBranch: "shipyard/spec-100",
                draft: true,
              },
            },
            verification: {
              checks: [
                {
                  name: "focused",
                  command: "npm test -- affected.test.ts",
                  status: "passed",
                  summary: "Focused checks passed.",
                },
              ],
              cleanup: { status: "passed", summary: "Cleanup passed." },
              evidence: ["The published child candidate passed verification."],
            },
            closedAt: "2026-09-22T17:01:00.000Z",
          },
        ],
      },
    });

    expect(record.specCheckpoint?.children[0]).toMatchObject({
      child: identity("101"),
      status: "closed",
      verification: {
        cleanup: { status: "passed" },
        evidence: ["The published child candidate passed verification."],
      },
    });
  });

  it("leases a spec delivery once while leaving an unrelated delivery eligible", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      clock: {
        now: () => "2026-09-22T17:00:00.000Z",
        nowMilliseconds: () => 0,
      },
    });
    const spec = resolveDeliveryGroup({
      issue: identity("101"),
      parent: identity("100", "planning-spec"),
      children: [identity("102")],
    });

    await coordinator.ingest({
      deliveryId: "child-101",
      brief: brief("101"),
      policy,
      phase: "implementation",
      relevantRevision: "b".repeat(40),
      observedAt: "2026-09-22T17:00:00.000Z",
      delivery: spec,
      sourceState: "open",
    });
    await coordinator.ingest({
      deliveryId: "child-102",
      brief: brief("102"),
      policy,
      phase: "implementation",
      relevantRevision: "c".repeat(40),
      observedAt: "2026-09-22T17:00:01.000Z",
      delivery: spec,
      sourceState: "open",
    });
    await coordinator.ingest({
      deliveryId: "standalone-103",
      brief: brief("103"),
      policy,
      phase: "implementation",
      relevantRevision: "d".repeat(40),
      observedAt: "2026-09-22T17:00:02.000Z",
      sourceState: "open",
    });

    const first = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    expect(first.status).toBe("dispatched");
    expect(first.deliveryLease?.key).toEqual({ repository, itemId: "100" });

    const unrelated = await coordinator.dispatchNext({
      repository,
      workerId: "worker-b",
    });
    expect(unrelated.status).toBe("dispatched");
    expect(unrelated.job?.deliveryKey).toEqual({
      repository,
      itemId: "103",
    });
  });
});
