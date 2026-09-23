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
import {
  defaultDeliveryGroup,
  deliveryContainsIdentity,
  deliveryGroupFingerprint,
  deliveryIdFor,
  deliveryResourceKey,
  parseDeliveryRecord,
  resolveDeliveryGroup,
} from "./delivery.js";
import type {
  AcquireBranchLeaseInput,
  AcquireDeliveryLeaseInput,
  BranchLease,
  CoordinatorClock,
  CoordinatorStorage,
  CoordinatorStorageTransaction,
  DeliveryFailureEvidence,
  DeliveryGroup,
  DeliveryKey,
  DeliveryLease,
  DeliveryRecord,
  DeliveryWorkflowState,
  DispatchIntent,
  DispatchRequest,
  DispatchResult,
  ExpandDeliveryScopeInput,
  EffectExecution,
  EffectOperationContext,
  EffectIntent,
  InfrastructureFailureInput,
  InfrastructureRetryResult,
  IngestResult,
  PublishEffectInput,
  RepairRequestResult,
  ReclaimBlockedJobResult,
  RepositoryControl,
  SchedulePhaseInput,
  SchedulePhaseResult,
  SpecDeliveryCheckpoint,
  StoredEvent,
  SubmitPhaseResultInput,
  WorkflowCoordinatorOptions,
  WorkflowEventInput,
  WorkflowJob,
  WorkKey,
} from "./types.js";

export { InMemoryCoordinatorStorage } from "./in-memory-storage.js";
export { PostgresCoordinatorStorage } from "./postgres-storage.js";
export {
  defaultDeliveryGroup,
  deliveryContainsIdentity,
  deliveryGroupFingerprint,
  deliveryIdFor,
  deliveryResourceKey,
  parseDeliveryRecord,
  resolveDeliveryGroup,
} from "./delivery.js";
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

