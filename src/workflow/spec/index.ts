import {
  LeaseBusyError,
  resolveDeliveryGroup,
  type DeliveryGroup,
  type DeliveryFailureEvidence,
  type DeliveryLease,
  type DeliveryRecord,
  type SpecChildCheckpoint,
  type SpecDeliveryCheckpoint,
  type WorkflowCoordinator,
} from "../coordinator/index.js";
import {
  parseRepositoryPolicy,
  parseWorkBrief,
  type CheckEvidence,
  type Finding,
  type RepositoryPolicy,
  type RevisionReference,
  type ReviewAxis,
  type RiskLevel,
  type WorkBrief,
  type WorkIdentity,
  type WorkflowPhase,
} from "../contracts/index.js";
import {
  runIndependentReview,
  type ReviewResponse,
  type ReviewRunOutcome,
} from "../review/index.js";
import { deepFreeze, sameRevision } from "../shared.js";

export interface SpecChildPlan {
  readonly identity: WorkIdentity;
  readonly dependsOn: readonly WorkIdentity[];
  readonly wave: number;
}

export interface SpecDeliveryPlan {
  readonly delivery: DeliveryGroup;
  readonly children: readonly SpecChildPlan[];
  readonly waves: readonly (readonly WorkIdentity[])[];
}

export interface SpecScopeExpansionInput {
  readonly coordinator: WorkflowCoordinator;
  readonly delivery: DeliveryGroup;
  readonly addedChildren: readonly WorkIdentity[];
  readonly addedDependencies?: readonly {
    readonly itemId: string;
    readonly dependsOn: readonly string[];
  }[];
  readonly completedChildIds?: readonly string[];
  readonly parentState?: "open" | "merged";
}

export interface SpecScopeExpansionResult {
  readonly status: "expanded" | "follow-up-required" | "rejected";
  readonly delivery?: DeliveryRecord;
  readonly plan?: SpecDeliveryPlan;
  readonly candidateInvalidated: boolean;
  readonly checksInvalidated: boolean;
  readonly reviewInvalidated: boolean;
  readonly draftRequired: boolean;
  readonly reason?: string;
}

const compareIdentities = (left: WorkIdentity, right: WorkIdentity): number =>
  left.itemId.localeCompare(right.itemId, undefined, { numeric: true }) ||
  left.kind.localeCompare(right.kind);

/** Plan the current planning-spec graph into maximally parallel dependency waves. */
export const planSpecDelivery = (delivery: DeliveryGroup): SpecDeliveryPlan => {
  const normalized = resolveDeliveryGroup({
    issue: delivery.root,
    children: delivery.graph.children,
    dependencies: delivery.graph.dependencies,
  });
  if (normalized.mode !== "planning-spec") {
    throw new Error("Spec delivery planning requires a planning spec root");
  }
  if (
    normalized.id !== delivery.id ||
    normalized.key.repository !== delivery.key.repository ||
    normalized.key.itemId !== delivery.key.itemId
  ) {
    throw new Error("Spec delivery identity does not match its graph");
  }

  const childrenById = new Map(
    normalized.graph.children.map((child) => [child.itemId, child]),
  );
  const dependencies = new Map(
    normalized.graph.dependencies.map((dependency) => [
      dependency.itemId,
      dependency.dependsOn,
    ]),
  );
  const remaining = new Set(childrenById.keys());
  const completed = new Set<string>();
  const waves: WorkIdentity[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((itemId) =>
        (dependencies.get(itemId) ?? []).every((dependencyId) =>
          completed.has(dependencyId),
        ),
      )
      .map((itemId) => childrenById.get(itemId))
      .filter((child): child is WorkIdentity => child !== undefined)
      .sort(compareIdentities);
    if (ready.length === 0) {
      throw new Error("Spec delivery graph cannot be scheduled");
    }
    waves.push(ready);
    for (const child of ready) {
      remaining.delete(child.itemId);
      completed.add(child.itemId);
    }
  }

  return {
    delivery: normalized,
    children: waves.flatMap((wave, waveNumber) =>
      wave.map((identity) => ({
        identity,
        dependsOn: (dependencies.get(identity.itemId) ?? [])
          .map((itemId) => childrenById.get(itemId))
          .filter((child): child is WorkIdentity => child !== undefined)
          .sort(compareIdentities),
        wave: waveNumber,
      })),
    ),
    waves,
  };
};

/** Add pre-merge children without reopening or rewriting completed children. */
export const expandSpecDeliveryScope = async (
  input: SpecScopeExpansionInput,
): Promise<SpecScopeExpansionResult> => {
  if (input.parentState === "merged") {
    return {
      status: "follow-up-required",
      candidateInvalidated: false,
      checksInvalidated: false,
      reviewInvalidated: false,
      draftRequired: false,
      reason:
        "Merged deliveries cannot be mutated; create a follow-up delivery",
    };
  }
  let current: DeliveryRecord | undefined;
  try {
    current = await input.coordinator.getDelivery(input.delivery.key);
    if (current === undefined) {
      current = await input.coordinator.resolveDelivery(input.delivery);
    }
  } catch (error) {
    return {
      status: "rejected",
      candidateInvalidated: false,
      checksInvalidated: false,
      reviewInvalidated: false,
      draftRequired: false,
      reason: errorMessage(error),
    };
  }
  if (current?.mergedAt !== undefined) {
    return {
      status: "follow-up-required",
      candidateInvalidated: false,
      checksInvalidated: false,
      reviewInvalidated: false,
      draftRequired: false,
      reason:
        "Merged deliveries cannot be mutated; create a follow-up delivery",
    };
  }
  if (current === undefined) {
    return {
      status: "rejected",
      candidateInvalidated: false,
      checksInvalidated: false,
      reviewInvalidated: false,
      draftRequired: false,
      reason: "Delivery does not exist",
    };
  }
  try {
    const delivery = await input.coordinator.expandDeliveryScope({
      key: current.key,
      addedChildren: input.addedChildren,
      addedDependencies: input.addedDependencies,
      completedChildIds: input.completedChildIds,
    });
    const changed = delivery.version !== current.version;
    return {
      status: "expanded",
      delivery,
      plan: planSpecDelivery(delivery),
      candidateInvalidated: changed,
      checksInvalidated: changed,
      reviewInvalidated: changed,
      draftRequired: changed,
    };
  } catch (error) {
    return {
      status: "rejected",
      candidateInvalidated: false,
      checksInvalidated: false,
      reviewInvalidated: false,
      draftRequired: false,
      reason: errorMessage(error),
    };
  }
};

