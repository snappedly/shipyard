import type {
  Assignment,
  CheckEvidence,
  LifecycleState,
  PhaseResult,
  RepositoryPolicy,
  RevisionReference,
  WorkBrief,
  WorkIdentity,
  WorkflowPhase,
} from "../contracts/index.js";

export type JobControl = "active" | "paused" | "cancelled" | "superseded";

export type EventStatus = "received" | "accepted" | "ignored";

export type EventIgnoreReason =
  | "out-of-order"
  | "closed-item"
  | "withdrawn-authorization"
  | "repository-stopped"
  | "invalid-policy"
  | "merged-delivery";

export type DispatchStatus =
  | "pending"
  | "claimed"
  | "started"
  | "completed"
  | "failed"
  | "cancelled";

export type EffectStatus =
  | "pending"
  | "claimed"
  | "succeeded"
  | "uncertain"
  | "failed"
  | "cancelled";

export interface DeliveryKey {
  readonly repository: string;
  readonly itemId: string;
}

export interface DeliveryDependency {
  /** The child item whose work is waiting. */
  readonly itemId: string;
  /** Child item IDs that must complete before `itemId` can run. */
  readonly dependsOn: readonly string[];
}

export interface DeliveryGraph {
  readonly root: WorkIdentity;
  readonly children: readonly WorkIdentity[];
  readonly dependencies: readonly DeliveryDependency[];
}

export type DeliveryMode = "standalone" | "planning-spec";

export interface DeliveryGroup {
  /** Stable delivery identity: the issue itself or its planning-spec parent. */
  readonly key: DeliveryKey;
  /** Stable, human-readable form of `key`. */
  readonly id: string;
  readonly mode: DeliveryMode;
  readonly root: WorkIdentity;
  readonly graph: DeliveryGraph;
}

export interface DeliveryRecord extends DeliveryGroup {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly specCheckpoint?: SpecDeliveryCheckpoint;
  readonly mergedAt?: string;
  readonly mergedSha?: string;
}

export interface DeliveryPullRequestReference {
  readonly id: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
}

export interface SpecChildVerificationEvidence {
  readonly checks: readonly CheckEvidence[];
  readonly cleanup: { readonly status: "passed"; readonly summary: string };
  readonly evidence: readonly string[];
}

export interface SpecChildCheckpoint {
  readonly child: WorkIdentity;
  readonly status:
    | "working"
    | "integrating"
    | "publishing"
    | "verifying"
    | "closing"
    | "closed";
  /** Count of child worker invocations across durable resumes. */
  readonly attempts?: number;
  readonly workerBase?: RevisionReference;
  readonly sourceCommit?: RevisionReference;
  readonly candidate?: {
    readonly deliveryId: string;
    readonly briefRevision?: number;
    readonly briefHash: string;
    readonly base: RevisionReference;
    readonly head: RevisionReference;
    readonly pullRequest: DeliveryPullRequestReference;
  };
  readonly verification?: SpecChildVerificationEvidence;
  readonly closedAt?: string;
}

/** Idempotency evidence for an interrupted planning-spec delivery. */
export interface SpecDeliveryCheckpoint {
  readonly pullRequest?: DeliveryPullRequestReference;
  readonly currentHead?: RevisionReference;
  readonly children: readonly SpecChildCheckpoint[];
}

/** Current coordinator records associated with one delivery graph. */
export interface DeliveryWorkflowState {
  readonly delivery: DeliveryRecord;
  readonly jobs: readonly WorkflowJob[];
}

