import {
  LeaseBusyError,
  resolveDeliveryGroup,
  type DeliveryGroup,
  type DeliveryLease,
  type DeliveryRecord,
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

export interface SpecChildWorkerRequest {
  readonly delivery: DeliveryGroup;
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
  readonly draft: true;
}

export interface SpecCandidate {
  readonly deliveryId: string;
  readonly briefHash: string;
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly pullRequest: SpecPullRequest;
}

export interface EnsureSpecPullRequestInput {
  readonly delivery: DeliveryGroup;
  readonly candidate: RevisionReference;
  readonly base: RevisionReference;
  readonly integrationBranch: string;
  readonly lease: DeliveryLease;
}

export interface IntegrateSpecChildInput {
  readonly delivery: DeliveryGroup;
  readonly child: WorkIdentity;
  readonly sourceCommit: RevisionReference;
  readonly currentHead: RevisionReference;
  readonly integrationBranch: string;
  readonly lease: DeliveryLease;
}

export interface PublishSpecCandidateInput {
  readonly delivery: DeliveryGroup;
  readonly candidate: SpecCandidate;
  readonly lease: DeliveryLease;
}

export interface SpecPublishedCandidate {
  readonly pullRequestId: string;
  readonly head: RevisionReference;
}

export interface SpecIntegrationAdapter {
  /** Create or resume the one draft pull request for this delivery. */
  ensureDraftPullRequest(
    input: EnsureSpecPullRequestInput,
  ): Promise<SpecPullRequest>;
  /** Integrate one worker commit into the shared branch. Calls are serialized. */
  integrateChild(input: IntegrateSpecChildInput): Promise<RevisionReference>;
  /** Publish the exact shared head through the already established PR identity. */
  publishCandidate(
    input: PublishSpecCandidateInput,
  ): Promise<SpecPublishedCandidate>;
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
  readonly delivery: DeliveryGroup;
  readonly child: WorkIdentity;
  readonly sourceCommit: RevisionReference;
  readonly candidate: SpecCandidate;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface SpecIntegratedVerificationInput {
  readonly delivery: DeliveryGroup;
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
  /** Record child completion only after the integrated candidate is published and verified. */
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
}

export interface SpecFixRequest {
  readonly delivery: DeliveryGroup;
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
  readonly readCurrent?: () => Promise<SpecCurrentCandidate>;
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
  readonly reason?: string;
}

const defaultMaxConcurrency = 2;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
  readonly briefHash: string;
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly pullRequest: SpecPullRequest;
}): SpecCandidate =>
  freezeClone({
    deliveryId: input.delivery.id,
    briefHash: input.briefHash,
    base: input.base,
    head: input.head,
    pullRequest: input.pullRequest,
  });

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
 * operation in this interface.
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
  let currentHead: RevisionReference = freezeClone({
    branch: options.integrationBranch,
    sha: options.base.sha,
  });
  let publishedHead: RevisionReference | undefined;
  let pullRequest: SpecPullRequest | undefined;
  let repairBatches = 0;
  let followUps = 0;
  const records = new Map<string, SpecChildRecord>();
  const reviews: SpecReviewRound[] = [];
  const states = new Map<string, "pending" | "running" | "closed">(
    plan.children.map((child) => [child.identity.itemId, "pending"]),
  );
  const active = new Map<
    string,
    Promise<{
      readonly child: SpecChildPlan;
      readonly workerBase: RevisionReference;
      readonly result?: SpecChildWorkerResult;
      readonly error?: unknown;
    }>
  >();

  const refreshLease = async (): Promise<DeliveryLease> => {
    currentLease =
      await options.coordinator.heartbeatDeliveryLease(currentLease);
    return currentLease;
  };

  const currentCandidate = (): SpecCandidate | undefined =>
    pullRequest === undefined || publishedHead === undefined
      ? undefined
      : makeCandidate({
          delivery,
          briefHash: brief.hash,
          base: options.base,
          head: publishedHead,
          pullRequest,
        });

  const ensurePullRequest = async (
    candidateHead: RevisionReference,
  ): Promise<SpecPullRequest> => {
    if (pullRequest !== undefined) return pullRequest;
    const created = await options.integration.ensureDraftPullRequest({
      delivery,
      candidate: candidateHead,
      base: options.base,
      integrationBranch: options.integrationBranch,
      lease: currentLease,
    });
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
    pullRequest = freezeClone(created);
    return pullRequest;
  };

  const publish = async (): Promise<SpecCandidate> => {
    if (pullRequest === undefined) {
      throw new Error("Spec candidate has no draft pull request");
    }
    const candidate = makeCandidate({
      delivery,
      briefHash: brief.hash,
      base: options.base,
      head: currentHead,
      pullRequest,
    });
    const published = await options.integration.publishCandidate({
      delivery,
      candidate,
      lease: currentLease,
    });
    if (
      published.pullRequestId !== pullRequest.id ||
      !sameRevision(published.head, currentHead)
    ) {
      throw new Error(
        "Published candidate does not match the exact integration head",
      );
    }
    publishedHead = freezeClone(published.head);
    return candidate;
  };

  const startReadyWorkers = (): void => {
    const maxConcurrency = options.maxConcurrency ?? defaultMaxConcurrency;
    for (const child of plan.children) {
      if (active.size >= maxConcurrency) break;
      if (states.get(child.identity.itemId) !== "pending") continue;
      if (
        child.dependsOn.some(
          (dependency) => states.get(dependency.itemId) !== "closed",
        )
      ) {
        continue;
      }
      const workerBase = freezeClone(currentHead);
      states.set(child.identity.itemId, "running");
      const request = Object.freeze({
        delivery: freezeClone(delivery),
        child: freezeClone(child.identity),
        base: workerBase,
        integrationBranch: options.integrationBranch,
        lease: freezeClone(currentLease),
        signal: controller.signal,
      });
      const execution = Promise.resolve()
        .then(() => options.childWorker.implement(request))
        .then(
          (result) => ({ child, workerBase, result }),
          (error) => ({ child, workerBase, error }),
        );
      active.set(child.identity.itemId, execution);
    }
  };

  const settleActiveWorkers = async (): Promise<void> => {
    await Promise.allSettled(active.values());
    active.clear();
  };

  let blockedReason: string | undefined;
  try {
    while (records.size < plan.children.length) {
      if (controller.signal.aborted) {
        throw new Error("Spec delivery was cancelled");
      }
      startReadyWorkers();
      if (active.size === 0) {
        throw new Error(
          "Spec delivery has no dependency-safe child ready to run",
        );
      }
      const completion = await Promise.race(active.values());
      active.delete(completion.child.identity.itemId);
      if (completion.error !== undefined) {
        throw new Error(
          `Child ${completion.child.identity.itemId} failed: ${errorMessage(completion.error)}`,
        );
      }
      if (completion.result === undefined) {
        throw new Error(
          `Child ${completion.child.identity.itemId} returned no result`,
        );
      }
      const sourceCommit = completion.result.commit;
      if (
        !revisionIsValid(sourceCommit) ||
        sourceCommit.branch === options.integrationBranch ||
        sourceCommit.sha === completion.workerBase.sha
      ) {
        throw new Error(
          `Child ${completion.child.identity.itemId} returned an invalid or shared-branch commit`,
        );
      }

      await refreshLease();
      const workerBase = completion.workerBase;
      const integratedHead = await options.integration.integrateChild({
        delivery,
        child: completion.child.identity,
        sourceCommit: freezeClone(sourceCommit),
        currentHead: freezeClone(currentHead),
        integrationBranch: options.integrationBranch,
        lease: currentLease,
      });
      if (
        !revisionIsValid(integratedHead) ||
        integratedHead.branch !== options.integrationBranch ||
        integratedHead.sha === currentHead.sha
      ) {
        throw new Error("Integration adapter returned an invalid shared head");
      }
      currentHead = freezeClone(integratedHead);
      await refreshLease();
      await ensurePullRequest(currentHead);
      const candidate = await publish();
      const verification = await options.verification.verifyChild({
        delivery,
        child: completion.child.identity,
        sourceCommit: freezeClone(sourceCommit),
        candidate,
        lease: currentLease,
        signal: controller.signal,
      });
      const verificationIssue = verificationFailure(verification, policy);
      if (verificationIssue !== undefined) throw new Error(verificationIssue);
      await refreshLease();
      await options.childLifecycle.closeChild({
        delivery,
        child: completion.child.identity,
        sourceCommit: freezeClone(sourceCommit),
        candidate,
        verification,
        lease: currentLease,
        signal: controller.signal,
      });
      records.set(
        completion.child.identity.itemId,
        freezeClone({
          child: completion.child.identity,
          workerBase,
          sourceCommit,
          candidate,
          verification,
        }),
      );
      states.set(completion.child.identity.itemId, "closed");
    }

    const candidateBeforeReview = currentCandidate();
    if (candidateBeforeReview === undefined) {
      throw new Error("Spec delivery did not publish an integration candidate");
    }
    await refreshLease();
    const integratedVerification = await options.verification.verifyIntegrated({
      delivery,
      candidate: candidateBeforeReview,
      lease: currentLease,
      signal: controller.signal,
    });
    const integratedIssue = verificationFailure(integratedVerification, policy);
    if (integratedIssue !== undefined) throw new Error(integratedIssue);

    const review = async (
      mode: "full" | "targeted",
      candidate: SpecCandidate,
      targetedFindings: readonly Finding[],
    ): Promise<SpecReviewRound> => {
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
        readCurrent: options.readCurrent,
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
      reviews.push(round);
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
      await refreshLease();
      const fixed = await options.fixer.fix({
        delivery,
        candidate: candidateBeforeReview,
        findings: firstReview.findings,
        batch: 1,
        lease: currentLease,
        signal: controller.signal,
      });
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
      const fixedVerification = await options.verification.verifyIntegrated({
        delivery,
        candidate: fixedCandidate,
        lease: currentLease,
        signal: controller.signal,
      });
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
    blockedReason = errorMessage(error);
    controller.abort(blockedReason);
    await settleActiveWorkers();
  } finally {
    options.signal?.removeEventListener("abort", abortFromCaller);
  }

  return resultFor({
    outcome: "blocked",
    delivery,
    plan,
    lease: currentLease,
    integrationBranch: options.integrationBranch,
    pullRequest,
    candidate: currentCandidate(),
    children: childRecordsInPlanOrder(plan, records),
    reviews,
    repairBatches,
    followUps,
    reason: blockedReason,
  });
};