export interface SpecChildWorkerRequest {
  readonly delivery: DeliveryRecord;
  readonly child: WorkIdentity;
  /** The current integration head from which this child may create its branch. */
  readonly base: RevisionReference;
  readonly integrationBranch: string;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecChildWorkerResult {
  /** A child worker returns a commit; it never receives publication capabilities. */
  readonly commit: RevisionReference;
  readonly evidence?: readonly string[];
}

export interface SpecChildWorker {
  implement(request: SpecChildWorkerRequest): Promise<SpecChildWorkerResult>;
}

export interface SpecPullRequest {
  readonly id: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly draft: boolean;
}

export interface ReconcileSpecDeliveryInput {
  readonly delivery: DeliveryRecord;
  readonly base: RevisionReference;
  readonly integrationBranch: string;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecRemoteDeliveryState {
  readonly pullRequest?: SpecPullRequest;
  /** Remote metadata predates the current graph version and must be refreshed. */
  readonly scopeVersionChanged?: boolean;
  /** The host retracted a ready PR after detecting a newer delivery graph. */
  readonly scopeChangeRetracted?: boolean;
  /** Current remote integration branch head, when a draft PR exists. */
  readonly head?: RevisionReference;
  /** Exact in-flight child integration completed on the remote branch. */
  readonly integratedChild?: {
    readonly child: WorkIdentity;
    readonly sourceCommit: RevisionReference;
    readonly head: RevisionReference;
  };
}

export interface SpecCandidate {
  readonly deliveryId: string;
  readonly briefRevision?: number;
  readonly briefHash: string;
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly pullRequest: SpecPullRequest;
}

export interface EnsureSpecPullRequestInput {
  readonly delivery: DeliveryRecord;
  readonly candidate: RevisionReference;
  readonly base: RevisionReference;
  readonly integrationBranch: string;
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface IntegrateSpecChildInput {
  readonly delivery: DeliveryRecord;
  readonly child: WorkIdentity;
  readonly sourceCommit: RevisionReference;
  readonly currentHead: RevisionReference;
  readonly integrationBranch: string;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface PublishSpecCandidateInput {
  readonly delivery: DeliveryRecord;
  readonly candidate: SpecCandidate;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecPublishedCandidate {
  readonly pullRequestId: string;
  readonly head: RevisionReference;
}

export interface SpecIntegrationAdapter {
  /**
   * Read provider state before resuming. Report draft state accurately; a
   * non-draft pull request must be returned to draft before the delivery runs.
   */
  reconcileDelivery(
    input: ReconcileSpecDeliveryInput,
  ): Promise<SpecRemoteDeliveryState>;
  /** Create or resume by stable delivery identity; retries must not create another PR. */
  ensureDraftPullRequest(
    input: EnsureSpecPullRequestInput,
  ): Promise<SpecPullRequest>;
  /**
   * Integrate one worker commit into the shared branch. Calls are serialized
   * and must be idempotent for the delivery, child, and source commit tuple.
   */
  integrateChild(input: IntegrateSpecChildInput): Promise<RevisionReference>;
  /** Publishing the same PR head again must not create a second commit or PR. */
  publishCandidate(
    input: PublishSpecCandidateInput,
  ): Promise<SpecPublishedCandidate>;
  /** Publish the exact reviewed candidate for human review without merging. */
  publishHumanHandoff?(input: PublishSpecCandidateInput): Promise<void>;
}

export interface SpecCleanupResult {
  readonly status: "passed" | "failed";
  readonly summary: string;
}

export interface SpecVerificationResult {
  readonly checks: readonly CheckEvidence[];
  readonly cleanup: SpecCleanupResult;
  readonly evidence: readonly string[];
}

export interface SpecChildVerificationInput {
  readonly delivery: DeliveryRecord;
  readonly child: WorkIdentity;
  readonly sourceCommit: RevisionReference;
  readonly candidate: SpecCandidate;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecIntegratedVerificationInput {
  readonly delivery: DeliveryRecord;
  readonly candidate: SpecCandidate;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecVerificationAdapter {
  verifyChild(
    input: SpecChildVerificationInput,
  ): Promise<SpecVerificationResult>;
  verifyIntegrated(
    input: SpecIntegratedVerificationInput,
  ): Promise<SpecVerificationResult>;
}

export interface CompleteSpecChildInput extends SpecChildVerificationInput {
  readonly verification: SpecVerificationResult;
}

export interface SpecChildLifecycle {
  /** Read provider closure state to reconcile a crash around issue closure. */
  reconcileChild(input: {
    readonly delivery: DeliveryRecord;
    readonly child: WorkIdentity;
    readonly lease: DeliveryLease;
    readonly signal: AbortSignal;
  }): Promise<"open" | "closed">;
  /**
   * Close only after publication and verification. Completion comments must be
   * idempotent for the delivery, child, source commit, and candidate head.
   */
  closeChild(input: CompleteSpecChildInput): Promise<void>;
}

export interface SpecReviewRequest {
  readonly candidate: SpecCandidate;
  readonly checkout: {
    readonly base: RevisionReference;
    readonly candidate: RevisionReference;
    readonly immutable: true;
  };
  readonly requiredAxes: readonly ReviewAxis[];
  readonly mode: "full" | "targeted";
  readonly targetedFindings: readonly Finding[];
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecReviewProvider {
  review(request: SpecReviewRequest): Promise<ReviewResponse>;
}

export interface SpecCurrentCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly briefHash: string;
  readonly pullRequest: {
    readonly id: string;
    readonly state: "open" | "closed";
    readonly draft: boolean;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly briefHash: string;
    readonly deliveryId: string;
    readonly readyForHuman?: boolean;
  };
}

export interface SpecFixRequest {
  readonly delivery: DeliveryRecord;
  readonly candidate: SpecCandidate;
  readonly findings: readonly Finding[];
  readonly batch: 1;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecFixResult {
  readonly head: RevisionReference;
  readonly commits: readonly string[];
  readonly evidence: readonly string[];
}

export interface SpecFixer {
  /** One consolidated fix batch; no second batch is exposed by the seam. */
  fix(request: SpecFixRequest): Promise<SpecFixResult>;
}

export interface SpecDeliveryOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly delivery: DeliveryGroup;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly workerId: string;
  readonly base: RevisionReference;
  readonly integrationBranch: string;
  readonly childWorker: SpecChildWorker;
  readonly integration: SpecIntegrationAdapter;
  readonly verification: SpecVerificationAdapter;
  readonly childLifecycle: SpecChildLifecycle;
  readonly review: SpecReviewProvider;
  readonly fixer?: SpecFixer;
  readonly maxConcurrency?: number;
  readonly leaseTtlMs?: number;
  readonly signal?: AbortSignal;
  /** Re-reads the live brief, PR metadata, base, and remote integration head. */
  readonly readCurrent: () => Promise<SpecCurrentCandidate>;
}

export interface SpecChildRecord {
  readonly child: WorkIdentity;
  readonly workerBase: RevisionReference;
  readonly sourceCommit: RevisionReference;
  readonly candidate: SpecCandidate;
  readonly verification: SpecVerificationResult;
}

export interface SpecReviewRound {
  readonly mode: "full" | "targeted";
  readonly candidate: SpecCandidate;
  readonly requiredAxes: readonly ReviewAxis[];
  readonly outcome: ReviewRunOutcome;
  readonly axes: readonly ReviewAxis[];
  readonly findings: readonly Finding[];
  readonly evidence: readonly string[];
  readonly failure?: string;
}

export interface SpecDeliveryResult {
  readonly outcome: "ready-for-human" | "blocked";
  readonly delivery: DeliveryGroup;
  readonly plan?: SpecDeliveryPlan;
  readonly lease?: DeliveryLease;
  readonly integrationBranch: string;
  readonly pullRequest?: SpecPullRequest;
  readonly children: readonly SpecChildRecord[];
  readonly candidate?: SpecCandidate;
  readonly reviews: readonly SpecReviewRound[];
  readonly repairBatches: number;
  readonly followUps: number;
  readonly parent: {
    readonly state: "open";
    readonly merged: false;
  };
  readonly blockedChild?: WorkIdentity;
  readonly blockedEvidence?: DeliveryFailureEvidence;
  readonly reason?: string;
}

const defaultMaxConcurrency = 2;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

class SpecChildDeliveryFailure extends Error {
  constructor(
    readonly child: WorkIdentity,
    readonly phase: WorkflowPhase,
    message: string,
  ) {
    super(message);
    this.name = "SpecChildDeliveryFailure";
  }
}

const freezeClone = <T>(value: T): T => deepFreeze(structuredClone(value));

const revisionIsValid = (revision: RevisionReference): boolean =>
  revision.branch.trim().length > 0 && revision.sha.trim().length > 0;

const reviewAxesForRisk = (risk: RiskLevel): readonly ReviewAxis[] =>
  risk === "high" || risk === "critical"
    ? ["standards", "spec", "interface"]
    : ["standards", "spec"];

/** Select review depth without exposing a policy-specific reviewer implementation. */
export { reviewAxesForRisk };

const verificationFailure = (
  verification: SpecVerificationResult,
  policy: RepositoryPolicy,
): string | undefined => {
  if (verification.cleanup.status !== "passed") {
    return `Integrated cleanup failed: ${verification.cleanup.summary}`;
  }
  const failedCheck = verification.checks.find(
    (check) => check.status !== "passed",
  );
  if (failedCheck !== undefined) {
    return `Check ${failedCheck.name} is ${failedCheck.status}`;
  }
  for (const required of policy.checks.filter((check) => check.required)) {
    const actual = verification.checks.find(
      (check) => check.name === required.name,
    );
    if (actual === undefined) {
      return `Required check is missing: ${required.name}`;
    }
  }
  return undefined;
};

const childRecordsInPlanOrder = (
  plan: SpecDeliveryPlan,
  records: ReadonlyMap<string, SpecChildRecord>,
): readonly SpecChildRecord[] =>
  plan.children.flatMap((child) => {
    const record = records.get(child.identity.itemId);
    return record === undefined ? [] : [record];
  });

const makeCandidate = (input: {
  readonly delivery: DeliveryGroup;
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly pullRequest: SpecPullRequest;
}): SpecCandidate =>
  freezeClone({
    deliveryId: input.delivery.id,
    briefRevision: input.briefRevision,
    briefHash: input.briefHash,
    base: input.base,
    head: input.head,
    pullRequest: input.pullRequest,
  });

const recordFromCheckpoint = (
  progress: SpecChildCheckpoint,
): SpecChildRecord => {
  if (
    progress.workerBase === undefined ||
    progress.sourceCommit === undefined ||
    progress.candidate === undefined ||
    progress.verification === undefined
  ) {
    throw new Error(
      `Closed child ${progress.child.itemId} has incomplete coordinator evidence`,
    );
  }
  return freezeClone({
    child: progress.child,
    workerBase: progress.workerBase,
    sourceCommit: progress.sourceCommit,
    candidate: progress.candidate,
    verification: progress.verification,
  });
};

const samePullRequest = (
  left: SpecPullRequest,
  right: SpecPullRequest,
): boolean =>
  left.id === right.id &&
  left.baseBranch === right.baseBranch &&
  left.headBranch === right.headBranch &&
  left.draft === right.draft;

const currentCandidateMismatch = (
  candidate: SpecCandidate,
  current: SpecCurrentCandidate,
  allowHumanHandoff = false,
): string | undefined => {
  if (!sameRevision(current.base, candidate.base)) {
    return "Current provider base does not match the reviewed candidate";
  }
  if (!sameRevision(current.head, candidate.head)) {
    return "Current remote head does not match the reviewed candidate";
  }
  if (current.briefHash !== candidate.briefHash) {
    return "Current provider brief does not match the reviewed candidate";
  }
  const pullRequest = current.pullRequest;
  if (pullRequest.id !== candidate.pullRequest.id) {
    return "Current pull request identity does not match the reviewed candidate";
  }
  if (pullRequest.state !== "open") {
    return "Current pull request is closed or abandoned";
  }
  if (
    !pullRequest.draft &&
    (!allowHumanHandoff || pullRequest.readyForHuman !== true)
  ) {
    return "Current pull request is no longer a draft";
  }
  if (
    pullRequest.baseBranch !== candidate.pullRequest.baseBranch ||
    pullRequest.headBranch !== candidate.pullRequest.headBranch ||
    pullRequest.baseSha !== candidate.base.sha ||
    pullRequest.headSha !== candidate.head.sha ||
    pullRequest.briefHash !== candidate.briefHash ||
    pullRequest.deliveryId !== candidate.deliveryId
  ) {
    return "Current pull request metadata does not match the reviewed candidate";
  }
  return undefined;
};

const readCurrentCandidate = async (
  candidate: SpecCandidate,
  readCurrent: () => Promise<SpecCurrentCandidate>,
  allowHumanHandoff = false,
): Promise<SpecCurrentCandidate> => {
  const current = await readCurrent();
  const mismatch = currentCandidateMismatch(
    candidate,
    current,
    allowHumanHandoff,
  );
  if (mismatch !== undefined) throw new Error(mismatch);
  return current;
};

const resultFor = (input: {
  readonly outcome: SpecDeliveryResult["outcome"];
  readonly delivery: DeliveryGroup;
  readonly plan?: SpecDeliveryPlan;
  readonly lease?: DeliveryLease;
  readonly integrationBranch: string;
  readonly pullRequest?: SpecPullRequest;
  readonly children: readonly SpecChildRecord[];
  readonly candidate?: SpecCandidate;
  readonly reviews: readonly SpecReviewRound[];
  readonly repairBatches: number;
  readonly followUps: number;
  readonly blockedChild?: WorkIdentity;
  readonly blockedEvidence?: DeliveryFailureEvidence;
  readonly reason?: string;
}): SpecDeliveryResult => ({
  ...input,
  parent: { state: "open", merged: false },
});

const validateOptions = (options: SpecDeliveryOptions): string | undefined => {
  if (options.delivery.mode !== "planning-spec") {
    return "Spec delivery requires a planning-spec delivery group";
  }
  if (options.delivery.root.kind !== "planning-spec") {
    return "Spec delivery requires a planning-spec root";
  }
  if (options.delivery.graph.children.length === 0) {
    return "Spec delivery requires at least one child issue";
  }
  if (options.brief.identity.kind !== "planning-spec") {
    return "Spec delivery brief must describe the planning spec";
  }
  if (
    options.brief.identity.repository !== options.delivery.key.repository ||
    options.brief.identity.itemId !== options.delivery.key.itemId
  ) {
    return "Spec brief identity does not match the delivery root";
  }
  if (options.readCurrent === undefined) {
    return "Current provider state is required before spec review and handoff";
  }
  if (options.policy.repository !== options.delivery.key.repository) {
    return "Spec policy repository does not match the delivery";
  }
  if (options.base.branch !== options.policy.baseBranch) {
    return "Spec base branch does not match repository policy";
  }
  if (options.integrationBranch.trim().length === 0) {
    return "Spec integration branch must be non-empty";
  }
  if (options.integrationBranch === options.base.branch) {
    return "Spec integration branch must be separate from the base branch";
  }
  const maxConcurrency = options.maxConcurrency ?? defaultMaxConcurrency;
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    return "Spec maxConcurrency must be a positive integer";
  }
  const leaseTtlMs = options.leaseTtlMs ?? 60_000;
  if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
    return "Spec leaseTtlMs must be a positive finite number";
  }
  return undefined;
};

/**
 * Deliver a planning spec through one coordinator-owned candidate.
 *
 * The child worker interface intentionally returns only implementation evidence.
 * Publication, integration, verification, review, repair, and child completion
 * remain behind coordinator-owned adapters; there is no merge or parent-close
 * operation in this interface. Resume requires the existing pull request to
 * remain a draft; callers must satisfy `draftRequired` after scope expansion.
 */
export const deliverSpec = async (
  options: SpecDeliveryOptions,
): Promise<SpecDeliveryResult> => {
  const empty = {
    children: [],
    reviews: [],
    repairBatches: 0,
    followUps: 0,
  } as const;
  let brief: WorkBrief;
  let policy: RepositoryPolicy;
  let plan: SpecDeliveryPlan;
  try {
    brief = parseWorkBrief(options.brief);
    policy = parseRepositoryPolicy(options.policy);
    const validation = validateOptions({ ...options, brief, policy });
    if (validation !== undefined) {
      return resultFor({
        outcome: "blocked",
        delivery: options.delivery,
        integrationBranch: options.integrationBranch,
        reason: validation,
        ...empty,
      });
    }
    plan = planSpecDelivery(options.delivery);
  } catch (error) {
    return resultFor({
      outcome: "blocked",
      delivery: options.delivery,
      integrationBranch: options.integrationBranch,
      reason: errorMessage(error),
      ...empty,
    });
  }

  let delivery: DeliveryRecord;
  let lease: DeliveryLease;
  try {
    delivery = await options.coordinator.resolveDelivery(plan.delivery);
    if (delivery.mergedAt !== undefined) {
      throw new Error("Merged delivery cannot run another spec delivery");
    }
    plan = planSpecDelivery(delivery);
    lease = await options.coordinator.acquireDeliveryLease({
      repository: delivery.key.repository,
      key: delivery.key,
      workerId: options.workerId,
      ttlMs: options.leaseTtlMs ?? 60_000,
    });
  } catch (error) {
    return resultFor({
      outcome: "blocked",
      delivery: plan.delivery,
      plan,
      integrationBranch: options.integrationBranch,
      reason:
        error instanceof LeaseBusyError
          ? `Spec delivery is already leased: ${error.message}`
          : errorMessage(error),
      ...empty,
    });
  }

  const controller = new AbortController();
  const abortFromCaller = () =>
    controller.abort(options.signal?.reason ?? "spec delivery cancelled");
  if (options.signal?.aborted) abortFromCaller();
  else
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

  let currentLease = lease;
  const baseHead: RevisionReference = freezeClone({
    branch: options.integrationBranch,
    sha: options.base.sha,
  });
  let checkpoint: SpecDeliveryCheckpoint = delivery.specCheckpoint ?? {
    currentHead: baseHead,
    children: [],
  };
  let currentHead: RevisionReference = checkpoint.currentHead ?? baseHead;
  let publishedHead: RevisionReference | undefined;
  let pullRequest: SpecPullRequest | undefined = checkpoint.pullRequest;
  let repairBatches = 0;
  let followUps = 0;
  let currentPhase: WorkflowPhase = "triage";
  let lastSuccessfulStep =
    pullRequest === undefined
      ? undefined
      : `Recovered draft pull request #${pullRequest.id}`;
  const records = new Map<string, SpecChildRecord>();
  const reviews: SpecReviewRound[] = [];
  const states = new Map<string, "pending" | "running" | "closed">();
  for (const child of plan.children) {
    const completed = checkpoint.children.find(
      (progress) => progress.child.itemId === child.identity.itemId,
    );
    states.set(
      child.identity.itemId,
      completed?.status === "closed" ? "closed" : "pending",
    );
    if (completed?.status === "closed") {
      records.set(child.identity.itemId, recordFromCheckpoint(completed));
    }
  }
  const active = new Map<
    string,
    Promise<{
      readonly child: SpecChildPlan;
      readonly workerBase: RevisionReference;
      readonly result?: SpecChildWorkerResult;
      readonly error?: unknown;
    }>
  >();

  let leaseFailure: unknown;
  let leaseTimer: ReturnType<typeof setTimeout> | undefined;
  let leaseHeartbeat: Promise<void> | undefined;
  let stopLeaseHeartbeats = false;
  const grantedLeaseTtlMs = Math.max(1, lease.expiresAt - lease.heartbeatAt);
  const heartbeatIntervalMs = Math.max(1, Math.floor(grantedLeaseTtlMs / 3));
  const loseLease = (error: unknown): void => {
    leaseFailure = error;
    if (!controller.signal.aborted) {
      controller.abort(`spec delivery lease lost: ${errorMessage(error)}`);
    }
  };
  const assertOwned = (): void => {
    if (leaseFailure !== undefined) {
      throw new Error(`Delivery lease lost: ${errorMessage(leaseFailure)}`);
    }
    if (controller.signal.aborted) {
      throw new Error(
        `Spec delivery was cancelled: ${errorMessage(controller.signal.reason)}`,
      );
    }
  };
  const scheduleLeaseHeartbeat = (): void => {
    if (stopLeaseHeartbeats || controller.signal.aborted) return;
    leaseTimer = setTimeout(() => {
      leaseHeartbeat = (async () => {
        try {
          currentLease =
            await options.coordinator.heartbeatDeliveryLease(currentLease);
        } catch (error) {
          loseLease(error);
        } finally {
          leaseHeartbeat = undefined;
          scheduleLeaseHeartbeat();
        }
      })();
    }, heartbeatIntervalMs);
    leaseTimer.unref?.();
  };
  const stopHeartbeats = async (): Promise<void> => {
    stopLeaseHeartbeats = true;
    if (leaseTimer !== undefined) clearTimeout(leaseTimer);
    await leaseHeartbeat;
  };
  const refreshLease = async (): Promise<DeliveryLease> => {
    assertOwned();
    try {
      currentLease =
        await options.coordinator.heartbeatDeliveryLease(currentLease);
      return currentLease;
    } catch (error) {
      loseLease(error);
      assertOwned();
      throw error;
    }
  };
  scheduleLeaseHeartbeat();

  let allowScopeChangeDraftRetraction = false;
  const saveCheckpoint = async (
    next: SpecDeliveryCheckpoint,
  ): Promise<void> => {
    assertOwned();
    delivery = await options.coordinator.saveSpecDeliveryCheckpoint(
      delivery.key,
      currentLease,
      next,
      allowScopeChangeDraftRetraction
        ? { allowScopeChangeDraftRetraction: true }
        : undefined,
    );
    checkpoint = delivery.specCheckpoint ?? next;
    allowScopeChangeDraftRetraction = false;
  };

  const saveChildProgress = async (
    progress: SpecChildCheckpoint,
  ): Promise<void> => {
    const children = checkpoint.children.filter(
      (child) => child.child.itemId !== progress.child.itemId,
    );
    children.push(freezeClone(progress));
    await saveCheckpoint({
      ...checkpoint,
      pullRequest,
      currentHead: publishedHead ?? checkpoint.currentHead ?? baseHead,
      children,
    });
  };

  const refreshScope = async (): Promise<void> => {
    const latest = await options.coordinator.getDelivery(delivery.key);
    if (latest === undefined)
      throw new Error("Spec delivery record disappeared");
    if (latest.mergedAt !== undefined) {
      throw new Error("Merged delivery cannot run another spec delivery");
    }
    delivery = latest;
    plan = planSpecDelivery(latest);
    for (const child of plan.children) {
      if (!states.has(child.identity.itemId)) {
        states.set(child.identity.itemId, "pending");
      }
    }
  };

  const currentCandidate = (): SpecCandidate | undefined =>
    pullRequest === undefined || publishedHead === undefined
      ? undefined
      : makeCandidate({
          delivery,
          briefRevision: brief.revision,
          briefHash: brief.hash,
          base: options.base,
          head: publishedHead,
          pullRequest,
        });

  const ensurePullRequest = async (
    candidateHead: RevisionReference,
    refreshExisting = false,
  ): Promise<SpecPullRequest> => {
    if (pullRequest !== undefined && !refreshExisting) return pullRequest;
    await refreshLease();
    assertOwned();
    const created = await options.integration.ensureDraftPullRequest({
      delivery,
      candidate: candidateHead,
      base: options.base,
      integrationBranch: options.integrationBranch,
      briefRevision: brief.revision,
      briefHash: brief.hash,
      lease: currentLease,
      signal: controller.signal,
    });
    assertOwned();
    if (
      created.id.trim().length === 0 ||
      created.baseBranch !== options.base.branch ||
      created.headBranch !== options.integrationBranch ||
      created.draft !== true
    ) {
      throw new Error(
        "Integration adapter returned an invalid draft pull request",
      );
    }
    if (pullRequest !== undefined && created.id !== pullRequest.id) {
      throw new Error("Spec delivery refresh created another pull request");
    }
    pullRequest = freezeClone(created);
    await saveCheckpoint({
      ...checkpoint,
      pullRequest,
      currentHead: checkpoint.currentHead ?? baseHead,
    });
    lastSuccessfulStep = `Draft pull request #${created.id} is available`;
    return pullRequest;
  };

  const publishCandidate = async (
    candidate: SpecCandidate,
    childProgress?: SpecChildCheckpoint,
  ): Promise<SpecCandidate> => {
    if (pullRequest === undefined) {
      throw new Error("Spec candidate has no draft pull request");
    }
    await refreshLease();
    assertOwned();
    const stableCandidate = freezeClone(candidate);
    const published = await options.integration.publishCandidate({
      delivery,
      candidate: stableCandidate,
      lease: currentLease,
      signal: controller.signal,
    });
    assertOwned();
    if (
      published.pullRequestId !== pullRequest.id ||
      !sameRevision(published.head, stableCandidate.head)
    ) {
      throw new Error(
        "Published candidate does not match the exact integration head",
      );
    }
    publishedHead = freezeClone(published.head);
    currentHead = freezeClone(published.head);
    if (childProgress !== undefined) {
      await saveChildProgress({ ...childProgress, status: "verifying" });
    } else {
      await saveCheckpoint({
        ...checkpoint,
        pullRequest,
        currentHead: publishedHead,
      });
    }
    lastSuccessfulStep = `Published candidate ${published.head.sha} to pull request #${pullRequest.id}`;
    return stableCandidate;
  };

  const publish = async (): Promise<SpecCandidate> => {
    if (pullRequest === undefined) {
      throw new Error("Spec candidate has no draft pull request");
    }
    return publishCandidate(
      makeCandidate({
        delivery,
        briefRevision: brief.revision,
        briefHash: brief.hash,
        base: options.base,
        head: currentHead,
        pullRequest,
      }),
    );
  };

  const startReadyWorkers = async (): Promise<void> => {
    const maxConcurrency = options.maxConcurrency ?? defaultMaxConcurrency;
    const starts: Array<{
      readonly child: SpecChildPlan;
      readonly workerBase: RevisionReference;
      readonly request: SpecChildWorkerRequest;
    }> = [];
    for (const child of plan.children) {
      if (active.size + starts.length >= maxConcurrency) break;
      if (states.get(child.identity.itemId) !== "pending") continue;
      if (
        child.dependsOn.some(
          (dependency) => states.get(dependency.itemId) !== "closed",
        )
      ) {
        continue;
      }
      await refreshLease();
      const sourceState = await options.childLifecycle.reconcileChild({
        delivery,
        child: child.identity,
        lease: currentLease,
        signal: controller.signal,
      });
      assertOwned();
      if (sourceState !== "open") {
        throw new SpecChildDeliveryFailure(
          child.identity,
          "implementation",
          `Child ${child.identity.itemId} is closed without coordinator completion evidence`,
        );
      }
      const workerBase = freezeClone(currentHead);
      const attempts =
        (checkpoint.children.find(
          (entry) => entry.child.itemId === child.identity.itemId,
        )?.attempts ?? 0) + 1;
      await saveChildProgress({
        child: child.identity,
        status: "working",
        workerBase,
        attempts,
      });
      const request = Object.freeze({
        delivery: freezeClone(delivery),
        child: freezeClone(child.identity),
        base: workerBase,
        integrationBranch: options.integrationBranch,
        lease: freezeClone(currentLease),
        signal: controller.signal,
      });
      starts.push({ child, workerBase, request });
    }
    if (starts.length > 0) await refreshLease();
    for (const { child, workerBase, request } of starts) {
      assertOwned();
      states.set(child.identity.itemId, "running");
      const execution = Promise.resolve()
        .then(() => {
          assertOwned();
          return options.childWorker.implement(
            Object.freeze({ ...request, lease: freezeClone(currentLease) }),
          );
        })
        .then(
          (result) => ({ child, workerBase, result }),
          (error) => ({ child, workerBase, error }),
        );
      active.set(child.identity.itemId, execution);
    }
  };

  const waitForWorker = async (): Promise<{
    readonly child: SpecChildPlan;
    readonly workerBase: RevisionReference;
    readonly result?: SpecChildWorkerResult;
    readonly error?: unknown;
  }> => {
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        try {
          assertOwned();
          reject(new Error("Spec delivery was cancelled"));
        } catch (error) {
          reject(error);
        }
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([...active.values(), aborted]);
    } finally {
      if (onAbort !== undefined) {
        controller.signal.removeEventListener("abort", onAbort);
      }
    }
  };

  const settleActiveWorkers = async (): Promise<void> => {
    await Promise.allSettled(active.values());
    active.clear();
  };

  let blockedChild: WorkIdentity | undefined;
  let blockedPhase: WorkflowPhase | undefined;
  let blockedReason: string | undefined;
  try {
    await refreshLease();
    const remote = await options.integration.reconcileDelivery({
      delivery,
      base: options.base,
      integrationBranch: options.integrationBranch,
      lease: currentLease,
      signal: controller.signal,
    });
    assertOwned();
    allowScopeChangeDraftRetraction = remote.scopeChangeRetracted === true;
    const refreshScopePublication = remote.scopeVersionChanged === true;
    const expectedHead = checkpoint.currentHead ?? baseHead;
    const pendingPublish = checkpoint.children.find(
      (child) => child.status === "publishing",
    );
    const pendingIntegration = checkpoint.children.find(
      (child) => child.status === "integrating",
    );
    if (pullRequest !== undefined && remote.pullRequest === undefined) {
      throw new Error("Coordinator records a pull request missing from GitHub");
    }
    if (
      remote.pullRequest !== undefined &&
      (remote.pullRequest.id.trim().length === 0 ||
        remote.pullRequest.baseBranch !== options.base.branch ||
        remote.pullRequest.headBranch !== options.integrationBranch ||
        typeof remote.pullRequest.draft !== "boolean")
    ) {
      throw new Error("GitHub returned an invalid spec delivery pull request");
    }
    if (remote.pullRequest?.draft === false) {
      throw new Error(
        "Spec delivery cannot resume while its pull request is not a draft; return it to draft before resuming",
      );
    }
    if (
      pullRequest !== undefined &&
      remote.pullRequest !== undefined &&
      !samePullRequest(pullRequest, remote.pullRequest)
    ) {
      const safeScopeRetraction =
        remote.scopeChangeRetracted === true &&
        pullRequest.id === remote.pullRequest.id &&
        pullRequest.baseBranch === remote.pullRequest.baseBranch &&
        pullRequest.headBranch === remote.pullRequest.headBranch &&
        pullRequest.draft === false &&
        remote.pullRequest.draft === true;
      if (!safeScopeRetraction) {
        throw new Error("GitHub pull request contradicts coordinator evidence");
      }
      pullRequest = freezeClone(remote.pullRequest);
      checkpoint = {
        ...checkpoint,
        pullRequest,
        children: checkpoint.children.map((child) =>
          child.candidate === undefined
            ? child
            : {
                ...child,
                candidate: {
                  ...child.candidate,
                  pullRequest: {
                    ...child.candidate.pullRequest,
                    draft: pullRequest!.draft,
                  },
                },
              },
        ),
      };
    }
    if (remote.head !== undefined) {
      if (
        !revisionIsValid(remote.head) ||
        remote.head.branch !== options.integrationBranch
      ) {
        throw new Error("GitHub returned an invalid spec integration head");
      }
    } else if (
      remote.pullRequest !== undefined &&
      expectedHead.sha !== baseHead.sha
    ) {
      throw new Error(
        "GitHub did not return the recorded remote integration head",
      );
    }
    const remoteHead = remote.head ?? expectedHead;
    const recoveredIntegration = remote.integratedChild;
    if (
      recoveredIntegration !== undefined &&
      (pendingIntegration === undefined ||
        pendingIntegration.sourceCommit === undefined ||
        pendingIntegration.child.repository !==
          recoveredIntegration.child.repository ||
        pendingIntegration.child.itemId !== recoveredIntegration.child.itemId ||
        pendingIntegration.child.kind !== recoveredIntegration.child.kind ||
        !sameRevision(
          pendingIntegration.sourceCommit,
          recoveredIntegration.sourceCommit,
        ) ||
        !revisionIsValid(recoveredIntegration.head) ||
        recoveredIntegration.head.branch !== options.integrationBranch ||
        recoveredIntegration.head.sha === expectedHead.sha ||
        !sameRevision(remoteHead, recoveredIntegration.head))
    ) {
      throw new Error(
        "GitHub integration evidence contradicts the coordinator checkpoint",
      );
    }
    const publishedPendingChild =
      pendingPublish?.candidate !== undefined &&
      sameRevision(remoteHead, pendingPublish.candidate.head);
    if (
      !sameRevision(remoteHead, expectedHead) &&
      !publishedPendingChild &&
      recoveredIntegration === undefined
    ) {
      throw new Error(
        "GitHub integration head contradicts the coordinator checkpoint",
      );
    }
    pullRequest = remote.pullRequest ?? pullRequest;
    currentHead = freezeClone(remoteHead);
    if (pullRequest !== undefined) publishedHead = freezeClone(remoteHead);
    checkpoint = {
      ...checkpoint,
      pullRequest,
      currentHead: remoteHead,
      children: checkpoint.children.map((child) => {
        if (child === pendingPublish && publishedPendingChild) {
          return { ...child, status: "verifying" };
        }
        return child;
      }),
    };
    if (
      pendingIntegration !== undefined &&
      recoveredIntegration !== undefined
    ) {
      const child = plan.children.find(
        (entry) => entry.identity.itemId === pendingIntegration.child.itemId,
      );
      if (child === undefined) {
        throw new Error(
          `Checkpoint child ${pendingIntegration.child.itemId} is outside the current scope`,
        );
      }
      const recoveredPullRequest = await ensurePullRequest(
        recoveredIntegration.head,
      );
      const candidate = makeCandidate({
        delivery,
        briefRevision: brief.revision,
        briefHash: brief.hash,
        base: options.base,
        head: recoveredIntegration.head,
        pullRequest: recoveredPullRequest,
      });
      checkpoint = {
        ...checkpoint,
        children: checkpoint.children.map((entry) =>
          entry.child.itemId === pendingIntegration.child.itemId
            ? { ...entry, status: "publishing", candidate }
            : entry,
        ),
      };
    }
    if (
      JSON.stringify(checkpoint) !== JSON.stringify(delivery.specCheckpoint)
    ) {
      await saveCheckpoint(checkpoint);
    }
    if (refreshScopePublication) {
      await ensurePullRequest(currentHead, true);
    }

    currentPhase = "checking";
    await refreshScope();
    for (const child of plan.children) {
      await refreshLease();
      const progress = checkpoint.children.find(
        (entry) => entry.child.itemId === child.identity.itemId,
      );
      const childState = await options.childLifecycle.reconcileChild({
        delivery,
        child: child.identity,
        lease: currentLease,
        signal: controller.signal,
      });
      assertOwned();
      if (progress?.status === "closed") {
        if (childState !== "closed") {
          throw new SpecChildDeliveryFailure(
            child.identity,
            "checking",
            `GitHub child #${child.identity.itemId} contradicts closed coordinator evidence`,
          );
        }
        records.set(child.identity.itemId, recordFromCheckpoint(progress));
        states.set(child.identity.itemId, "closed");
      } else if (childState === "closed" && progress?.status !== "closing") {
        throw new SpecChildDeliveryFailure(
          child.identity,
          "checking",
          `Child ${child.identity.itemId} is closed without coordinator completion evidence`,
        );
      }
      if (progress?.status === "closing" && childState === "closed") {
        const closed = {
          ...progress,
          status: "closed" as const,
          closedAt: new Date().toISOString(),
        };
        await saveChildProgress(closed);
        lastSuccessfulStep = `Reconciled closure of child #${child.identity.itemId}`;
        records.set(child.identity.itemId, recordFromCheckpoint(closed));
        states.set(child.identity.itemId, "closed");
      }
    }

    currentPhase = "implementation";
    while (true) {
      assertOwned();
      await refreshScope();
      const resumable = checkpoint.children.find((child) =>
        ["integrating", "publishing", "verifying", "closing"].includes(
          child.status,
        ),
      );
      if (resumable !== undefined) {
        const child = plan.children.find(
          (entry) => entry.identity.itemId === resumable.child.itemId,
        );
        if (child === undefined) {
          throw new Error(
            `Checkpoint child ${resumable.child.itemId} is outside the current scope`,
          );
        }
        try {
          if (resumable.status === "integrating") {
            currentPhase = "implementation";
            if (
              resumable.workerBase === undefined ||
              resumable.sourceCommit === undefined
            ) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "implementation",
                `Child ${child.identity.itemId} integration checkpoint is incomplete`,
              );
            }
            await refreshLease();
            const integratedHead = await options.integration.integrateChild({
              delivery,
              child: child.identity,
              sourceCommit: resumable.sourceCommit,
              currentHead: freezeClone(currentHead),
              integrationBranch: options.integrationBranch,
              lease: currentLease,
              signal: controller.signal,
            });
            assertOwned();
            if (
              !revisionIsValid(integratedHead) ||
              integratedHead.branch !== options.integrationBranch ||
              integratedHead.sha === currentHead.sha
            ) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "implementation",
                "Integration adapter returned an invalid shared head",
              );
            }
            currentHead = freezeClone(integratedHead);
            await refreshLease();
            await ensurePullRequest(currentHead);
            const candidate = makeCandidate({
              delivery,
              briefRevision: brief.revision,
              briefHash: brief.hash,
              base: options.base,
              head: currentHead,
              pullRequest: pullRequest!,
            });
            await saveChildProgress({
              ...resumable,
              status: "publishing",
              candidate,
            });
            await publishCandidate(candidate, {
              ...resumable,
              status: "publishing",
              candidate,
            });
            continue;
          }
          if (resumable.status === "publishing") {
            currentPhase = "checking";
            if (resumable.candidate === undefined) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "checking",
                `Child ${child.identity.itemId} publication checkpoint is incomplete`,
              );
            }
            await publishCandidate(resumable.candidate, resumable);
            continue;
          }
          if (resumable.status === "verifying") {
            currentPhase = "checking";
            if (
              resumable.candidate === undefined ||
              resumable.sourceCommit === undefined
            ) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "checking",
                `Child ${child.identity.itemId} verification checkpoint is incomplete`,
              );
            }
            await refreshLease();
            const childVerification = await options.verification.verifyChild({
              delivery,
              child: child.identity,
              sourceCommit: resumable.sourceCommit,
              candidate: freezeClone(resumable.candidate),
              lease: currentLease,
              signal: controller.signal,
            });
            assertOwned();
            const issue = verificationFailure(childVerification, policy);
            if (issue !== undefined) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "checking",
                issue,
              );
            }
            await saveChildProgress({
              ...resumable,
              status: "closing",
              verification: {
                checks: childVerification.checks,
                cleanup: {
                  status: "passed",
                  summary: childVerification.cleanup.summary,
                },
                evidence: childVerification.evidence,
              },
            });
            continue;
          }
          if (resumable.status === "closing") {
            currentPhase = "handoff";
            if (
              resumable.candidate === undefined ||
              resumable.sourceCommit === undefined ||
              resumable.verification === undefined
            ) {
              throw new SpecChildDeliveryFailure(
                child.identity,
                "handoff",
                `Child ${child.identity.itemId} closure checkpoint is incomplete`,
              );
            }
            await refreshLease();
            const providerState = await options.childLifecycle.reconcileChild({
              delivery,
              child: child.identity,
              lease: currentLease,
              signal: controller.signal,
            });
            assertOwned();
            if (providerState === "open") {
              await refreshLease();
              await options.childLifecycle.closeChild({
                delivery,
                child: child.identity,
                sourceCommit: freezeClone(resumable.sourceCommit),
                candidate: freezeClone(resumable.candidate),
                verification: freezeClone(resumable.verification),
                lease: currentLease,
                signal: controller.signal,
              });
              assertOwned();
              lastSuccessfulStep = `Closed child #${child.identity.itemId} with verified commit ${resumable.sourceCommit.sha}`;
            }
            const closed: SpecChildCheckpoint = {
              ...resumable,
              status: "closed",
              closedAt: new Date().toISOString(),
            };
            await saveChildProgress(closed);
            records.set(child.identity.itemId, recordFromCheckpoint(closed));
            states.set(child.identity.itemId, "closed");
            continue;
          }
        } catch (error) {
          if (error instanceof SpecChildDeliveryFailure) {
            blockedChild = error.child;
            blockedPhase = error.phase;
          }
          throw error;
        }
      }
      if (
        active.size === 0 &&
        plan.children.every(
          (child) => states.get(child.identity.itemId) === "closed",
        )
      ) {
        break;
      }
      await startReadyWorkers();
      if (active.size === 0) {
        throw new Error(
          "Spec delivery has no dependency-safe child ready to run",
        );
      }
      const completion = await waitForWorker();
      active.delete(completion.child.identity.itemId);
      if (completion.error !== undefined) {
        throw new SpecChildDeliveryFailure(
          completion.child.identity,
          "implementation",
          `Child ${completion.child.identity.itemId} failed: ${errorMessage(completion.error)}`,
        );
      }
      if (completion.result === undefined) {
        throw new SpecChildDeliveryFailure(
          completion.child.identity,
          "implementation",
          `Child ${completion.child.identity.itemId} returned no result`,
        );
      }
      const sourceCommit = completion.result.commit;
      if (
        !revisionIsValid(sourceCommit) ||
        sourceCommit.branch === options.integrationBranch ||
        sourceCommit.sha === completion.workerBase.sha
      ) {
        throw new SpecChildDeliveryFailure(
          completion.child.identity,
          "implementation",
          `Child ${completion.child.identity.itemId} returned an invalid or shared-branch commit`,
        );
      }
      assertOwned();
      currentPhase = "implementation";
      lastSuccessfulStep = `Received commit ${sourceCommit.sha} from child #${completion.child.identity.itemId}`;
      await saveChildProgress({
        child: completion.child.identity,
        status: "integrating",
        workerBase: completion.workerBase,
        sourceCommit: freezeClone(sourceCommit),
        attempts:
          checkpoint.children.find(
            (entry) => entry.child.itemId === completion.child.identity.itemId,
          )?.attempts ?? 0,
      });
    }

    currentPhase = "checking";
    const candidateBeforeReview = currentCandidate();
    if (candidateBeforeReview === undefined) {
      throw new Error("Spec delivery did not publish an integration candidate");
    }
    const reviewedGraph = JSON.stringify(delivery.graph);
    await refreshLease();
    const integratedVerification = await options.verification.verifyIntegrated({
      delivery,
      candidate: candidateBeforeReview,
      lease: currentLease,
      signal: controller.signal,
    });
    assertOwned();
    const integratedIssue = verificationFailure(integratedVerification, policy);
    if (integratedIssue !== undefined) throw new Error(integratedIssue);
    lastSuccessfulStep = `Integrated checks passed for ${candidateBeforeReview.head.sha}`;
    await refreshScope();
    if (JSON.stringify(delivery.graph) !== reviewedGraph) {
      throw new Error(
        "Spec scope changed during integrated verification; resume delivery for the updated graph",
      );
    }

    const review = async (
      mode: "full" | "targeted",
      candidate: SpecCandidate,
      targetedFindings: readonly Finding[],
    ): Promise<SpecReviewRound> => {
      currentPhase = "review";
      await refreshLease();
      const requiredAxes = reviewAxesForRisk(brief.risk);
      const additionalAxes = requiredAxes.filter(
        (axis) => axis === "interface",
      );
      const reviewResult = await runIndependentReview({
        candidate: {
          base: candidate.base,
          head: candidate.head,
          brief,
          policy,
          requiredAxes: additionalAxes,
        },
        provider: {
          review: (request) =>
            options.review.review({
              candidate,
              checkout: request.checkout,
              requiredAxes,
              mode,
              targetedFindings,
              lease: currentLease,
              signal: request.signal,
            }),
        },
        readCurrent: async () => {
          const current = await readCurrentCandidate(
            candidate,
            options.readCurrent,
          );
          return {
            base: current.base,
            head: current.head,
            briefHash: current.briefHash,
          };
        },
        signal: controller.signal,
      });
      const round = freezeClone({
        mode,
        candidate,
        requiredAxes,
        outcome: reviewResult.outcome,
        axes: reviewResult.reviewAxes,
        findings: reviewResult.findings,
        evidence: reviewResult.evidence,
        failure: reviewResult.failure?.message,
      });
      assertOwned();
      reviews.push(round);
      if (round.outcome === "passed") {
        lastSuccessfulStep = `${mode === "full" ? "Full" : "Targeted"} review passed for ${candidate.head.sha}`;
      }
      return round;
    };

    const firstReview = await review("full", candidateBeforeReview, []);
    let finalCandidate = candidateBeforeReview;
    if (firstReview.outcome === "actionable-findings") {
      if (options.fixer === undefined) {
        throw new Error(
          "Review found actionable findings and no fix batch is available",
        );
      }
      repairBatches = 1;
      currentPhase = "repair";
      await refreshLease();
      try {
        await readCurrentCandidate(candidateBeforeReview, options.readCurrent);
      } catch (error) {
        reviews.splice(0);
        throw error;
      }
      const fixed = await options.fixer.fix({
        delivery,
        candidate: candidateBeforeReview,
        findings: firstReview.findings,
        batch: 1,
        lease: currentLease,
        signal: controller.signal,
      });
      assertOwned();
      if (
        !revisionIsValid(fixed.head) ||
        fixed.head.branch !== options.integrationBranch ||
        fixed.head.sha === candidateBeforeReview.head.sha ||
        fixed.commits.length === 0
      ) {
        throw new Error("Fix batch returned no new integration commit");
      }
      currentHead = freezeClone(fixed.head);
      await refreshLease();
      const fixedCandidate = await publish();
      currentPhase = "checking";
      const fixedVerification = await options.verification.verifyIntegrated({
        delivery,
        candidate: fixedCandidate,
        lease: currentLease,
        signal: controller.signal,
      });
      assertOwned();
      const fixedIssue = verificationFailure(fixedVerification, policy);
      if (fixedIssue !== undefined) throw new Error(fixedIssue);
      followUps = 1;
      const followUp = await review(
        "targeted",
        fixedCandidate,
        firstReview.findings,
      );
      finalCandidate = fixedCandidate;
      if (followUp.outcome !== "passed") {
        throw new Error(
          followUp.failure ??
            `Targeted review ended with ${followUp.outcome}; escalation is required`,
        );
      }
    } else if (firstReview.outcome !== "passed") {
      throw new Error(
        firstReview.failure ??
          `Review ended with ${firstReview.outcome}; escalation is required`,
      );
    }

    currentPhase = "handoff";
    await refreshScope();
    if (JSON.stringify(delivery.graph) !== reviewedGraph) {
      throw new Error(
        "Spec scope changed during review; resume delivery for the updated graph",
      );
    }

    try {
      await readCurrentCandidate(finalCandidate, options.readCurrent, true);
    } catch (error) {
      reviews.splice(0);
      throw new Error(
        `Current provider state changed before human handoff: ${errorMessage(error)}`,
      );
    }

    if (options.integration.publishHumanHandoff !== undefined) {
      await refreshLease();
      await options.integration.publishHumanHandoff({
        delivery,
        candidate: finalCandidate,
        lease: currentLease,
        signal: controller.signal,
      });
      assertOwned();
      await readCurrentCandidate(finalCandidate, options.readCurrent, true);
    }

    return resultFor({
      outcome: "ready-for-human",
      delivery,
      plan,
      lease: currentLease,
      integrationBranch: options.integrationBranch,
      pullRequest,
      children: childRecordsInPlanOrder(plan, records),
      candidate: finalCandidate,
      reviews,
      repairBatches,
      followUps,
    });
  } catch (error) {
    if (error instanceof SpecChildDeliveryFailure) {
      blockedChild = error.child;
      blockedPhase = error.phase;
    }
    blockedReason = errorMessage(error);
    if (!controller.signal.aborted) controller.abort(blockedReason);
    await settleActiveWorkers();
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
    await stopHeartbeats();
  }

  const candidate = currentCandidate();
  const blockedEvidence: DeliveryFailureEvidence | undefined =
    blockedReason === undefined
      ? undefined
      : {
          phase: blockedPhase ?? currentPhase,
          error: blockedReason,
          attempts:
            blockedChild === undefined
              ? 1
              : (checkpoint.children.find(
                  (entry) => entry.child.itemId === blockedChild.itemId,
                )?.attempts ?? 0),
          ...(lastSuccessfulStep === undefined ? {} : { lastSuccessfulStep }),
          ...(candidate === undefined
            ? {}
            : {
                branch: candidate.head.branch,
                commit: candidate.head.sha,
              }),
          ...(pullRequest === undefined
            ? {}
            : {
                pullRequest: `https://github.com/${delivery.key.repository}/pull/${pullRequest.id}`,
              }),
          recovery:
            blockedChild === undefined
              ? "Resolve the reported delivery blocker, then re-add the shipyard label to the planning spec to resume."
              : `Resolve the blocker on child #${blockedChild.itemId}, then re-add the shipyard label to resume the existing delivery.`,
          occurredAt: new Date().toISOString(),
        };
  return resultFor({
    outcome: "blocked",
    delivery,
    plan,
    lease: currentLease,
    integrationBranch: options.integrationBranch,
    pullRequest,
    candidate,
    children: childRecordsInPlanOrder(plan, records),
    reviews,
    repairBatches,
    followUps,
    blockedChild,
    blockedEvidence,
    reason: blockedReason,
  });
};
