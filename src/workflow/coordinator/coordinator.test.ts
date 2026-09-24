import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_CONTRACT_VERSION,
  createRepositoryPolicy,
  createWorkBrief,
  type RepositoryPolicy,
  type WorkBrief,
} from "../contracts/index.js";
import {
  InMemoryCoordinatorStorage,
  LeaseLostError,
  WorkflowCoordinator,
  type CoordinatorClock,
  type WorkflowEventInput,
} from "./index.js";

const repository = "snappedly/shipyard";

const policy = (overrides: Partial<RepositoryPolicy> = {}): RepositoryPolicy =>
  createRepositoryPolicy({
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
    checks: [
      { name: "typecheck", command: "npm run typecheck", required: true },
    ],
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
    repairBudget: { maxBatches: 2, maxFollowUps: 1 },
    ...overrides,
  });

const brief = (overrides: Partial<WorkBrief> = {}): WorkBrief =>
  createWorkBrief({
    identity: {
      repository,
      itemId: "8",
      kind: "executable-issue",
    },
    source: {
      provider: "github",
      repository,
      itemId: "8",
      originalBody: "Implement the durable coordinator.",
    },
    problem: "Coordination is not durable.",
    evidence: ["A worker can be restarted after a remote write."],
    acceptanceCriteria: ["The remote write is recoverable."],
    exclusions: ["No provisioning."],
    risk: "medium",
    verification: {
      checks: ["npm test -- src/workflow/coordinator/coordinator.test.ts"],
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
    policyRevision: "policy-1",
    skillRevision: "skills-1",
    createdAt: "2026-09-17T12:00:00.000Z",
    ...overrides,
  });

const event = (
  deliveryId: string,
  observedAt: string,
  relevantRevision: string,
  options: Partial<WorkflowEventInput> = {},
): WorkflowEventInput => ({
  deliveryId,
  brief: brief(options.brief ? options.brief : {}),
  policy: options.policy ?? policy(),
  phase: options.phase ?? "implementation",
  relevantRevision,
  observedAt,
  sourceState: options.sourceState,
});

const createClock = (): CoordinatorClock & {
  advance(milliseconds: number): void;
} => {
  let now = 0;
  return {
    now: () => new Date(now).toISOString(),
    nowMilliseconds: () => now,
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
};

const createCoordinator = (clock = createClock()) => {
  const storage = new InMemoryCoordinatorStorage();
  return {
    clock,
    storage,
    coordinator: new WorkflowCoordinator({
      storage,
      clock,
      infrastructureRetryLimit: 2,
      dispatchClaimTtlMs: 10,
    }),
  };
};

describe("workflow coordinator", () => {
  it.each(["triage", "implementation", "repair"] as const)(
    "binds the routine agent model to each %s assignment",
    async (phase) => {
      const { coordinator } = createCoordinator();
      const phaseBrief = brief({
        identity: {
          repository,
          itemId: "8",
          kind: phase === "repair" ? "pr-repair" : "executable-issue",
        },
        risk: "high",
      });
      const selectedPolicy = policy({
        worker: {
          provider: "selected-provider",
          models: { routine: "routine-alias", strong: "strong-alias" },
          sandbox: "fixture",
          skillRevision: "skills-1",
        },
      });
      await coordinator.ingest(
        event(
          `delivery-${phase}-role`,
          "2026-09-17T12:00:00.000Z",
          "a".repeat(40),
          {
            brief: phaseBrief,
            policy: selectedPolicy,
            phase,
          },
        ),
      );
      const dispatch = await coordinator.dispatchNext({
        repository,
        workerId: "worker-a",
      });

      expect(dispatch.assignment?.agentSelection).toEqual({
        provider: "selected-provider",
        model: "routine-alias",
        role: "routine",
      });
      expect(dispatch.job?.phaseAttempts[phase]).toBe(1);
    },
  );

  it("reuses the selected model within the bounded infrastructure retry", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event(
        "delivery-model-retry",
        "2026-09-17T12:00:00.000Z",
        "a".repeat(40),
        {
          policy: policy({
            worker: {
              provider: "selected-provider",
              models: { routine: "routine-alias", strong: "strong-alias" },
              sandbox: "fixture",
              skillRevision: "skills-1",
            },
            phaseBudgets: {
              ...policy().phaseBudgets,
              implementation: { maxAttempts: 1, timeoutSeconds: 60 },
            },
          }),
        },
      ),
    );
    const first = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    await coordinator.recordInfrastructureFailure({
      jobId: received.job!.id,
      assignmentId: first.assignment!.id,
      error: "Worker process exited before returning a result",
    });

    const retry = await coordinator.dispatchNext({
      repository,
      workerId: "worker-b",
    });
    const retriedJob = await coordinator.getJob(received.job!.id);

    expect(retry.assignment?.id).toBe(first.assignment?.id);
    expect(retry.assignment?.attempt).toBe(1);
    expect(retry.assignment?.agentSelection).toEqual(
      first.assignment?.agentSelection,
    );
    expect(retriedJob?.phaseAttempts.implementation).toBe(1);
  });

  it("converges duplicate and out-of-order deliveries on one job and dispatch", async () => {
    const { coordinator } = createCoordinator();
    const newer = await coordinator.ingest(
      event("delivery-new", "2026-09-17T12:00:02.000Z", "b".repeat(40)),
    );
    const older = await coordinator.ingest(
      event("delivery-old", "2026-09-17T12:00:01.000Z", "a".repeat(40)),
    );
    const duplicate = await coordinator.ingest(
      event("delivery-new", "2026-09-17T12:00:02.000Z", "b".repeat(40)),
    );

    expect(newer.disposition).toBe("accepted");
    expect(older.disposition).toBe("out-of-order");
    expect(duplicate.disposition).toBe("duplicate");
    expect(older.job?.id).toBe(newer.job?.id);
    expect(duplicate.job?.id).toBe(newer.job?.id);

    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    expect(dispatch.status).toBe("dispatched");
    expect(dispatch.assignment?.briefRevision).toBe(1);

    const secondDispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-b",
    });
    expect(secondDispatch.status).toBe("none");
  });

  it("reconciles an external effect after a crash between publish and acknowledgement", async () => {
    const { coordinator, storage } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-1", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    let remoteRef: string | undefined;
    const publish = vi.fn(async () => {
      remoteRef = "pull/8";
      throw new Error("connection lost after remote write");
    });

    await expect(
      coordinator.publishEffect({
        jobId: received.job!.id,
        lease,
        kind: "pull-request",
        marker: "shipyard:job-8",
        payload: { title: "Durable coordinator" },
        publish,
      }),
    ).rejects.toThrow("connection lost");

    const restarted = new WorkflowCoordinator({
      storage,
      clock: createCoordinator().clock,
    });
    const reconciled = await restarted.publishEffect({
      jobId: received.job!.id,
      lease,
      kind: "pull-request",
      marker: "shipyard:job-8",
      payload: { title: "Durable coordinator" },
      reconcile: async () => remoteRef,
      publish: vi.fn(async () => "unexpected-new-pull-request"),
    });

    expect(reconciled.disposition).toBe("reconciled");
    expect(reconciled.externalRef).toBe("pull/8");
    expect(publish).toHaveBeenCalledTimes(1);
    expect(dispatch.assignment).toBeDefined();
  });

  it("fences an expired branch writer after reassignment", async () => {
    const { coordinator, clock } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-1", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    const first = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 10,
    });
    clock.advance(11);
    const second = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-b",
      ttlMs: 10,
    });
    const publish = vi.fn(async () => "pull/8");

    await expect(
      coordinator.heartbeatBranchLease(first),
    ).rejects.toBeInstanceOf(LeaseLostError);
    await expect(
      coordinator.publishEffect({
        jobId: received.job!.id,
        lease: first,
        kind: "comment",
        marker: "shipyard:effect-1",
        publish,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(publish).not.toHaveBeenCalled();

    const published = await coordinator.publishEffect({
      jobId: received.job!.id,
      lease: second,
      kind: "comment",
      marker: "shipyard:effect-1",
      publish,
    });
    expect(published.disposition).toBe("published");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid lease from publishing another workflow job", async () => {
    const { coordinator } = createCoordinator();
    const first = await coordinator.ingest(
      event("delivery-lease-a", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    const second = await coordinator.ingest(
      event("delivery-lease-b", "2026-09-17T12:00:01.000Z", "b".repeat(40), {
        brief: brief({
          identity: { repository, itemId: "9", kind: "executable-issue" },
          source: {
            provider: "github",
            repository,
            itemId: "9",
            originalBody: "Implement the durable coordinator.",
          },
        }),
      }),
    );
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: first.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    const publish = vi.fn(async () => "remote-effect");

    await expect(
      coordinator.publishEffect({
        jobId: second.job!.id,
        lease,
        kind: "comment",
        marker: "cross-job-effect",
        publish,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects a valid lease from publishing to another branch", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event(
        "delivery-branch-binding",
        "2026-09-17T12:00:00.000Z",
        "a".repeat(40),
      ),
    );
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    const publish = vi.fn(async () => "remote-effect");

    await expect(
      coordinator.publishEffect({
        jobId: received.job!.id,
        lease,
        branch: "feature/other",
        kind: "pull-request",
        marker: "cross-branch-effect",
        publish,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("rejects publication for a head that is not the current candidate", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event(
        "delivery-head-binding",
        "2026-09-17T12:00:00.000Z",
        "a".repeat(40),
      ),
    );
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    await expect(
      coordinator.recordPhaseResult({
        jobId: received.job!.id,
        lease,
        result: {
          contractVersion: WORKFLOW_CONTRACT_VERSION,
          assignmentId: dispatch.assignment!.id,
          phase: "implementation",
          outcome: "failed",
          identity: received.job!.brief.identity,
          briefHash: "f".repeat(64),
          base: received.job!.brief.base,
          head: { branch: "feature/8", sha: "c".repeat(40) },
          summary: "The candidate failed verification.",
          evidence: [],
          checks: [],
          commits: [],
          artifacts: [],
          questions: [],
          findings: [],
          completedAt: "2026-09-17T12:00:01.000Z",
        },
      }),
    ).rejects.toThrow("does not match its assignment");
    await coordinator.recordPhaseResult({
      jobId: received.job!.id,
      lease,
      result: {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: dispatch.assignment!.id,
        phase: "implementation",
        outcome: "failed",
        identity: received.job!.brief.identity,
        briefHash: received.job!.brief.hash,
        base: received.job!.brief.base,
        head: { branch: "feature/8", sha: "c".repeat(40) },
        summary: "The candidate failed verification.",
        evidence: [],
        checks: [],
        commits: [],
        artifacts: [],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:01.000Z",
      },
    });

    const publish = vi.fn(async () => "remote-effect");
    await expect(
      coordinator.publishEffect({
        jobId: received.job!.id,
        lease,
        branch: "feature/8",
        headSha: "d".repeat(40),
        kind: "github-check",
        marker: "wrong-head",
        publish,
      }),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(publish).not.toHaveBeenCalled();
  });

  it("keeps partial evidence while cancellation and repository stop block work", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-1", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    await coordinator.setRepositoryStop({ repository, stopped: true });
    expect(
      (await coordinator.dispatchNext({ repository, workerId: "worker-a" }))
        .status,
    ).toBe("none");

    await coordinator.setRepositoryStop({ repository, stopped: false });
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    await coordinator.cancelJob(received.job!.id, "operator requested stop");

    await expect(
      coordinator.publishEffect({
        jobId: received.job!.id,
        lease,
        kind: "pull-request",
        marker: "shipyard:cancelled",
        publish: vi.fn(async () => "should-not-publish"),
      }),
    ).rejects.toThrow();

    await coordinator.recordPhaseResult({
      jobId: received.job!.id,
      result: {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: dispatch.assignment!.id,
        phase: "implementation",
        outcome: "cancelled",
        identity: received.job!.brief.identity,
        briefHash: received.job!.brief.hash,
        base: received.job!.brief.base,
        summary: "Worker stopped after partial work.",
        evidence: ["Observed the remote branch before cancellation."],
        checks: [],
        commits: [],
        artifacts: ["logs/effect-attempt-1"],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:03.000Z",
      },
      lease,
    });

    const cancelled = await coordinator.getJob(received.job!.id);
    expect(cancelled?.control).toBe("cancelled");
    expect(cancelled?.phaseResults).toHaveLength(1);
    expect(cancelled?.phaseResults[0]?.evidence).toContain(
      "Observed the remote branch before cancellation.",
    );
  });

  it("does not spend semantic repair budget on infrastructure retries", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-1", "2026-09-17T12:00:00.000Z", "a".repeat(40), {
        phase: "repair",
        brief: brief({
          identity: { repository, itemId: "8", kind: "pr-repair" },
        }),
      }),
    );
    const first = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    expect(first.status).toBe("dispatched");

    const before = await coordinator.getJob(received.job!.id);
    expect(before?.repairBatches).toBe(1);
    const retry = await coordinator.recordInfrastructureFailure({
      jobId: received.job!.id,
      assignmentId: first.assignment!.id,
      error: "worker process exited before handoff",
    });
    expect(retry.status).toBe("retry-scheduled");

    const after = await coordinator.getJob(received.job!.id);
    expect(after?.repairBatches).toBe(1);
    expect(after?.infrastructureRetries).toBe(1);

    const retried = await coordinator.dispatchNext({
      repository,
      workerId: "worker-b",
    });
    expect(retried.status).toBe("dispatched");
    expect(retried.assignment?.id).toBe(first.assignment?.id);
  });

  it("keeps clarification and post-result phase state across pause and resume", async () => {
    const { coordinator } = createCoordinator();
    const waiting = await coordinator.ingest(
      event("delivery-waiting", "2026-09-17T12:00:00.000Z", "a".repeat(40), {
        phase: "triage",
        brief: brief({
          authorization: { status: "pending" },
          unresolvedQuestions: ["Which behavior should change?"],
        }),
      }),
    );

    await coordinator.pauseJob(waiting.job!.id, "operator review");
    const resumedWaiting = await coordinator.resumeJob(waiting.job!.id);
    expect(resumedWaiting.state).toBe("waiting-info");

    const active = await coordinator.ingest(
      event("delivery-active", "2026-09-17T12:00:01.000Z", "b".repeat(40)),
    );
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
      jobId: active.job!.id,
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: active.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });
    await coordinator.pauseJob(active.job!.id, "pause while worker reports");
    const phaseResult = await coordinator.recordPhaseResult({
      jobId: active.job!.id,
      lease,
      result: {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: dispatch.assignment!.id,
        phase: "implementation",
        outcome: "completed",
        identity: active.job!.brief.identity,
        briefHash: active.job!.brief.hash,
        base: active.job!.brief.base,
        head: { branch: "feature/8", sha: "c".repeat(40) },
        summary: "Implemented the change.",
        evidence: ["The implementation is covered."],
        checks: [],
        commits: ["c".repeat(40)],
        artifacts: [],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:02.000Z",
      },
    });

    expect(phaseResult.job.control).toBe("paused");
    expect(phaseResult.job.state).toBe("checking");
    expect((await coordinator.resumeJob(active.job!.id)).state).toBe(
      "checking",
    );
  });

  it("binds checks and reviews to the assigned candidate and routes open findings to repair", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-review", "2026-09-17T12:00:00.000Z", "a".repeat(40), {
        brief: brief({ risk: "low", scope: "substantial" }),
        policy: policy({
          worker: {
            provider: "selected-provider",
            models: { routine: "routine-alias", strong: "strong-alias" },
            sandbox: "fixture",
            skillRevision: "skills-1",
          },
        }),
      }),
    );
    const implementation = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
      jobId: received.job!.id,
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 1_000,
    });
    const candidateHead = { branch: "feature/8", sha: "c".repeat(40) };
    await coordinator.recordPhaseResult({
      jobId: received.job!.id,
      lease,
      result: {
        contractVersion: WORKFLOW_CONTRACT_VERSION,
        assignmentId: implementation.assignment!.id,
        phase: "implementation",
        outcome: "completed",
        identity: received.job!.brief.identity,
        briefHash: received.job!.brief.hash,
        base: received.job!.brief.base,
        head: candidateHead,
        summary: "Implemented the change.",
        evidence: ["Implementation evidence."],
        checks: [],
        commits: [candidateHead.sha],
        artifacts: [],
        questions: [],
        findings: [],
        completedAt: "2026-09-17T12:00:01.000Z",
      },
    });
    await expect(
      coordinator.schedulePhase({
        jobId: received.job!.id,
        phase: "checking",
        relevantRevision: candidateHead.sha,
        head: { branch: "other/branch", sha: candidateHead.sha },
      }),
    ).rejects.toThrow("current candidate");
    await coordinator.schedulePhase({
      jobId: received.job!.id,
      phase: "checking",
      relevantRevision: candidateHead.sha,
      head: candidateHead,
    });
    const checking = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
      jobId: received.job!.id,
    });
    expect(checking.assignment?.head).toEqual(candidateHead);
    const checkResult = {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      assignmentId: checking.assignment!.id,
      phase: "checking" as const,
      outcome: "completed" as const,
      identity: received.job!.brief.identity,
      briefHash: received.job!.brief.hash,
      base: received.job!.brief.base,
      head: candidateHead,
      summary: "Checked the change.",
      evidence: ["Checks passed."],
      checks: [
        {
          name: "typecheck",
          command: "npm run typecheck",
          status: "passed" as const,
          summary: "passed",
          baseSha: received.job!.brief.base.sha,
          headSha: candidateHead.sha,
          briefHash: received.job!.brief.hash,
        },
      ],
      commits: [],
      artifacts: [],
      questions: [],
      findings: [],
      completedAt: "2026-09-17T12:00:02.000Z",
    };
    await expect(
      coordinator.recordPhaseResult({
        jobId: received.job!.id,
        lease,
        result: {
          ...checkResult,
          head: { ...candidateHead, sha: "d".repeat(40) },
        },
      }),
    ).rejects.toThrow("assigned candidate");
    await coordinator.recordPhaseResult({
      jobId: received.job!.id,
      lease,
      result: checkResult,
    });
    await coordinator.schedulePhase({
      jobId: received.job!.id,
      phase: "review",
      relevantRevision: candidateHead.sha,
      head: candidateHead,
    });
    const reviewDispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
      jobId: received.job!.id,
    });
    expect(reviewDispatch.assignment?.agentSelection).toEqual({
      provider: "selected-provider",
      model: "strong-alias",
      role: "strong",
    });
    const reviewResult = {
      contractVersion: WORKFLOW_CONTRACT_VERSION,
      assignmentId: reviewDispatch.assignment!.id,
      phase: "review" as const,
      outcome: "completed" as const,
      identity: received.job!.brief.identity,
      briefHash: received.job!.brief.hash,
      base: received.job!.brief.base,
      head: candidateHead,
      summary: "Found a blocking issue.",
      evidence: ["Review evidence."],
      checks: checkResult.checks,
      commits: [],
      artifacts: [],
      questions: [],
      findings: [
        {
          id: "review-1",
          severity: "high" as const,
          axis: "spec" as const,
          disposition: "open" as const,
          title: "Behavior is incomplete",
          evidence: "The acceptance case still fails.",
        },
      ],
      reviewAxes: ["standards", "spec"] as const,
      completedAt: "2026-09-17T12:00:03.000Z",
    };
    await expect(
      coordinator.recordPhaseResult({
        jobId: received.job!.id,
        lease,
        result: {
          ...reviewResult,
          findings: [
            { ...reviewResult.findings[0]!, disposition: "accepted" as const },
          ],
        },
      }),
    ).rejects.toThrow("only submit open findings");

    const reviewed = await coordinator.recordPhaseResult({
      jobId: received.job!.id,
      lease,
      result: {
        ...reviewResult,
        findings: [
          reviewResult.findings[0]!,
          { ...reviewResult.findings[0]!, id: "review-duplicate" },
        ],
      },
    });
    expect(reviewed.job.state).toBe("repairing");
    expect(reviewed.job.phaseResults.at(-1)?.findings).toEqual([
      reviewResult.findings[0],
    ]);
  });

  it("persists a blocked state when a semantic repair budget is exhausted", async () => {
    const { coordinator } = createCoordinator();
    const repairBrief = brief({
      identity: { repository, itemId: "8", kind: "pr-repair" },
    });
    const received = await coordinator.ingest(
      event("delivery-budget", "2026-09-17T12:00:00.000Z", "a".repeat(40), {
        phase: "repair",
        brief: repairBrief,
        policy: policy({ repairBudget: { maxBatches: 1, maxFollowUps: 1 } }),
      }),
    );

    const blocked = await coordinator.scheduleRepair({
      jobId: received.job!.id,
      brief: repairBrief,
      policy: policy({ repairBudget: { maxBatches: 1, maxFollowUps: 1 } }),
      relevantRevision: "b".repeat(40),
    });

    expect(blocked.status).toBe("blocked");
    expect(blocked.reason).toBe("semantic-budget-exhausted");
    expect(blocked.job.state).toBe("blocked");
    expect(
      await coordinator.dispatchNext({
        repository,
        workerId: "worker-a",
        jobId: received.job!.id,
      }),
    ).toMatchObject({ status: "none" });
  });

  it("cancels active work when the source closes and does not dispatch planning specs", async () => {
    const { coordinator } = createCoordinator();
    await coordinator.ingest(
      event("delivery-open", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    await expect(
      coordinator.dispatchNext({ repository, workerId: "worker-a" }),
    ).resolves.toMatchObject({ status: "dispatched" });

    const closed = await coordinator.ingest(
      event("delivery-closed", "2026-09-17T12:00:01.000Z", "b".repeat(40), {
        sourceState: "closed",
      }),
    );
    expect(closed.disposition).toBe("ignored");
    expect(closed.job?.control).toBe("cancelled");
    await expect(
      coordinator.dispatchNext({ repository, workerId: "worker-b" }),
    ).resolves.toMatchObject({ status: "none" });

    const planning = await coordinator.ingest(
      event("delivery-planning", "2026-09-17T12:00:02.000Z", "c".repeat(40), {
        brief: brief({
          identity: { repository, itemId: "8", kind: "planning-spec" },
        }),
        phase: "triage",
      }),
    );
    expect(planning.disposition).toBe("accepted");
    await expect(
      coordinator.dispatchNext({ repository, workerId: "worker-c" }),
    ).resolves.toMatchObject({ status: "none" });
  });

  it("cancels active work when authorization is withdrawn", async () => {
    const { coordinator } = createCoordinator();
    await coordinator.ingest(
      event("delivery-authorized", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    await expect(
      coordinator.dispatchNext({ repository, workerId: "worker-a" }),
    ).resolves.toMatchObject({ status: "dispatched" });

    const withdrawn = await coordinator.ingest(
      event("delivery-withdrawn", "2026-09-17T12:00:01.000Z", "b".repeat(40), {
        brief: brief({
          revision: 2,
          authorization: { status: "withdrawn" },
        }),
      }),
    );

    expect(withdrawn.disposition).toBe("ignored");
    expect(withdrawn.reason).toBe("withdrawn-authorization");
    expect(withdrawn.event.ignoreReason).toBe("withdrawn-authorization");
    expect(withdrawn.job).toMatchObject({
      control: "cancelled",
      state: "cancelled",
    });
    await expect(
      coordinator.dispatchNext({ repository, workerId: "worker-b" }),
    ).resolves.toMatchObject({ status: "none" });
  });

  it("does not dispatch a terminal job's stale pending intent", async () => {
    const { coordinator, storage } = createCoordinator();
    const terminal = await coordinator.ingest(
      event("delivery-terminal", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    await storage.transaction(async (transaction) => {
      const job = await transaction.getJob(terminal.job!.id);
      await transaction.saveJob({
        ...job!,
        state: "completed",
        updatedAt: "2026-09-17T12:00:01.000Z",
        version: job!.version + 1,
      });
    });
    const next = await coordinator.ingest(
      event("delivery-next", "2026-09-17T12:00:02.000Z", "b".repeat(40), {
        brief: brief({
          identity: { repository, itemId: "9", kind: "executable-issue" },
          source: {
            provider: "github",
            repository,
            itemId: "9",
            originalBody: "Implement the durable coordinator.",
          },
        }),
      }),
    );

    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-next",
    });

    expect(dispatch.status).toBe("dispatched");
    expect(dispatch.job?.id).toBe(next.job?.id);
  });

  it("does not dispatch an approved brief whose actor role is outside policy", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event(
        "delivery-disallowed-role",
        "2026-09-17T12:00:00.000Z",
        "a".repeat(40),
        {
          brief: brief({
            authorization: {
              status: "approved",
              actor: "owner",
              actorRole: "owner",
              approvedAt: "2026-09-17T12:00:00.000Z",
            },
          }),
        },
      ),
    );

    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });

    expect(received.job?.state).toBe("waiting-info");
    expect(dispatch).toMatchObject({
      status: "blocked",
      reason: "authorization-pending",
    });
  });

  it("rejects a phase result fenced by another worker's lease", async () => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event("delivery-lease", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    const dispatch = await coordinator.dispatchNext({
      repository,
      workerId: "worker-a",
    });
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId: received.job!.id,
      workerId: "worker-a",
      ttlMs: 100,
    });

    await expect(
      coordinator.recordPhaseResult({
        jobId: received.job!.id,
        lease: { ...lease, workerId: "worker-b" },
        result: {
          contractVersion: WORKFLOW_CONTRACT_VERSION,
          assignmentId: dispatch.assignment!.id,
          phase: "implementation",
          outcome: "cancelled",
          identity: received.job!.brief.identity,
          briefHash: received.job!.brief.hash,
          base: received.job!.brief.base,
          summary: "Worker stopped.",
          evidence: ["The worker stopped before completion."],
          checks: [],
          commits: [],
          artifacts: [],
          questions: [],
          findings: [],
          completedAt: "2026-09-17T12:00:01.000Z",
        },
      }),
    ).rejects.toThrow("not bound to its assignment");
  });
});

it.each(["cancel", "pause", "stop"])(
  "blocks publication when %s occurs during reconciliation",
  async (action) => {
    const { coordinator } = createCoordinator();
    const received = await coordinator.ingest(
      event("raced-control", "2026-09-17T12:00:00.000Z", "a".repeat(40)),
    );
    const jobId = received.job!.id;
    const lease = await coordinator.acquireBranchLease({
      repository,
      branch: "feature/8",
      jobId,
      workerId: "worker-a",
      ttlMs: 10000,
    });
    const publish = vi.fn(async () => "pull/8");
    await expect(
      coordinator.publishEffect({
        jobId,
        lease,
        kind: "comment",
        marker: "raced-control",
        publish,
        reconcile: async () => {
          if (action === "cancel") await coordinator.cancelJob(jobId);
          if (action === "pause") await coordinator.pauseJob(jobId);
          if (action === "stop")
            await coordinator.setRepositoryStop({ repository, stopped: true });
          return undefined;
        },
      }),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  },
);
