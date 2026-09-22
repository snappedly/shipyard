import { randomUUID } from "node:crypto";
import {
  createAssignment,
  isAuthorizationAllowed,
  parsePhaseResult,
  parseRepositoryPolicy,
  parseWorkBrief,
  requireTransition,
  type Assignment,
  type Finding,
  type LifecycleState,
  type PhaseResult,
  type RepositoryPolicy,
  type WorkBrief,
  type WorkIdentity,
  type WorkflowPhase,
} from "../contracts/index.js";
import { sameRevision } from "../shared.js";
import { InMemoryCoordinatorStorage } from "./in-memory-storage.js";
import type {
  AcquireBranchLeaseInput,
  BranchLease,
  CoordinatorClock,
  CoordinatorStorage,
  CoordinatorStorageTransaction,
  DispatchIntent,
  DispatchRequest,
  DispatchResult,
  EffectExecution,
  EffectOperationContext,
  EffectIntent,
  InfrastructureFailureInput,
  InfrastructureRetryResult,
  IngestResult,
  PublishEffectInput,
  RepairRequestResult,
  RepositoryControl,
  SchedulePhaseInput,
  SchedulePhaseResult,
  StoredEvent,
  SubmitPhaseResultInput,
  WorkflowCoordinatorOptions,
  WorkflowEventInput,
  WorkflowJob,
  WorkKey,
} from "./types.js";

export { InMemoryCoordinatorStorage } from "./in-memory-storage.js";
export { PostgresCoordinatorStorage } from "./postgres-storage.js";
export type * from "./types.js";
export type {
  PostgresConnection,
  PostgresCoordinatorStorageOptions,
  PostgresQueryClient,
  PostgresQueryResult,
} from "./postgres-storage.js";

const defaultClock: CoordinatorClock = {
  now: () => new Date().toISOString(),
  nowMilliseconds: () => Date.now(),
};

const defaultIdFactory = (prefix: string): string =>
  `${prefix}-${randomUUID()}`;

const keyToString = (key: WorkKey): string =>
  [
    key.repository,
    key.itemId,
    String(key.briefRevision),
    key.phase,
    key.relevantRevision,
  ].join("\u0000");

const phaseState = (phase: WorkflowPhase): LifecycleState => {
  switch (phase) {
    case "implementation":
      return "implementing";
    case "checking":
      return "checking";
    case "review":
      return "reviewing";
    case "repair":
      return "repairing";
    case "handoff":
      return "human-review";
    case "merge":
      return "merged";
    case "release-verification":
      return "release-verifying";
    case "triage":
      return "authorized";
  }
};

const resultState = (result: PhaseResult): LifecycleState => {
  switch (result.outcome) {
    case "needs-info":
      return "waiting-info";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "completed":
      switch (result.phase) {
        case "implementation":
          return "checking";
        case "checking":
          return "reviewing";
        case "review":
          return result.findings.some(
            (finding) =>
              finding.severity !== "info" &&
              (finding.disposition === "open" ||
                finding.disposition === "deferred"),
          )
            ? "repairing"
            : "human-review";
        case "repair":
          return "checking";
        case "handoff":
          return "human-review";
        case "merge":
          return "merged";
        case "release-verification":
          return "completed";
        case "triage":
          return "authorized";
      }
  }
};

const normalizeWorkerReviewFindings = (
  findings: readonly Finding[],
): readonly Finding[] => {
  const byId = new Map<string, string>();
  const byContent = new Map<string, Finding>();
  for (const finding of findings) {
    if (finding.disposition !== "open") {
      throw new Error("Review workers may only submit open findings");
    }
    const contentKey = JSON.stringify([
      finding.axis,
      finding.title,
      finding.location ?? "",
      finding.requirement ?? "",
      finding.evidence,
    ]);
    const previous = byId.get(finding.id);
    if (previous !== undefined && previous !== contentKey) {
      throw new Error(`Finding id ${finding.id} identifies different findings`);
    }
    byId.set(finding.id, contentKey);
    if (!byContent.has(contentKey)) byContent.set(contentKey, finding);
  }
  return [...byContent.values()];
};

const phaseAttempts = (): Record<WorkflowPhase, number> => ({
  triage: 0,
  implementation: 0,
  checking: 0,
  review: 0,
  repair: 0,
  handoff: 0,
  merge: 0,
  "release-verification": 0,
});

const eventKey = (input: WorkflowEventInput): WorkKey => ({
  repository: input.brief.identity.repository,
  itemId: input.brief.identity.itemId,
  briefRevision: input.brief.revision,
  phase: input.phase,
  relevantRevision: input.relevantRevision,
});

const isAuthorized = (brief: WorkBrief, policy: RepositoryPolicy): boolean =>
  isAuthorizationAllowed(brief, policy);

const sameIdentity = (left: WorkIdentity, right: WorkIdentity): boolean =>
  left.repository === right.repository &&
  left.itemId === right.itemId &&
  left.kind === right.kind;

const isSameEventRevision = (
  current: WorkflowJob,
  incoming: WorkflowEventInput,
): boolean =>
  current.brief.hash === incoming.brief.hash &&
  current.key.phase === incoming.phase &&
  current.key.relevantRevision === incoming.relevantRevision;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class LeaseLostError extends Error {
  constructor(message = "Branch lease is no longer valid") {
    super(message);
    this.name = "LeaseLostError";
  }
}