const sanitizeDiagnostic = (value: string, limit = 600): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/gi, "[REDACTED]")
    .replace(
      /\b(?:authorization|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

const safeReference = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const sanitized = sanitizeDiagnostic(value, 240);
  return sanitized.length === 0 ? undefined : sanitized;
};

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
  private readonly deliveryLeaseTtlMs: number;
  private readonly effectClaimTtlMs: number;

  constructor(options: WorkflowCoordinatorOptions) {
    this.storage = options.storage;
    this.clock = options.clock ?? defaultClock;
    this.idFactory = options.idFactory ?? defaultIdFactory;
    this.infrastructureRetryLimit = options.infrastructureRetryLimit ?? 2;
    this.dispatchClaimTtlMs = options.dispatchClaimTtlMs ?? 60_000;
    this.deliveryLeaseTtlMs = options.deliveryLeaseTtlMs ?? 60_000;
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

  async getDelivery(key: DeliveryKey): Promise<DeliveryRecord | undefined> {
    return this.storage.transaction((transaction) =>
      transaction.getDelivery(key),
    );
  }

  /** Read the current coordinator jobs for a delivery without changing state. */
  async getDeliveryWorkflowState(
    key: DeliveryKey,
  ): Promise<DeliveryWorkflowState | undefined> {
    return this.storage.transaction(async (transaction) => {
      const delivery = await transaction.getDelivery(key);
      if (delivery === undefined) return undefined;
      const identities = [delivery.root, ...delivery.graph.children];
      const seen = new Set<string>();
      const jobs: WorkflowJob[] = [];
      for (const identity of identities) {
        const identityKey = `${identity.repository}\u0000${identity.itemId}`;
        if (seen.has(identityKey)) continue;
        seen.add(identityKey);
        const job = await transaction.findCurrentJob(identity);
        if (job !== undefined) jobs.push(job);
      }
      return { delivery, jobs };
    });
  }

  /** Resolve or refresh one stable delivery identity and its current graph. */
  async resolveDelivery(group: DeliveryGroup): Promise<DeliveryRecord> {
    const normalized = resolveDeliveryGroup({
      issue: group.root,
      children: group.graph.children,
      dependencies: group.graph.dependencies,
    });
    if (
      normalized.id !== group.id ||
      normalized.key.repository !== group.key.repository ||
      normalized.key.itemId !== group.key.itemId
    ) {
      throw new Error("Delivery group identity does not match its graph");
    }
    return this.storage.transaction((transaction) =>
      this.upsertDelivery(transaction, normalized),
    );
  }

  /** Add scope against the locked current graph so stale snapshots cannot erase concurrent additions. */
  async expandDeliveryScope(
    input: ExpandDeliveryScopeInput,
  ): Promise<DeliveryRecord> {
    return this.storage.transaction(async (transaction) => {
      await transaction.lockDelivery(input.key);
      const existing = await transaction.getDelivery(input.key);
      if (existing === undefined) {
        throw new Error(`Delivery ${deliveryIdFor(input.key)} does not exist`);
      }
      if (existing.mergedAt !== undefined) {
        throw new Error("Merged delivery graph is immutable");
      }

      const childrenById = new Map(
        existing.graph.children.map((child) => [child.itemId, child]),
      );
      for (const child of input.addedChildren) {
        if (
          child.repository !== existing.key.repository ||
          child.kind !== "executable-issue"
        ) {
          throw new Error(
            `Only executable children may be added: ${child.itemId}`,
          );
        }
        const current = childrenById.get(child.itemId);
        if (current !== undefined && !sameIdentity(current, child)) {
          throw new Error(`Child ${child.itemId} has conflicting identity`);
        }
        childrenById.set(child.itemId, child);
      }

      const dependencyMap = new Map<string, Set<string>>(
        existing.graph.dependencies.map((dependency) => [
          dependency.itemId,
          new Set(dependency.dependsOn),
        ]),
      );
      const protectedChildren = new Map(
        existing.specCheckpoint?.children.map((child) => [
          child.child.itemId,
          child.status,
        ]) ?? [],
      );
      const completedChildIds = new Set(input.completedChildIds ?? []);
      if (
        [...completedChildIds].some(
          (itemId) =>
            !existing.graph.children.some((child) => child.itemId === itemId),
        )
      ) {
        throw new Error(
          "Completed child set contains an item outside the current delivery",
        );
      }
      for (const dependency of input.addedDependencies ?? []) {
        const values =
          dependencyMap.get(dependency.itemId) ?? new Set<string>();
        const protectedStatus = protectedChildren.get(dependency.itemId);
        if (
          (protectedStatus !== undefined ||
            completedChildIds.has(dependency.itemId)) &&
          dependency.dependsOn.some((id) => !values.has(id))
        ) {
          throw new Error(
            protectedStatus === "closed" ||
              completedChildIds.has(dependency.itemId)
              ? `Completed child ${dependency.itemId} cannot be mutated`
              : `Child ${dependency.itemId} dependencies cannot change after work starts`,
          );
        }
        for (const dependencyId of dependency.dependsOn) {
          values.add(dependencyId);
        }
        dependencyMap.set(dependency.itemId, values);
      }

      const group = resolveDeliveryGroup({
        issue: existing.root,
        children: [...childrenById.values()],
        dependencies: [...dependencyMap.entries()].map(
          ([itemId, dependsOn]) => ({ itemId, dependsOn: [...dependsOn] }),
        ),
      });
      const currentGroup: DeliveryGroup = {
        key: existing.key,
        id: existing.id,
        mode: existing.mode,
        root: existing.root,
        graph: existing.graph,
      };
      if (
        deliveryGroupFingerprint(currentGroup) ===
        deliveryGroupFingerprint(group)
      ) {
        return existing;
      }
      const updated: DeliveryRecord = {
        ...existing,
        ...group,
        updatedAt: this.clock.now(),
        version: existing.version + 1,
      };
      await transaction.saveDelivery(updated);
      return updated;
    });
  }

  /** Persist spec recovery evidence under the same lease and delivery lock. */
  async saveSpecDeliveryCheckpoint(
    key: DeliveryKey,
    lease: DeliveryLease,
    checkpoint: SpecDeliveryCheckpoint,
  ): Promise<DeliveryRecord> {
    return this.storage.transaction(async (transaction) => {
      await transaction.lockDelivery(key);
      const existing = await transaction.getDelivery(key);
      if (existing === undefined) {
        throw new Error(`Delivery ${deliveryIdFor(key)} does not exist`);
      }
      if (existing.mergedAt !== undefined) {
        throw new Error("Merged delivery checkpoint is immutable");
      }
      const currentLease = await transaction.getDeliveryLease(key);
      this.assertDeliveryLease(currentLease, lease);

      const previous = existing.specCheckpoint;
      if (
        previous?.pullRequest !== undefined &&
        (checkpoint.pullRequest?.id !== previous.pullRequest.id ||
          checkpoint.pullRequest.baseBranch !==
            previous.pullRequest.baseBranch ||
          checkpoint.pullRequest.headBranch !==
            previous.pullRequest.headBranch ||
          checkpoint.pullRequest.draft !== previous.pullRequest.draft)
      ) {
        throw new Error("Spec delivery pull request reference changed");
      }
      const children = new Map(
        checkpoint.children.map((child) => [child.child.itemId, child]),
      );
      if (children.size !== checkpoint.children.length) {
        throw new Error("Spec delivery checkpoint contains duplicate children");
      }
      for (const prior of previous?.children ?? []) {
        const current = children.get(prior.child.itemId);
        if (prior.status === "closed") {
          if (
            current !== undefined &&
            JSON.stringify(current) !== JSON.stringify(prior)
          ) {
            throw new Error(
              `Closed child ${prior.child.itemId} completion evidence is immutable`,
            );
          }
          children.set(prior.child.itemId, prior);
        }
      }
      const updated = parseDeliveryRecord({
        ...existing,
        specCheckpoint: {
          ...checkpoint,
          children: [...children.values()].sort((left, right) =>
            left.child.itemId.localeCompare(right.child.itemId, undefined, {
              numeric: true,
            }),
          ),
        },
        updatedAt: this.clock.now(),
        version: existing.version + 1,
      });
      await transaction.saveDelivery(updated);
      return updated;
    });
  }

  /** Freeze a provider-verified merged delivery before any later scope event. */
  async markDeliveryMerged(
    key: DeliveryKey,
    mergedSha: string,
  ): Promise<DeliveryRecord> {
    if (mergedSha.trim().length === 0) {
      throw new Error("Merged delivery needs a merge commit");
    }
    return this.storage.transaction(async (transaction) => {
      await transaction.lockDelivery(key);
      const existing = await transaction.getDelivery(key);
      if (existing === undefined) throw new Error("Delivery does not exist");
      if (existing.mergedSha !== undefined) {
        if (existing.mergedSha !== mergedSha) {
          throw new Error("Delivery is already merged at another revision");
        }
        return existing;
      }
      const merged = {
        ...existing,
        mergedAt: this.clock.now(),
        mergedSha,
        updatedAt: this.clock.now(),
        version: existing.version + 1,
      };
      await transaction.saveDelivery(merged);
      return merged;
    });
  }

  private async upsertDelivery(
    transaction: CoordinatorStorageTransaction,
    group: DeliveryGroup,
  ): Promise<DeliveryRecord> {
    await transaction.lockDelivery(group.key);
    const existing = await transaction.getDelivery(group.key);
    if (existing !== undefined) {
      const existingGroup: DeliveryGroup = {
        key: existing.key,
        id: existing.id,
        mode: existing.mode,
        root: existing.root,
        graph: existing.graph,
      };
      if (
        deliveryGroupFingerprint(existingGroup) ===
        deliveryGroupFingerprint(group)
      ) {
        return existing;
      }
      if (existing.mergedAt !== undefined) {
        throw new Error("Merged delivery graph is immutable");
      }
      const children = new Map(
        existing.graph.children.map((child) => [child.itemId, child]),
      );
      for (const child of group.graph.children) {
        const current = children.get(child.itemId);
        if (current !== undefined && !sameIdentity(current, child)) {
          throw new Error(`Child ${child.itemId} has conflicting identity`);
        }
        children.set(child.itemId, child);
      }
      const dependencies = new Map<string, Set<string>>();
      const protectedChildren = new Map(
        existing.specCheckpoint?.children.map((child) => [
          child.child.itemId,
          child.status,
        ]) ?? [],
      );
      const existingDependencies = new Map(
        existing.graph.dependencies.map((dependency) => [
          dependency.itemId,
          new Set(dependency.dependsOn),
        ]),
      );
      for (const dependency of group.graph.dependencies) {
        const current =
          existingDependencies.get(dependency.itemId) ?? new Set();
        const protectedStatus = protectedChildren.get(dependency.itemId);
        if (
          protectedStatus !== undefined &&
          dependency.dependsOn.some((itemId) => !current.has(itemId))
        ) {
          throw new Error(
            protectedStatus === "closed"
              ? `Completed child ${dependency.itemId} cannot be mutated`
              : `Child ${dependency.itemId} dependencies cannot change after work starts`,
          );
        }
      }
      for (const dependency of [
        ...existing.graph.dependencies,
        ...group.graph.dependencies,
      ]) {
        const current =
          dependencies.get(dependency.itemId) ?? new Set<string>();
        dependency.dependsOn.forEach((itemId) => current.add(itemId));
        dependencies.set(dependency.itemId, current);
      }
      const merged = resolveDeliveryGroup({
        issue: existing.root,
        children: [...children.values()],
        dependencies: [...dependencies.entries()].map(
          ([itemId, dependsOn]) => ({ itemId, dependsOn: [...dependsOn] }),
        ),
      });
      if (
        deliveryGroupFingerprint(existingGroup) ===
        deliveryGroupFingerprint(merged)
      ) {
        return existing;
      }
      const updated: DeliveryRecord = {
        ...existing,
        ...merged,
        createdAt: existing.createdAt,
        updatedAt: this.clock.now(),
        version: existing.version + 1,
      };
      await transaction.saveDelivery(updated);
      return updated;
    }
    const created: DeliveryRecord = {
      ...group,
      createdAt: this.clock.now(),
      updatedAt: this.clock.now(),
      version: 1,
    };
    await transaction.saveDelivery(created);
    return created;
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
    const delivery = input.delivery ?? defaultDeliveryGroup(brief.identity);
    if (!deliveryContainsIdentity(delivery, brief.identity)) {
      throw new Error(
        `Delivery ${delivery.id} does not contain workflow identity ${brief.identity.itemId}`,
      );
    }
    if (delivery.key.repository !== brief.identity.repository) {
      throw new Error("Delivery repository does not match work identity");
    }
    const key = eventKey({ ...input, brief, policy, delivery });
    const receivedAt = this.clock.now();
    const storedBase: StoredEvent = {
      ...input,
      brief,
      policy,
      delivery,
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

      const resolvedDelivery = await this.upsertDelivery(transaction, delivery);
      if (resolvedDelivery.mergedAt !== undefined) {
        const ignored: StoredEvent = {
          ...storedBase,
          status: "ignored",
          ignoreReason: "merged-delivery",
        };
        await transaction.saveEvent(ignored);
        return {
          disposition: "ignored" as const,
          event: ignored,
          reason: ignored.ignoreReason,
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

      if (
        current !== undefined &&
        input.resumeRequested === true &&
        current.brief.hash === brief.hash
      ) {
        const reclaimed = await this.reclaimBlockedJobInTransaction(
          transaction,
          current,
        );
        const accepted = {
          ...storedBase,
          status: "accepted" as const,
          jobId: current.id,
        };
        await transaction.saveEvent(accepted);
        return {
          disposition: "accepted",
          event: accepted,
          job: reclaimed.job,
          dispatch: reclaimed.dispatch,
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
        deliveryKey: delivery.key,
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
      let deliveryLease: DeliveryLease | undefined;
      const excludedDeliveryIds = new Set<string>();
      while (true) {
        dispatch = await transaction.findPendingDispatch(
          request.repository,
          this.clock.nowMilliseconds(),
          {
            jobId: request.jobId,
            dispatchId: request.dispatchId,
            excludedDeliveryIds: [...excludedDeliveryIds],
          },
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

        try {
          deliveryLease = await this.claimDeliveryLease(
            transaction,
            job.deliveryKey,
            request.workerId,
            request.deliveryLease,
          );
        } catch (error) {
          if (!(error instanceof LeaseBusyError)) throw error;
          if (
            request.jobId !== undefined ||
            request.dispatchId !== undefined ||
            request.deliveryLease !== undefined
          ) {
            return { status: "blocked", reason: "delivery-busy", job };
          }
          excludedDeliveryIds.add(deliveryIdFor(job.deliveryKey));
          continue;
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
        deliveryLease,
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
    if (job.infrastructureRetries > job.infrastructureRetryLimit) {
      return "infrastructure-retries-exhausted";
    }
    return undefined;
  }

  async acquireDeliveryLease(
    input: AcquireDeliveryLeaseInput,
  ): Promise<DeliveryLease> {
    return this.storage.transaction((transaction) =>
      this.claimDeliveryLease(
        transaction,
        input.key,
        input.workerId,
        undefined,
        input.ttlMs,
        input.repository,
      ),
    );
  }

  async heartbeatDeliveryLease(lease: DeliveryLease): Promise<DeliveryLease> {
    return this.storage.transaction(async (transaction) => {
      const current = await transaction.getDeliveryLease(lease.key);
      this.assertDeliveryLease(current, lease);
      const now = this.clock.nowMilliseconds();
      const updated: DeliveryLease = {
        ...current,
        heartbeatAt: now,
        expiresAt: Math.max(
          current.expiresAt,
          now + (current.expiresAt - current.heartbeatAt),
        ),
      };
      await transaction.saveDeliveryLease(updated);
      return updated;
    });
  }

  private async claimDeliveryLease(
    transaction: CoordinatorStorageTransaction,
    key: DeliveryKey,
    workerId: string,
    suppliedLease?: DeliveryLease,
    ttlMs = this.deliveryLeaseTtlMs,
    repository = key.repository,
  ): Promise<DeliveryLease> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("Delivery lease ttlMs must be a positive finite number");
    }
    if (repository !== key.repository) {
      throw new Error("Delivery lease repository does not match its key");
    }
    const delivery = await transaction.getDelivery(key);
    if (delivery === undefined) {
      throw new Error(`Delivery ${deliveryIdFor(key)} does not exist`);
    }
    await transaction.lockDeliveryLeaseResource(key);
    const current = await transaction.getDeliveryLease(key);
    if (suppliedLease !== undefined) {
      if (
        suppliedLease.key.repository !== key.repository ||
        suppliedLease.key.itemId !== key.itemId ||
        suppliedLease.workerId !== workerId
      ) {
        throw new LeaseLostError(
          `Delivery lease ${suppliedLease.leaseId} is not bound to ${deliveryIdFor(key)}`,
        );
      }
      this.assertDeliveryLease(current, suppliedLease);
      return current;
    }
    const now = this.clock.nowMilliseconds();
    if (current !== undefined && current.expiresAt > now) {
      if (current.workerId === workerId) return current;
      throw new LeaseBusyError(
        `Delivery ${deliveryIdFor(key)} is leased by worker ${current.workerId}`,
      );
    }
    const lease: DeliveryLease = {
      leaseId: this.idFactory("delivery-lease"),
      resourceKey: deliveryResourceKey(key),
      key,
      workerId,
      fencingToken: (current?.fencingToken ?? 0) + 1,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + ttlMs,
    };
    await transaction.saveDeliveryLease(lease);
    return lease;
  }

  private assertDeliveryLease(
    current: DeliveryLease | undefined,
    lease: DeliveryLease,
  ): asserts current is DeliveryLease {
    if (
      current === undefined ||
      current.leaseId !== lease.leaseId ||
      current.fencingToken !== lease.fencingToken ||
      current.workerId !== lease.workerId ||
      current.key.repository !== lease.key.repository ||
      current.key.itemId !== lease.key.itemId ||
      current.expiresAt <= this.clock.nowMilliseconds()
    ) {
      throw new LeaseLostError(
        `Delivery lease ${lease.leaseId} for ${deliveryIdFor(lease.key)} is expired or fenced`,
      );
    }
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
    if (
      input.deliveryKey !== undefined &&
      (input.deliveryKey.repository !== job.deliveryKey.repository ||
        input.deliveryKey.itemId !== job.deliveryKey.itemId)
    ) {
      throw new LeaseLostError(
        `Effect is not bound to delivery ${job.deliveryKey.repository}#${job.deliveryKey.itemId}`,
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
        lastInfrastructureFailure: undefined,
        blocked: undefined,
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
      const latestSuccess = [...job.phaseResults]
        .reverse()
        .find((result) => result.outcome === "completed");
      const latestHead = [...job.phaseResults]
        .reverse()
        .map((result) => result.head)
        .find(
          (head): head is { branch: string; sha: string } => head !== undefined,
        );
      const attempts = job.infrastructureRetries + 1;
      const lastSuccessfulStep = safeReference(
        input.lastSuccessfulStep ?? latestSuccess?.phase,
      );
      const evidence: DeliveryFailureEvidence = {
        phase: dispatch.key.phase,
        error: sanitizeDiagnostic(input.error),
        attempts,
        lastSuccessfulStep,
        lastSuccess: lastSuccessfulStep,
        branch: safeReference(input.branch ?? latestHead?.branch),
        commit: safeReference(input.commit ?? latestHead?.sha),
        pullRequest: safeReference(input.pullRequest),
        recovery: sanitizeDiagnostic(
          input.recovery ??
            "Re-add the shipyard label to resume this delivery after checking the failure.",
        ),
        occurredAt: this.clock.now(),
      };
      if (job.infrastructureRetries >= job.infrastructureRetryLimit) {
        const blocked = {
          ...job,
          state: "blocked" as const,
          lastInfrastructureFailure: evidence,
          blocked: {
            kind: "infrastructure" as const,
            reason: "infrastructure-retries-exhausted" as const,
            evidence,
          },
          updatedAt: this.clock.now(),
          version: job.version + 1,
        };
        await transaction.saveJob(blocked);
        await transaction.saveDispatch({
          ...dispatch,
          status: "failed",
          error: evidence.error,
          updatedAt: this.clock.now(),
        });
        await this.releaseDeliveryLeaseForRetry(transaction, job, dispatch);
        return { status: "exhausted", job: blocked, evidence };
      }
      const retried = {
        ...job,
        state: phaseState(dispatch.key.phase),
        infrastructureRetries: attempts,
        lastInfrastructureFailure: evidence,
        blocked: undefined,
        updatedAt: this.clock.now(),
        version: job.version + 1,
      };
      await transaction.saveJob(retried);
      const pending = {
        ...dispatch,
        status: "pending" as const,
        error: evidence.error,
        workerId: undefined,
        claimedAt: undefined,
        claimExpiresAt: undefined,
        updatedAt: this.clock.now(),
      };
      await transaction.saveDispatch(pending);
      await this.releaseDeliveryLeaseForRetry(transaction, job, dispatch);
      return {
        status: "retry-scheduled",
        job: retried,
        dispatch: pending,
        evidence,
      };
    });
  }

  async reclaimBlockedJob(jobId: string): Promise<ReclaimBlockedJobResult> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.getJob(jobId);
      if (job === undefined) {
        throw new Error(`Workflow job ${jobId} does not exist`);
      }
      return this.reclaimBlockedJobInTransaction(transaction, job);
    });
  }

  async reclaimBlockedDelivery(
    identity: WorkIdentity,
  ): Promise<ReclaimBlockedJobResult | undefined> {
    return this.storage.transaction(async (transaction) => {
      const job = await transaction.findCurrentJob(identity);
      return job === undefined
        ? undefined
        : this.reclaimBlockedJobInTransaction(transaction, job);
    });
  }

  private async reclaimBlockedJobInTransaction(
    transaction: CoordinatorStorageTransaction,
    job: WorkflowJob,
  ): Promise<ReclaimBlockedJobResult> {
    if (job.state !== "blocked" || job.blocked === undefined) {
      return { status: "already-reclaimed", job };
    }
    if (job.control !== "active") {
      return {
        status: "rejected",
        job,
        reason: `Workflow job is ${job.control}`,
      };
    }
    if (job.blocked.kind !== "infrastructure") {
      return {
        status: "rejected",
        job,
        reason:
          "Only infrastructure-blocked deliveries may be reclaimed automatically",
      };
    }
    const dispatch =
      (job.activeAssignmentId === undefined
        ? undefined
        : await transaction.findDispatchByAssignmentId(
            job.activeAssignmentId,
          )) ??
      (await transaction.findDispatchByDedupeKey(keyToString(job.key)));
    if (dispatch === undefined) {
      return {
        status: "rejected",
        job,
        reason: "Blocked delivery has no resumable dispatch",
      };
    }
    if (dispatch.status === "pending") {
      return { status: "already-reclaimed", job, dispatch };
    }
    if (dispatch.status !== "failed") {
      return {
        status: "rejected",
        job,
        dispatch,
        reason: "Blocked delivery dispatch is not reclaimable",
      };
    }
    const resumed: WorkflowJob = {
      ...job,
      state: phaseState(dispatch.key.phase),
      infrastructureRetries: 0,
      lastInfrastructureFailure: undefined,
      blocked: undefined,
      activeAssignmentId: dispatch.assignment?.id ?? job.activeAssignmentId,
      updatedAt: this.clock.now(),
      version: job.version + 1,
    };
    const pending: DispatchIntent = {
      ...dispatch,
      status: "pending",
      workerId: undefined,
      claimedAt: undefined,
      claimExpiresAt: undefined,
      error: undefined,
      updatedAt: this.clock.now(),
    };
    await transaction.saveJob(resumed);
    await transaction.saveDispatch(pending);
    return { status: "reclaimed", job: resumed, dispatch: pending };
  }

  private async releaseDeliveryLeaseForRetry(
    transaction: CoordinatorStorageTransaction,
    job: WorkflowJob,
    dispatch: DispatchIntent,
  ): Promise<void> {
    const lease = await transaction.getDeliveryLease(job.deliveryKey);
    if (lease === undefined || lease.workerId !== dispatch.workerId) return;
    const now = this.clock.nowMilliseconds();
    await transaction.saveDeliveryLease({
      ...lease,
      expiresAt: now,
      heartbeatAt: now,
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
