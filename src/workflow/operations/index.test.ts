import { describe, expect, it } from "vitest";
import {
  WORKFLOW_CONTRACT_VERSION,
  createRepositoryPolicy,
  createWorkBrief,
  type RepositoryPolicy,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  WorkflowCoordinator,
} from "../coordinator/index.js";
import { WorkflowOperator, redactOperatorText } from "./index.js";

const repository = "snappedly/shipyard";
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
    originalBody: "Need help",
  },
  problem: "Need help",
  evidence: ["Submitted"],
  acceptanceCriteria: [],
  exclusions: [],
  risk: "low",
  verification: { checks: [], artifacts: [] },
  unresolvedQuestions: ["Which behavior is expected?"],
  authorization: { status: "pending" },
  base: { branch: "main", sha: "a".repeat(40) },
  policyRevision: policy.revision,
  skillRevision: policy.worker.skillRevision,
  createdAt: "2026-09-17T12:00:00.000Z",
});

describe("workflow operator controls", () => {
  it("reports waiting reason, queue age, unknown cost, and redacted evidence", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
      clock: {
        now: () => "2026-09-17T12:05:00.000Z",
        nowMilliseconds: () => 300_000,
      },
    });
    const ingested = await coordinator.ingest({
      deliveryId: "operator-42",
      brief,
      policy,
      phase: "triage",
      relevantRevision: brief.base.sha,
      observedAt: "2026-09-17T12:00:00.000Z",
    });
    const operator = new WorkflowOperator({
      coordinator,
      now: () => "2026-09-17T12:05:00.000Z",
    });
    const status = await operator.status(ingested.job!.id, {
      now: "2026-09-17T12:10:00.000Z",
    });
    expect(status.waitingReason).toBe("authorization-pending");
    expect(status.queueAgeSeconds).toBe(300);
    expect(status.cost.status).toBe("unknown");
    expect(redactOperatorText("token=secret Bearer abc")).toContain(
      "[REDACTED]",
    );
  });

  it("pauses, resumes, cancels jobs, and stops or resumes a repository", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
    });
    const ingested = await coordinator.ingest({
      deliveryId: "operator-43",
      brief,
      policy,
      phase: "triage",
      relevantRevision: brief.base.sha,
      observedAt: "2026-09-17T12:00:00.000Z",
    });
    const operator = new WorkflowOperator({ coordinator });
    await operator.pause(ingested.job!.id, "operator review");
    await operator.resume(ingested.job!.id);
    await operator.cancel(ingested.job!.id, "test cancellation");
    expect((await operator.status(ingested.job!.id)).control).toBe("cancelled");
    expect(
      (await operator.stopRepository(repository, "incident")).stopped,
    ).toBe(true);
    expect((await operator.resumeRepository(repository)).stopped).toBe(false);
  });

  it("reports redacted checks, artifacts, and operator interventions", async () => {
    const coordinator = new WorkflowCoordinator({
      storage: new InMemoryCoordinatorStorage(),
    });
    const approvedBrief = createWorkBrief({
      ...brief,
      authorization: {
        status: "approved",
        actor: "Jonathan",
        actorRole: "maintainer",
        approvedAt: "2026-09-17T12:00:00.000Z",
      },
    });
    const ingested = await coordinator.ingest({
      deliveryId: "operator-evidence-42",
      brief: approvedBrief,
      policy,
      phase: "implementation",
      relevantRevision: approvedBrief.base.sha,
      observedAt: "2026-09-17T12:00:00.000Z",
    });
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
      jobId: ingested.job!.id,
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/42",
      jobId: ingested.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    const operator = new WorkflowOperator({
      coordinator,
      now: () => "2026-09-17T12:05:00.000Z",
    });

    await operator.pause(ingested.job!.id, "review token=secret");
    await operator.resume(ingested.job!.id);
    await coordinator.recordPhaseResult({
      jobId: ingested.job!.id,
      lease,
      result: {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: dispatch.assignment!.id,
        phase: "implementation",
        outcome: "cancelled",
        identity: approvedBrief.identity,
        briefHash: approvedBrief.hash,
        base: approvedBrief.base,
        head: { branch: "feature/42", sha: "c".repeat(40) },
        summary: "Worker stopped after token=secret was observed.",
        evidence: [],
        checks: [
          {
            name: "token=secret",
            command: "echo api_key=secret",
            status: "passed",
            summary: "secret=secret",
            artifactRefs: ["Bearer abc"],
          },
        ],
        commits: [],
        artifacts: ["Bearer abc"],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:02.000Z",
      },
    });

    const status = await operator.status(ingested.job!.id);
    expect(status.control).toBe("cancelled");
    expect(status.artifacts).toEqual(["Bearer [REDACTED]"]);
    expect(status.checks).toEqual([
      {
        name: "token=[REDACTED]",
        command: "echo api_key=[REDACTED]",
        status: "passed",
        summary: "secret=[REDACTED]",
        artifactRefs: ["Bearer [REDACTED]"],
      },
    ]);
    expect(
      status.interventions.map((intervention) => intervention.action),
    ).toEqual(["pause", "resume"]);
  });
});