export class LeaseBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseBusyError";
  }
}

export class WorkflowCoordinator {
  private readonly storage: CoordinatorStorage;
  private readonly clock: CoordinatorClock;
  private readonly idFactory: (prefix: string) => string;
  private readonly infrastructureRetryLimit: number;
  private readonly dispatchClaimTtlMs: number;
  private readonly effectClaimTtlMs: number;

  constructor(options: WorkflowCoordinatorOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? defaultClock;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.infrastructureRetryLimit = options.infrastructureRetryLimit ?? 2;
    this.dispatchClaimTtlMs = options.dispatchClaimTtlMs ?? 60_000;
    this.effectClaimTtlMs = options.effectClaimTtlMs ?? 60_000;
  }

  async getJob(jobId: string): Promise<WorkflowJob | undefined> {
    return this.storage.transaction((transaction) => transaction.getJob(jobId));
  }

  async getCurrentJob(
    identity: WorkIdentity,
  ): Promise<WorkflowJob | undefined> {
    return this.storage.transaction((transaction) =>
      transaction.findCurrentJob(identity),
    );
  }

  async getRepositoryControl(
    repository: string,
  ): Promise<RepositoryControl | undefined> {
    return this.storage.transaction((transaction) =>
      transaction.getRepositoryControl(repository),
    );
  }

  async ingest(input: WorkflowEventInput): Promise<IngestResult> {
    const brief = parseWorkBrief(input.brief);
    const policy = parseRepositoryPolicy(input.policy);
    if (policy.repository !== brief.identity.repository) {
      throw new Error("Event policy repository does not match work identity");
    }
    const key = eventKey({ ...input, brief, policy });
    const receivedAt = this.clock.now();
    const storedBase: StoredEvent = {
      ...input,
      brief,
      policy,
      id: this.idFactory("event"),
      key,
      status: "received",
      receivedAt,
    };

    return this.storage.transaction(async (transaction) => {
      const existingDelivery =
        await transaction.insertEventIfAbsent(storedBase);
      if (!existingDelivery.inserted) {
        const job = existingDelivery.event.jobId
          ? await transaction.getJob(existingDelivery.event.jobId)
          : await transaction.findCurrentJob(brief.identity);
        return {
          disposition: "duplicate",
          event: existingDelivery.event,
          job,
        };
      }

      await transaction.lockWorkIdentity(brief.identity);
      const current = await transaction.findCurrentJob(brief.identity);
      if (input.sourceState === "closed") {
        const cancelled = current
          ? await this.cancelStoredJob(
              transaction,
              current,
              "Source item is closed",
            )
          : undefined;
        const ignored = {
          ...storedBase,
          status: "ignored" as const,
          ignoreReason: "closed-item" as const,
        };
        await transaction.saveEvent(ignored);
        return {
          disposition: "ignored",
          event: ignored,
          job: cancelled,
          reason: ignored.ignoreReason,
        };
      }
      if (brief.authorization.status === "withdrawn") {
        const cancelled = current
          ? await this.cancelStoredJob(
              transaction,
              current,
              "Authorization was withdrawn",
            )
          : undefined;
        const ignored = {
          ...storedBase,
          status: "ignored" as const,
          ignoreReason: "withdrawn-authorization" as const,
        };
        await transaction.saveEvent(ignored);
        return {
          disposition: "ignored",
          event: ignored,
          job: cancelled,
          reason: ignored.ignoreReason,
        };
      }

      if (
        current !== undefined &&
        current.latestObservedAt > input.observedAt
      ) {
        const ignored = {
          ...storedBase,
          status: "ignored" as const,
          ignoreReason: "out-of-order" as const,
          jobId: current.id,
        };
        await transaction.saveEvent(ignored);
        return {
          disposition: "out-of-order",
          event: ignored,
          job: current,
          reason: ignored.ignoreReason,
        };
      }

      if (current !== undefined && isSameEventRevision(current, input)) {
        const accepted = {
          ...storedBase,
          status: "accepted" as const,
          jobId: current.id,
        };
        await transaction.saveEvent(accepted);
        return { disposition: "accepted", event: accepted, job: current };
      }

      if (current !== undefined && current.control !== "superseded") {
        const superseded: WorkflowJob = {
          ...current,
          state: "blocked",
          control: "superseded",
          activeAssignmentId: undefined,
          updatedAt: receivedAt,
          version: current.version + 1,
        };
        await transaction.saveJob(superseded);
        if (current.activeAssignmentId !== undefined) {
          const dispatch = await transaction.findDispatchByAssignmentId(
            current.activeAssignmentId,
          );
          if (dispatch !== undefined) {
            await transaction.saveDispatch({
              ...dispatch,
              status: "cancelled",
              error: "Superseded by a newer work revision",
              updatedAt: receivedAt,
            });
          }
        }
      }

      const jobId = this.idFactory("job");
      const job: WorkflowJob = {
        id: jobId,
        key,
        brief,
        policy,
        state: isAuthorized(brief, policy) ? "authorized" : "waiting-info",
        control: "active",
        phaseAttempts: phaseAttempts(),
        repairBatches: input.phase === "repair" ? 1 : 0,
        followUps: 0,
        infrastructureRetries: 0,
        infrastructureRetryLimit: this.infrastructureRetryLimit,
        assignments: [],
        phaseResults: [],
        latestObservedAt: input.observedAt,
        createdAt: receivedAt,
        updatedAt: receivedAt,
        version: 1,
      };
      await transaction.insertJob(job);
      const pendingDispatch = {
        id: this.idFactory("dispatch"),
        dedupeKey: keyToString(key),
        key,
        jobId,
        status: "pending" as const,
        createdAt: receivedAt,
        updatedAt: receivedAt,
      };
      if (brief.identity.kind !== "planning-spec") {
        await transaction.insertDispatchIfAbsent(pendingDispatch);
      }
      const accepted = {
        ...storedBase,
        status: "accepted" as const,
        jobId,
      };
      await transaction.saveEvent(accepted);
      return { disposition: "accepted", event: accepted, job };
    });
  }