export interface DeliveryLease {
  readonly leaseId: string;
  readonly resourceKey: string;
  readonly key: DeliveryKey;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

/** Sanitized evidence retained when bounded infrastructure recovery stops. */
export interface DeliveryFailureEvidence {
  readonly phase: WorkflowPhase;
  readonly error: string;
  readonly attempts: number;
  readonly lastSuccessfulStep?: string;
  readonly lastSuccess?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly pullRequest?: string;
  readonly recovery: string;
  readonly occurredAt: string;
}

export interface BlockedDeliveryState {
  readonly kind: "infrastructure";
  readonly reason: "infrastructure-retries-exhausted";
  readonly evidence: DeliveryFailureEvidence;
}

export interface WorkKey {
  readonly repository: string;
  readonly itemId: string;
  readonly briefRevision: number;
  readonly phase: WorkflowPhase;
  readonly relevantRevision: string;
}

export interface WorkflowEventInput {
  readonly deliveryId: string;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly phase: WorkflowPhase;
  readonly relevantRevision: string;
  readonly observedAt: string;
  /** Delivery routing resolved from the source issue's relationships. */
  readonly delivery?: DeliveryGroup;
  /** A closed source item invalidates queued and active work. */
  readonly sourceState?: "open" | "closed";
  /** An explicit `shipyard` activation may reclaim the existing blocked job. */
  readonly resumeRequested?: boolean;
  readonly payload?: unknown;
}

export interface StoredEvent extends WorkflowEventInput {
  readonly id: string;
  readonly key: WorkKey;
  readonly status: EventStatus;
  readonly ignoreReason?: EventIgnoreReason;
  readonly jobId?: string;
  readonly receivedAt: string;
}

export interface RepairBudgetUsage {
  readonly repairBatches: number;
  readonly followUps: number;
}

export interface WorkflowJob {
  readonly id: string;
  readonly key: WorkKey;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly deliveryKey: DeliveryKey;
  readonly state: LifecycleState;
  readonly control: JobControl;
  readonly phaseAttempts: Readonly<Record<WorkflowPhase, number>>;
  readonly repairBatches: number;
  readonly followUps: number;
  readonly infrastructureRetries: number;
  readonly infrastructureRetryLimit: number;
  readonly lastInfrastructureFailure?: DeliveryFailureEvidence;
  readonly blocked?: BlockedDeliveryState;
  readonly assignments: readonly Assignment[];
  readonly phaseResults: readonly PhaseResult[];
  readonly activeAssignmentId?: string;
  readonly latestObservedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
}

export interface DispatchIntent {
  readonly id: string;
  readonly dedupeKey: string;
  readonly key: WorkKey;
  readonly jobId: string;
  readonly status: DispatchStatus;
  readonly assignment?: Assignment;
  readonly workerId?: string;
  readonly claimedAt?: number;
  readonly claimExpiresAt?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface EffectIntent {
  readonly id: string;
  readonly jobId: string;
  readonly kind: string;
  readonly marker: string;
  readonly payload?: unknown;
  readonly status: EffectStatus;
  readonly externalRef?: unknown;
  readonly workerId?: string;
  readonly fencingToken?: number;
  readonly claimedAt?: number;
  readonly claimExpiresAt?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Durable provider effect scoped to a delivery group rather than one job. */
export interface DeliveryEffectIntent {
  readonly id: string;
  readonly key: DeliveryKey;
  readonly kind: string;
  readonly marker: string;
  readonly payload?: unknown;
  readonly status: EffectStatus;
  readonly externalRef?: unknown;
  readonly workerId?: string;
  readonly fencingToken?: number;
  readonly claimedAt?: number;
  readonly claimExpiresAt?: number;
  readonly error?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface BranchLease {
  readonly leaseId: string;
  readonly resourceKey: string;
  readonly repository: string;
  readonly branch: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly fencingToken: number;
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly expiresAt: number;
}

export interface RepositoryControl {
  readonly repository: string;
  readonly stopped: boolean;
  readonly reason?: string;
  readonly updatedAt: string;
}

export interface CoordinatorStorageTransaction {
  insertEventIfAbsent(
    event: StoredEvent,
  ): Promise<{ readonly event: StoredEvent; readonly inserted: boolean }>;
  saveEvent(event: StoredEvent): Promise<void>;

  getDelivery(key: DeliveryKey): Promise<DeliveryRecord | undefined>;
  /** Serialize delivery graph updates even before the first record exists. */
  lockDelivery(key: DeliveryKey): Promise<void>;
  saveDelivery(delivery: DeliveryRecord): Promise<void>;

  /** Serialize intake for an identity even before its first job row exists. */
  lockWorkIdentity(identity: WorkIdentity): Promise<void>;

  getJob(jobId: string): Promise<WorkflowJob | undefined>;
  findJobByKey(
    key: WorkKey,
    briefHash: string,
  ): Promise<WorkflowJob | undefined>;
  findCurrentJob(identity: WorkIdentity): Promise<WorkflowJob | undefined>;
  insertJob(job: WorkflowJob): Promise<void>;
  saveJob(job: WorkflowJob): Promise<void>;

  findDispatchByDedupeKey(
    dedupeKey: string,
  ): Promise<DispatchIntent | undefined>;
  findDispatchByAssignmentId(
    assignmentId: string,
  ): Promise<DispatchIntent | undefined>;
  findPendingDispatch(
    repository: string,
    nowMilliseconds: number,
    selector?: {
      readonly jobId?: string;
      readonly dispatchId?: string;
      readonly excludedDeliveryIds?: readonly string[];
    },
  ): Promise<DispatchIntent | undefined>;
  insertDispatchIfAbsent(
    dispatch: DispatchIntent,
  ): Promise<{ readonly dispatch: DispatchIntent; readonly inserted: boolean }>;
  saveDispatch(dispatch: DispatchIntent): Promise<void>;

  findEffect(
    jobId: string,
    kind: string,
    marker: string,
  ): Promise<EffectIntent | undefined>;
  insertEffectIfAbsent(
    effect: EffectIntent,
  ): Promise<{ readonly effect: EffectIntent; readonly inserted: boolean }>;
  saveEffect(effect: EffectIntent): Promise<void>;

  findDeliveryEffect(
    key: DeliveryKey,
    kind: string,
    marker: string,
  ): Promise<DeliveryEffectIntent | undefined>;
  insertDeliveryEffectIfAbsent(effect: DeliveryEffectIntent): Promise<{
    readonly effect: DeliveryEffectIntent;
    readonly inserted: boolean;
  }>;
  saveDeliveryEffect(effect: DeliveryEffectIntent): Promise<void>;

  getLease(
    repository: string,
    branch: string,
  ): Promise<BranchLease | undefined>;
  /** Serialize lease acquisition even when no lease row exists yet. */
  lockLeaseResource(repository: string, branch: string): Promise<void>;
  saveLease(lease: BranchLease): Promise<void>;
  findLeasesForJob(jobId: string): Promise<readonly BranchLease[]>;
  findLeasesForRepository(repository: string): Promise<readonly BranchLease[]>;

  getDeliveryLease(key: DeliveryKey): Promise<DeliveryLease | undefined>;
  /** Serialize delivery lease acquisition even when no lease row exists yet. */
  lockDeliveryLeaseResource(key: DeliveryKey): Promise<void>;
  saveDeliveryLease(lease: DeliveryLease): Promise<void>;

  getRepositoryControl(
    repository: string,
  ): Promise<RepositoryControl | undefined>;
  saveRepositoryControl(control: RepositoryControl): Promise<void>;
}

export interface CoordinatorStorage {
  transaction<T>(
    operation: (transaction: CoordinatorStorageTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface CoordinatorClock {
  now(): string;
  nowMilliseconds(): number;
}

export interface WorkflowCoordinatorOptions {
  readonly storage: CoordinatorStorage;
  readonly clock?: CoordinatorClock;
  readonly idFactory?: (prefix: string) => string;
  readonly infrastructureRetryLimit?: number;
  readonly dispatchClaimTtlMs?: number;
  readonly deliveryLeaseTtlMs?: number;
  readonly effectClaimTtlMs?: number;
}

export interface DispatchRequest {
  readonly repository: string;
  readonly workerId: string;
  /** Restrict dispatch to a known job/intent when a workflow runner is resuming. */
  readonly jobId?: string;
  readonly dispatchId?: string;
  /** Existing delivery lease when a runner is resuming a group. */
  readonly deliveryLease?: DeliveryLease;
}

export type DispatchBlockReason =
  | "repository-stopped"
  | "job-paused"
  | "job-cancelled"
  | "job-superseded"
  | "authorization-withdrawn"
  | "authorization-pending"
  | "invalid-policy"
  | "semantic-budget-exhausted"
  | "infrastructure-retries-exhausted"
  | "delivery-busy"
  | "invalid-transition";

export interface IngestResult {
  readonly disposition: "accepted" | "duplicate" | "out-of-order" | "ignored";
  readonly event: StoredEvent;
  readonly job?: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  readonly reason?: EventIgnoreReason;
}

export interface DispatchResult {
  readonly status: "dispatched" | "none" | "blocked";
  readonly dispatch?: DispatchIntent;
  readonly assignment?: Assignment;
  readonly job?: WorkflowJob;
  readonly deliveryLease?: DeliveryLease;
  readonly reason?: DispatchBlockReason;
}

export interface AcquireBranchLeaseInput {
  readonly repository: string;
  readonly branch: string;
  readonly jobId: string;
  readonly workerId: string;
  readonly ttlMs: number;
}

export interface AcquireDeliveryLeaseInput {
  readonly repository: string;
  readonly key: DeliveryKey;
  readonly workerId: string;
  readonly ttlMs: number;
}

export interface ExpandDeliveryScopeInput {
  readonly key: DeliveryKey;
  readonly addedChildren: readonly WorkIdentity[];
  readonly addedDependencies?: readonly DeliveryDependency[];
  readonly completedChildIds?: readonly string[];
}

export interface SubmitPhaseResultInput {
  readonly jobId: string;
  readonly result: PhaseResult;
  /** Every non-duplicate result must be fenced by the worker's active lease. */
  readonly lease: BranchLease;
}

export interface SchedulePhaseInput {
  readonly jobId: string;
  readonly phase: WorkflowPhase;
  readonly relevantRevision: string;
  readonly head?: {
    readonly branch: string;
    readonly sha: string;
  };
}

export interface SchedulePhaseResult {
  readonly status: "scheduled" | "duplicate" | "blocked";
  readonly job: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  readonly reason?: string;
}

export interface PhaseResultSubmission {
  readonly job: WorkflowJob;
  readonly duplicate: boolean;
  readonly transitioned: boolean;
}

export interface InfrastructureFailureInput {
  readonly jobId: string;
  readonly assignmentId: string;
  readonly error: string;
  readonly lastSuccessfulStep?: string;
  readonly branch?: string;
  readonly commit?: string;
  readonly pullRequest?: string;
  readonly recovery?: string;
}

export interface InfrastructureRetryResult {
  readonly status: "retry-scheduled" | "exhausted" | "not-retryable";
  readonly job: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  readonly evidence?: DeliveryFailureEvidence;
}

export interface ReclaimBlockedJobResult {
  readonly status:
    | "reclaimed"
    | "already-reclaimed"
    | "not-blocked"
    | "rejected";
  readonly job: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  readonly reason?: string;
}

export interface RepairRequestResult {
  readonly status: "scheduled" | "blocked" | "not-allowed";
  readonly job: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  readonly reason?: string;
}

export interface EffectOperationContext {
  readonly effect: EffectIntent;
  readonly fencingToken: number;
}

export interface DeliveryEffectOperationContext {
  readonly effect: DeliveryEffectIntent;
  readonly fencingToken: number;
}

export interface PublishEffectInput<T> {
  readonly jobId: string;
  readonly lease: BranchLease;
  /** Optional resource binding for effects that operate on a branch. */
  readonly branch?: string;
  /** Optional resource binding for effects that target the workflow item. */
  readonly itemId?: string;
  /** Optional delivery binding for effects that target a parent aggregate. */
  readonly deliveryKey?: DeliveryKey;
  /** Optional candidate binding for effects that publish a commit head. */
  readonly headSha?: string;
  readonly kind: string;
  readonly marker: string;
  readonly payload?: unknown;
  readonly reconcile?: (
    context: EffectOperationContext,
  ) => Promise<T | undefined>;
  readonly publish: (context: EffectOperationContext) => Promise<T>;
}

export interface PublishDeliveryEffectInput<T> {
  readonly key: DeliveryKey;
  readonly lease: DeliveryLease;
  /** Reject publication after the delivery graph changes during preparation. */
  readonly expectedDeliveryVersion?: number;
  readonly kind: string;
  readonly marker: string;
  readonly payload?: unknown;
  readonly reconcile?: (
    context: DeliveryEffectOperationContext,
  ) => Promise<T | undefined>;
  readonly publish: (context: DeliveryEffectOperationContext) => Promise<T>;
}

export interface EffectExecution<T> {
  readonly disposition:
    | "published"
    | "reconciled"
    | "already-succeeded"
    | "in-flight";
  readonly effect: EffectIntent;
  readonly externalRef?: T;
}

export interface DeliveryEffectExecution<T> {
  readonly disposition:
    | "published"
    | "reconciled"
    | "already-succeeded"
    | "in-flight";
  readonly effect: DeliveryEffectIntent;
  readonly externalRef?: T;
}