  async dispatchNext(request: DispatchRequest): Promise<DispatchResult> {
    return this.storage.transaction(async (transaction) => {
      const control = await transaction.getRepositoryControl(
        request.repository,
      );
      if (control?.stopped) {
        return { status: "none", reason: "repository-stopped" };
      }

      let dispatch: DispatchIntent | undefined;
      let job: WorkflowJob | undefined;
      while (true) {
        dispatch = await transaction.findPendingDispatch(
          request.repository,
          this.clock.nowMilliseconds(),
          { jobId: request.jobId, dispatchId: request.dispatchId },
        );
        if (dispatch === undefined) return { status: "none" };
        job = await transaction.getJob(dispatch.jobId);
        if (job === undefined) {
          await transaction.saveDispatch({
            ...dispatch,
            status: "cancelled",
            error: "Dispatch references a missing workflow job",
            updatedAt: this.clock.now(),
          });
          continue;
        }

        const blockReason = this.dispatchBlockReason(job, control);
        if (
          blockReason === "job-cancelled" ||
          blockReason === "job-superseded" ||
          (blockReason === "invalid-transition" &&
            (job.state === "blocked" ||
              job.state === "cancelled" ||
              job.state === "completed" ||
              job.state === "failed"))
        ) {
          await transaction.saveDispatch({
            ...dispatch,
            status: "cancelled",
            error: blockReason,
            updatedAt: this.clock.now(),
          });
          continue;
        }
        if (blockReason !== undefined) {
          return { status: "blocked", reason: blockReason, job };
        }
        break;
      }

      if (dispatch === undefined || job === undefined) {
        return { status: "none" };
      }
      const now = this.clock.nowMilliseconds();
      let assignment: Assignment;
      let nextJob = job;
      if (dispatch.assignment !== undefined) {
        assignment = dispatch.assignment;
      } else {
        const phase = job.key.phase;
        const attempt = job.phaseAttempts[phase] + 1;
        const phaseBudget = job.policy.phaseBudgets[phase];
        if (attempt > phaseBudget.maxAttempts) {
          return {
            status: "blocked",
            reason: "semantic-budget-exhausted",
            job,
          };
        }
        assignment = createAssignment({
          id: this.idFactory("assignment"),
          phase,
          brief: job.brief,
          policy: job.policy,
          attempt,
          head: ["checking", "review", "handoff", "merge"].includes(phase)
            ? this.latestHeadForRevision(job, job.key.relevantRevision)
            : undefined,
          createdAt: this.clock.now(),
        });
        const attempts = { ...job.phaseAttempts, [phase]: attempt };
        nextJob = {
          ...job,
          state: phaseState(phase),
          phaseAttempts: attempts,
          activeAssignmentId: assignment.id,
          assignments: [...job.assignments, assignment],
          updatedAt: this.clock.now(),
          version: job.version + 1,
        };
        await transaction.saveJob(nextJob);
      }

      const claimed = {
        ...dispatch,
        status: "started" as const,
        assignment,
        workerId: request.workerId,
        claimedAt: now,
        claimExpiresAt: now + this.dispatchClaimTtlMs,
        updatedAt: this.clock.now(),
      };
      await transaction.saveDispatch(claimed);
      if (
        dispatch.assignment !== undefined &&
        job.activeAssignmentId !== assignment.id
      ) {
        nextJob = {
          ...job,
          state: phaseState(assignment.phase),
          activeAssignmentId: assignment.id,
          updatedAt: this.clock.now(),
          version: job.version + 1,
        };
        await transaction.saveJob(nextJob);
      }
      return {
        status: "dispatched",
        dispatch: claimed,
        assignment,
        job: nextJob,
      };
    });
  }

  private latestHeadForRevision(
    job: WorkflowJob,
    sha: string,
  ): { readonly branch: string; readonly sha: string } | undefined {
    return [...job.phaseResults]
      .reverse()
      .map((result) => result.head)
      .find(
        (head): head is { readonly branch: string; readonly sha: string } =>
          head?.sha === sha,
      );
  }

  private dispatchBlockReason(
    job: WorkflowJob,
    control: RepositoryControl | undefined,
  ): DispatchResult["reason"] {
    if (control?.stopped) return "repository-stopped";
    if (job.control === "cancelled") return "job-cancelled";
    if (job.control === "superseded") return "job-superseded";
    if (job.control === "paused") return "job-paused";
    if (
      job.state === "blocked" ||
      job.state === "cancelled" ||
      job.state === "completed" ||
      job.state === "failed"
    ) {
      return "invalid-transition";
    }
    if (job.brief.authorization.status === "withdrawn") {
      return "authorization-withdrawn";
    }
    if (job.key.phase !== "triage" && !isAuthorized(job.brief, job.policy)) {
      return "authorization-pending";
    }
    if (job.infrastructureRetries >= job.infrastructureRetryLimit) {
      return "infrastructure-retries-exhausted";
    }
    return undefined;
  }

  async acquireBranchLease(
    input: AcquireBranchLeaseInput,
  ): Promise<BranchLease> {
    return this.storage.transaction(async (transaction) => {
      if (!Number.isFinite(input.ttlMs) || input.ttlMs <= 0) {
        throw new Error("Branch lease ttlMs must be a positive finite number");
      }
      const job = await transaction.getJob(input.jobId);
      if (job === undefined) {
        throw new Error(`Workflow job ${input.jobId} does not exist`);
      }
      if (job.key.repository !== input.repository) {
        throw new Error(
          "Branch lease repository is not bound to its workflow job",
        );
      }
      if (job.control !== "active") {
        throw new Error(`Workflow job ${input.jobId} is ${job.control}`);
      }
      const now = this.clock.nowMilliseconds();
      const resourceKey = `${input.repository}\u0000${input.branch}`;
      await transaction.lockLeaseResource(input.repository, input.branch);
      const existing = await transaction.getLease(
        input.repository,
        input.branch,
      );
      if (existing !== undefined && existing.expiresAt > now) {
        if (
          existing.workerId === input.workerId &&
          existing.jobId === input.jobId
        ) {
          return existing;
        }
        throw new LeaseBusyError(
          `Branch ${input.branch} is leased by worker ${existing.workerId}`,
        );
      }
      const lease: BranchLease = {
        leaseId: this.idFactory("lease"),
        resourceKey,
        repository: input.repository,
        branch: input.branch,
        jobId: input.jobId,
        workerId: input.workerId,
        fencingToken: (existing?.fencingToken ?? 0) + 1,
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: now + input.ttlMs,
      };
      await transaction.saveLease(lease);
      return lease;
    });
  }

  async heartbeatBranchLease(lease: BranchLease): Promise<BranchLease> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.getLease(
        lease.repository,
        lease.branch,
      );
      this.assertLease(current, lease);
      const now = this.clock.nowMilliseconds();
      const updated = {
        ...current,
        heartbeatAt: now,
        expiresAt: Math.max(
          current.expiresAt,
          now + (current.expiresAt - current.heartbeatAt),
        ),
      };
      await transaction.saveLease(updated);
      return updated;
    });
  }

  private assertLease(
    current: BranchLease | undefined,
    lease: BranchLease,
  ): asserts current is BranchLease {
    if (
      current === undefined ||
      current.leaseId !== lease.leaseId ||
      current.fencingToken !== lease.fencingToken ||
      current.workerId !== lease.workerId ||
      current.jobId !== lease.jobId ||
      current.expiresAt <= this.clock.nowMilliseconds()
    ) {
      throw new LeaseLostError(
        `Lease ${lease.leaseId} for ${lease.branch} is expired or fenced`,
      );
    }
  }

  async publishEffect<T>(
    input: PublishEffectInput<T>,
  ): Promise<EffectExecution<T>> {
    const prepared = await this.storage.transaction(async (transaction) => {
      await this.assertPublicationAllowed(transaction, input);
      const existing = await transaction.findEffect(
        input.jobId,
        input.kind,
        input.marker,
      );
      if (existing?.status === "succeeded") {
        return { kind: "already-succeeded" as const, effect: existing };
      }
      const now = this.clock.nowMilliseconds();
      if (
        existing?.status === "claimed" &&
        existing.claimExpiresAt !== undefined &&
        existing.claimExpiresAt > now
      ) {
        return { kind: "in-flight" as const, effect: existing };
      }
      const effect: EffectIntent = existing ?? {
        id: this.idFactory("effect"),
        jobId: input.jobId,
        kind: input.kind,
        marker: input.marker,
        payload: input.payload,
        status: "pending",
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      };
      const claimed: EffectIntent = {
        ...effect,
        status: "claimed",
        workerId: input.lease.workerId,
        fencingToken: input.lease.fencingToken,
        claimedAt: now,
        claimExpiresAt: now + this.effectClaimTtlMs,
        updatedAt: this.clock.now(),
      };
      const inserted = await transaction.insertEffectIfAbsent(claimed);
      if (!inserted.inserted) {
        if (
          inserted.effect.status === "claimed" &&
          inserted.effect.claimExpiresAt !== undefined &&
          inserted.effect.claimExpiresAt > now
        ) {
          return { kind: "in-flight" as const, effect: inserted.effect };
        }
        await transaction.saveEffect(claimed);
      }
      return { kind: "execute" as const, effect: claimed };
    });

    if (prepared.kind === "already-succeeded") {
      return {
        disposition: "already-succeeded",
        effect: prepared.effect,
        externalRef: prepared.effect.externalRef as T | undefined,
      };
    }
    if (prepared.kind === "in-flight") {
      return { disposition: "in-flight", effect: prepared.effect };
    }

    const context: EffectOperationContext = {
      effect: prepared.effect,
      fencingToken: input.lease.fencingToken,
    };
    if (input.reconcile) {
      const reconciled = await input.reconcile(context);
      if (reconciled !== undefined) {
        const effect = await this.finishEffect(
          prepared.effect,
          input.lease,
          "succeeded",
          reconciled,
        );
        return {
          disposition: "reconciled",
          effect,
          externalRef: effect.externalRef as T,
        };
      }
    }

    await this.storage.transaction(async (transaction) => {
      await this.assertPublicationAllowed(transaction, input);
      const current = await transaction.findEffect(
        input.jobId,
        input.kind,
        input.marker,
      );
      if (
        current?.status !== "claimed" ||
        current.id !== prepared.effect.id ||
        current.workerId !== prepared.effect.workerId ||
        current.fencingToken !== prepared.effect.fencingToken ||
        current.claimedAt !== prepared.effect.claimedAt ||
        current.claimExpiresAt === undefined ||
        current.claimExpiresAt <= this.clock.nowMilliseconds()
      ) {
        throw new LeaseLostError("Publication claim is no longer current");
      }
    });
    try {
      const externalRef = await input.publish(context);
      const effect = await this.finishEffect(
        prepared.effect,
        input.lease,
        "succeeded",
        externalRef,
      );
      return {
        disposition: "published",
        effect,
        externalRef: effect.externalRef as T,
      };
    } catch (error) {
      await this.storage.transaction(async (transaction) => {
        const current = await transaction.findEffect(
          input.jobId,
          input.kind,
          input.marker,
        );
        if (
          current !== undefined &&
          current.id === prepared.effect.id &&
          current.status === "claimed" &&
          current.workerId === input.lease.workerId &&
          current.fencingToken === input.lease.fencingToken
        ) {
          await transaction.saveEffect({
            ...current,
            status: "uncertain",
            error: errorMessage(error),
            updatedAt: this.clock.now(),
          });
        }
      });
      throw error;
    }
  }

  private async assertPublicationAllowed<T>(
    transaction: CoordinatorStorageTransaction,
    input: PublishEffectInput<T>,
  ): Promise<void> {
    const job = await transaction.getJob(input.jobId);
    if (job === undefined)
      throw new Error(`Workflow job ${input.jobId} does not exist`);
    if (job.control !== "active") {
      throw new Error(`Workflow job ${input.jobId} is ${job.control}`);
    }
    if (
      input.lease.jobId !== input.jobId ||
      input.lease.repository !== job.key.repository
    ) {
      throw new LeaseLostError(
        `Lease ${input.lease.leaseId} is not bound to workflow job ${input.jobId}`,
      );
    }
    if (input.branch !== undefined && input.branch !== input.lease.branch) {
      throw new LeaseLostError(
        `Lease ${input.lease.leaseId} is not bound to branch ${input.branch}`,
      );
    }
    if (input.itemId !== undefined && input.itemId !== job.key.itemId) {
      throw new LeaseLostError(
        `Effect is not bound to workflow item ${job.key.itemId}`,
      );
    }
    if (input.headSha !== undefined) {
      const currentHead = [...job.phaseResults]
        .reverse()
        .map((result) => result.head)
        .find(
          (head): head is { readonly branch: string; readonly sha: string } =>
            head !== undefined,
        );
      if (
        currentHead === undefined ||
        currentHead.branch !== input.lease.branch ||
        currentHead.sha !== input.headSha
      ) {
        throw new LeaseLostError(
          `Effect head ${input.headSha} is not bound to the current candidate on ${input.lease.branch}`,
        );
      }
    }
    const control = await transaction.getRepositoryControl(job.key.repository);
    if (control?.stopped)
      throw new Error(`Repository ${job.key.repository} is stopped`);
    const currentLease = await transaction.getLease(
      input.lease.repository,
      input.lease.branch,
    );
    this.assertLease(currentLease, input.lease);
  }

  private async finishEffect<T>(
    effect: EffectIntent,
    lease: BranchLease,
    status: "succeeded",
    externalRef: T,
  ): Promise<EffectIntent> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.findEffect(
        effect.jobId,
        effect.kind,
        effect.marker,
      );
      if (current === undefined)
        throw new Error(`Effect ${effect.id} disappeared`);
      if (current.status === "succeeded") return current;
      if (
        current.id !== effect.id ||
        current.status !== "claimed" ||
        current.workerId !== lease.workerId ||
        current.fencingToken !== lease.fencingToken
      ) {
        throw new LeaseLostError(`Effect ${effect.id} is no longer owned`);
      }
      const leaseNow = await transaction.getLease(
        lease.repository,
        lease.branch,
      );
      this.assertLease(leaseNow, lease);
      const finished = {
        ...current,
        status,
        externalRef,
        updatedAt: this.clock.now(),
      };
      await transaction.saveEffect(finished);
      return finished;
    });
  }

  async recordPhaseResult(
    input: SubmitPhaseResultInput,
  ): Promise<{ job: WorkflowJob; duplicate: boolean; transitioned: boolean }> {
    const parsedResult = parsePhaseResult(input.result);
    const result =
      parsedResult.phase === "review"
        ? {
            ...parsedResult,
            findings: normalizeWorkerReviewFindings(parsedResult.findings),
          }
        : parsedResult;
    return this.storage.transaction(async (transaction) => {
      let job = await transaction.getJob(input.jobId);
      if (job === undefined)
        throw new Error(`Workflow job ${input.jobId} does not exist`);
      if (
        job.phaseResults.some(
          (candidate) => candidate.assignmentId === result.assignmentId,
        )
      ) {
        return { job, duplicate: true, transitioned: false };
      }
      const assignment = job.assignments.find(
        (candidate) => candidate.id === result.assignmentId,
      );
      if (assignment === undefined) {
        throw new Error(
          `Phase result ${result.assignmentId} is not assigned to job ${job.id}`,
        );
      }
      if (
        assignment.phase !== result.phase ||
        !sameIdentity(assignment.identity, result.identity) ||
        assignment.briefHash !== result.briefHash
      ) {
        throw new Error("Phase result does not match its assignment");
      }
      if (
        result.base !== undefined &&
        !sameRevision(result.base, assignment.base)
      ) {
        throw new Error("Phase result base revision does not match assignment");
      }
      if (
        ["checking", "review", "handoff", "merge"].includes(assignment.phase) &&
        (result.base === undefined ||
          !sameRevision(result.base, assignment.base) ||
          assignment.head === undefined ||
          result.head === undefined ||
          !sameRevision(result.head, assignment.head))
      ) {
        throw new Error("Phase result is not bound to the assigned candidate");
      }
      const dispatch = await transaction.findDispatchByAssignmentId(
        result.assignmentId,
      );
      if (
        dispatch === undefined ||
        dispatch.jobId !== job.id ||
        dispatch.assignment?.id !== result.assignmentId
      ) {
        throw new Error("Phase result is not bound to an active dispatch");
      }
      if (dispatch.status !== "started" && dispatch.status !== "claimed") {
        throw new Error("Phase result dispatch is no longer active");
      }
      if (
        dispatch.claimExpiresAt !== undefined &&
        dispatch.claimExpiresAt <= this.clock.nowMilliseconds()
      ) {
        throw new Error("Phase result dispatch claim has expired");
      }
      if (
        input.lease.repository !== job.key.repository ||
        input.lease.jobId !== job.id ||
        dispatch.workerId === undefined ||
        input.lease.workerId !== dispatch.workerId
      ) {
        throw new Error("Phase result lease is not bound to its assignment");
      }
      const expectedLeaseBranch =
        assignment.phase === "review"
          ? assignment.head?.branch
          : result.head?.branch;
      if (
        expectedLeaseBranch !== undefined &&
        input.lease.branch !== expectedLeaseBranch
      ) {
        throw new Error("Phase result lease is not bound to its branch");
      }
      const currentLease = await transaction.getLease(
        input.lease.repository,
        input.lease.branch,
      );
      this.assertLease(currentLease, input.lease);
      const nextState = resultState(result);
      const nextResults = [...job.phaseResults, result];
      const nextAssignments = job.assignments;
      const nextControl =
        result.outcome === "cancelled" ? "cancelled" : job.control;
      let state = job.state;
      if (job.control !== "cancelled" && job.control !== "superseded") {
        try {
          requireTransition(job.state, nextState, {
            kind: job.brief.identity.kind,
            authorization: job.brief.authorization.status,
            checks: result.checks,
            requiredCheckNames: job.policy.checks
              .filter((check) => check.required)
              .map((check) => check.name),
            checkCandidate:
              assignment.head === undefined
                ? undefined
                : {
                    baseSha: assignment.base.sha,
                    headSha: assignment.head.sha,
                    briefHash: assignment.briefHash,
                  },
            review: {
              outcome:
                result.outcome === "completed" && result.phase === "review"
                  ? "passed"
                  : "incomplete",
              axes:
                result.reviewAxes ??
                result.findings.map((finding) => finding.axis),
              findings: result.findings,
              headSha: assignment.head?.sha ?? "",
              briefHash: assignment.briefHash,
            },
          });
          state = nextState;
        } catch {
          if (result.outcome !== "cancelled")
            throw new Error(`Invalid phase result transition to ${nextState}`);
          state = "cancelled";
        }
      }
      job = {
        ...job,
        state,
        control: nextControl,
        infrastructureRetries: 0,
        activeAssignmentId:
          job.activeAssignmentId === result.assignmentId
            ? undefined
            : job.activeAssignmentId,
        assignments: nextAssignments,
        phaseResults: nextResults,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(job);
      await transaction.saveDispatch({
        ...dispatch,
        status: result.outcome === "cancelled" ? "cancelled" : "completed",
        updatedAt: this.clock.now(),
      });
      return { job, duplicate: false, transitioned: true };
    });
  }

  async recordInfrastructureFailure(
    input: InfrastructureFailureInput,
  ): Promise<InfrastructureRetryResult> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(input.jobId);
      if (job === undefined)
        throw new Error(`Workflow job ${input.jobId} does not exist`);
      const dispatch = await transaction.findDispatchByAssignmentId(
        input.assignmentId,
      );
      if (dispatch === undefined) {
        return { status: "not-retryable", job };
      }
      if (
        dispatch.jobId !== input.jobId ||
        dispatch.assignment?.id !== input.assignmentId ||
        (dispatch.status !== "started" && dispatch.status !== "claimed")
      ) {
        return { status: "not-retryable", job };
      }
      if (job.infrastructureRetries >= job.infrastructureRetryLimit) {
        const blocked = {
          ...job,
          state: "blocked" as const,
          updatedAt: this.clock.now(),
          version: job.version + 1,
        };
        await transaction.saveJob(blocked);
        await transaction.saveDispatch({
          ...dispatch,
          status: "failed",
          error: input.error,
          updatedAt: this.clock.now(),
        });
        return { status: "exhausted", job: blocked };
      }
      const retried = {
        ...job,
        state: phaseState(dispatch.key.phase),
        infrastructureRetries: job.infrastructureRetries + 1,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(retried);
      const pending = {
        ...dispatch,
        status: "pending" as const,
        error: input.error,
        workerId: undefined,
        claimedAt: undefined,
        claimExpiresAt: undefined,
        updatedAt: this.clock.now(),
      };
      await transaction.saveDispatch(pending);
      return { status: "retry-scheduled", job: retried, dispatch: pending };
    });
  }

  async setRepositoryStop(input: {
    readonly repository: string;
    readonly stopped: boolean;
    readonly reason?: string;
  }): Promise<RepositoryControl> {
    return this.storage.transaction(async (transaction) => {
      const control: RepositoryControl = {
        repository: input.repository,
        stopped: input.stopped,
        reason: input.reason,
        updatedAt: this.clock.now(),
      };
      await transaction.saveRepositoryControl(control);
      return control;
    });
  }

  async pauseJob(jobId: string, reason?: string): Promise<WorkflowJob> {
    return this.updateJobControl(jobId, "paused", reason);
  }

  async cancelJob(jobId: string, reason?: string): Promise<WorkflowJob> {
    return this.updateJobControl(jobId, "cancelled", reason);
  }

  async supersedeJob(jobId: string, reason?: string): Promise<WorkflowJob> {
    return this.updateJobControl(jobId, "superseded", reason);
  }

  async resumeJob(jobId: string): Promise<WorkflowJob> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(jobId);
      if (job === undefined)
        throw new Error(`Workflow job ${jobId} does not exist`);
      if (job.control !== "paused")
        throw new Error(`Workflow job ${jobId} is not paused`);
      const resumed = {
        ...job,
        control: "active" as const,
        state: job.state,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(resumed);
      return resumed;
    });
  }

  private async updateJobControl(
    jobId: string,
    control: "paused" | "cancelled" | "superseded",
    reason?: string,
  ): Promise<WorkflowJob> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(jobId);
      if (job === undefined)
        throw new Error(`Workflow job ${jobId} does not exist`);
      const state =
        control === "cancelled"
          ? "cancelled"
          : control === "superseded"
            ? "blocked"
            : job.state;
      const updated = {
        ...job,
        control,
        state,
        activeAssignmentId:
          control === "paused" ? job.activeAssignmentId : undefined,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(updated);
      const dispatch = job.activeAssignmentId
        ? await transaction.findDispatchByAssignmentId(job.activeAssignmentId)
        : undefined;
      if (
        dispatch !== undefined &&
        control !== "paused" &&
        dispatch.status !== "started" &&
        dispatch.status !== "claimed"
      ) {
        await transaction.saveDispatch({
          ...dispatch,
          status: "cancelled",
          error: reason,
          updatedAt: this.clock.now(),
        });
      }
      return updated;
    });
  }

  async schedulePhase(input: SchedulePhaseInput): Promise<SchedulePhaseResult> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(input.jobId);
      if (job === undefined) {
        throw new Error(`Workflow job ${input.jobId} does not exist`);
      }
      if (job.control !== "active") {
        const reason =
          job.control === "paused"
            ? "job-paused"
            : job.control === "superseded"
              ? "job-superseded"
              : "job-cancelled";
        return { status: "blocked", job, reason };
      }
      if (
        input.head !== undefined &&
        input.head.sha !== input.relevantRevision
      ) {
        throw new Error("Scheduled phase head does not match its revision");
      }
      if (["checking", "review", "handoff", "merge"].includes(input.phase)) {
        const currentCandidate = this.latestHeadForRevision(
          job,
          input.relevantRevision,
        );
        if (
          input.head === undefined ||
          currentCandidate === undefined ||
          !sameRevision(input.head, currentCandidate)
        ) {
          throw new Error(
            "Scheduled phase head does not match the current candidate",
          );
        }
      }
      if (input.phase !== "triage" && !isAuthorized(job.brief, job.policy)) {
        return {
          status: "blocked",
          job,
          reason: "authorization-pending",
        };
      }

      const key: WorkKey = {
        repository: job.key.repository,
        itemId: job.key.itemId,
        briefRevision: job.brief.revision,
        phase: input.phase,
        relevantRevision: input.relevantRevision,
      };
      const dedupeKey = keyToString(key);
      const existing = await transaction.findDispatchByDedupeKey(dedupeKey);
      if (existing !== undefined) {
        return existing.jobId === job.id
          ? { status: "duplicate", job, dispatch: existing }
          : {
              status: "blocked",
              job,
              reason: "A different workflow job owns this phase dispatch",
            };
      }

      const targetState = phaseState(input.phase);
      let state = job.state;
      if (targetState !== state) {
        const latestChecks = [...job.phaseResults]
          .reverse()
          .find((result) => result.checks.length > 0)?.checks;
        try {
          requireTransition(state, targetState, {
            kind: job.brief.identity.kind,
            authorization: job.brief.authorization.status,
            checks: latestChecks,
            requiredCheckNames: job.policy.checks
              .filter((check) => check.required)
              .map((check) => check.name),
            checkCandidate:
              input.head === undefined
                ? undefined
                : {
                    baseSha: job.brief.base.sha,
                    headSha: input.head.sha,
                    briefHash: job.brief.hash,
                  },
          });
          state = targetState;
        } catch (error) {
          return {
            status: "blocked",
            job,
            reason:
              error instanceof Error ? error.message : "invalid-transition",
          };
        }
      }

      const updated: WorkflowJob = {
        ...job,
        key,
        state,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(updated);
      const dispatch = {
        id: this.idFactory("dispatch"),
        dedupeKey,
        key,
        jobId: job.id,
        status: "pending" as const,
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      };
      const inserted = await transaction.insertDispatchIfAbsent(dispatch);
      return {
        status: inserted.inserted ? "scheduled" : "duplicate",
        job: updated,
        dispatch: inserted.dispatch,
      };
    });
  }

  async scheduleRepair(input: {
    readonly jobId: string;
    readonly brief: WorkBrief;
    readonly policy: RepositoryPolicy;
    readonly followUp?: boolean;
    readonly relevantRevision?: string;
  }): Promise<RepairRequestResult> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(input.jobId);
      if (job === undefined)
        throw new Error(`Workflow job ${input.jobId} does not exist`);
      if (job.control !== "active") {
        const reason =
          job.control === "paused"
            ? "job-paused"
            : job.control === "superseded"
              ? "job-superseded"
              : "job-cancelled";
        return { status: "blocked", job, reason };
      }
      const brief = parseWorkBrief(input.brief);
      const policy = parseRepositoryPolicy(input.policy);
      if (!sameIdentity(brief.identity, job.brief.identity)) {
        throw new Error("Repair brief does not match the workflow identity");
      }
      if (policy.repository !== job.key.repository) {
        throw new Error("Repair policy repository does not match the workflow");
      }
      if (brief.policyRevision !== policy.revision) {
        throw new Error("Repair brief and policy revisions do not match");
      }
      if (!isAuthorized(brief, policy)) {
        throw new Error("Repair requires approved authorization");
      }
      const key: WorkKey = {
        repository: job.key.repository,
        itemId: job.key.itemId,
        briefRevision: brief.revision,
        phase: "repair",
        relevantRevision: input.relevantRevision ?? job.key.relevantRevision,
      };
      const existing = await transaction.findDispatchByDedupeKey(
        keyToString(key),
      );
      if (existing !== undefined) {
        return existing.jobId === job.id
          ? { status: "scheduled", job, dispatch: existing }
          : {
              status: "blocked",
              job,
              reason: "A different workflow job owns this repair dispatch",
            };
      }
      if (
        input.followUp === true
          ? job.followUps >= job.policy.repairBudget.maxFollowUps
          : job.repairBatches >= job.policy.repairBudget.maxBatches
      ) {
        const blocked: WorkflowJob = {
          ...job,
          state: "blocked",
          updatedAt: this.clock.now(),
          version: job.version + 1,
        };
        await transaction.saveJob(blocked);
        return {
          status: "blocked",
          job: blocked,
          reason: "semantic-budget-exhausted",
        };
      }
      const pending = {
        ...job,
        key,
        brief,
        policy,
        state: "repairing" as const,
        repairBatches: job.repairBatches + (input.followUp === true ? 0 : 1),
        followUps: job.followUps + (input.followUp === true ? 1 : 0),
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(pending);
      const dispatch = {
        id: this.idFactory("dispatch"),
        dedupeKey: keyToString(key),
        key,
        jobId: job.id,
        status: "pending" as const,
        createdAt: this.clock.now(),
        updatedAt: this.clock.now(),
      };
      const inserted = await transaction.insertDispatchIfAbsent(dispatch);
      return {
        status: "scheduled",
        job: pending,
        dispatch: inserted.dispatch,
      };
    });
  }

  private async cancelStoredJob(
    transaction: CoordinatorStorageTransaction,
    job: WorkflowJob,
    reason: string,
  ): Promise<WorkflowJob> {
    const cancelled: WorkflowJob = {
      ...job,
      state: "cancelled",
      control: "cancelled",
      activeAssignmentId: undefined,
      updatedAt: this.clock.now(),
      version: job.version + 1,
    };
    await transaction.saveJob(cancelled);
    if (job.activeAssignmentId !== undefined) {
      const dispatch = await transaction.findDispatchByAssignmentId(
        job.activeAssignmentId,
      );
      if (
        dispatch !== undefined &&
        dispatch.status !== "started" &&
        dispatch.status !== "claimed"
      ) {
        await transaction.saveDispatch({
          ...dispatch,
          status: "cancelled",
          error: reason,
          updatedAt: this.clock.now(),
        });
      }
    }
    return cancelled;
  }
}
