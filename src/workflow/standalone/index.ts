import { parsePhaseResult, type ReviewEvidence } from "../contracts/index.js";
import {
  prepareHumanHandoff,
  type HandoffCandidate,
} from "../handoff/index.js";
import {
  runAuthorizedImplementation,
  type AuthorizedImplementationOptions,
  type AuthorizedImplementationResult,
} from "../implementation/index.js";
import {
  runIndependentReview,
  type IndependentReviewResult,
  type ReviewProvider,
} from "../review/index.js";
import type { GitHubPullRequestSnapshot } from "../../integrations/github/index.js";
import { sameRevision } from "../shared.js";

export interface StandaloneDeliveryOptions extends Omit<
  AuthorizedImplementationOptions,
  "readCurrent"
> {
  readonly execution: NonNullable<AuthorizedImplementationOptions["execution"]>;
  readonly issueNumber: number;
  readonly review: ReviewProvider;
  readonly readCurrent: () => Promise<HandoffCandidate>;
  /** Host cleanup/self-check on the published exact candidate. */
  readonly cleanup: (candidate: HandoffCandidate) => Promise<boolean>;
}

export interface StandaloneDeliveryResult {
  readonly outcome: "ready-for-human" | "blocked";
  readonly reason?: string;
  readonly implementation: AuthorizedImplementationResult;
  readonly review?: IndependentReviewResult;
  readonly pullRequest?: GitHubPullRequestSnapshot;
}

const blocked = (
  implementation: AuthorizedImplementationResult,
  reason: string,
  review?: IndependentReviewResult,
): StandaloneDeliveryResult => ({
  outcome: "blocked",
  reason,
  implementation,
  review,
  pullRequest: implementation.pullRequest,
});

/** Complete one standalone issue through review and human PR handoff. */
export const deliverStandalone = async (
  options: StandaloneDeliveryOptions,
): Promise<StandaloneDeliveryResult> => {
  const implementation = await runAuthorizedImplementation({
    ...options,
    readCurrent: async () => {
      const current = await options.readCurrent();
      return { base: current.base, briefHash: current.briefHash };
    },
  });
  const { job, lease, phaseResult, pullRequest } = implementation;
  if (
    implementation.outcome !== "completed" ||
    !implementation.readyForReview ||
    job === undefined ||
    lease === undefined ||
    phaseResult?.head === undefined ||
    pullRequest === undefined
  ) {
    return blocked(
      implementation,
      implementation.reason ?? "Implementation is not ready for review",
    );
  }
  const candidate: HandoffCandidate = {
    base: options.brief.base,
    head: phaseResult.head,
    briefHash: options.brief.hash,
  };
  const priorReview = [...job.phaseResults]
    .reverse()
    .find(
      (result) =>
        result.phase === "review" &&
        result.base !== undefined &&
        result.head !== undefined &&
        sameRevision(result.base, candidate.base) &&
        sameRevision(result.head, candidate.head) &&
        result.briefHash === candidate.briefHash,
    );
  let review: IndependentReviewResult | undefined;
  let reviewEvidence: ReviewEvidence;
  let currentJob = job;
  if (priorReview !== undefined) {
    if (priorReview.outcome !== "completed") {
      return blocked(implementation, "Prior independent review did not pass");
    }
    reviewEvidence = {
      outcome: "passed",
      axes: priorReview.reviewAxes ?? [],
      findings: priorReview.findings,
      baseSha: candidate.base.sha,
      headSha: candidate.head.sha,
      briefHash: candidate.briefHash,
    };
  } else {
    review = await runIndependentReview({
      candidate: {
        base: candidate.base,
        head: candidate.head,
        brief: options.brief,
        policy: options.policy,
      },
      provider: options.review,
      readCurrent: options.readCurrent,
    });
    if (review.outcome !== "passed") {
      return blocked(
        implementation,
        review.failure?.message ?? `Independent review ${review.outcome}`,
        review,
      );
    }
    const dispatch = await options.coordinator.dispatchNext({
      repository: options.brief.identity.repository,
      workerId: options.workerId,
      jobId: job.id,
    });
    if (dispatch.status !== "dispatched" || dispatch.assignment === undefined) {
      return blocked(
        implementation,
        dispatch.reason ?? "Review evidence is not dispatchable",
        review,
      );
    }
    const assignment = dispatch.assignment;
    if (assignment.phase !== "review") {
      return blocked(implementation, "Expected a review assignment", review);
    }
    const reviewResult = parsePhaseResult({
      contractVersion: 1,
      assignmentId: assignment.id,
      phase: "review",
      outcome: "completed",
      identity: assignment.identity,
      briefHash: assignment.briefHash,
      base: candidate.base,
      head: candidate.head,
      summary: "Independent review passed.",
      evidence: review.evidence,
      checks: phaseResult.checks,
      commits: [],
      artifacts: [],
      questions: [],
      findings: review.findings,
      reviewAxes: review.reviewAxes,
      completedAt: new Date().toISOString(),
    });
    const recorded = await options.coordinator.recordPhaseResult({
      jobId: job.id,
      result: reviewResult,
      lease: await options.coordinator.heartbeatBranchLease(lease),
    });
    currentJob = recorded.job;
    reviewEvidence = review.reviewEvidence;
  }
  const currentLease = await options.coordinator.heartbeatBranchLease(lease);
  if (!(await options.cleanup(candidate))) {
    return blocked(
      implementation,
      "Candidate cleanup/self-check failed",
      review,
    );
  }
  const readiness = await prepareHumanHandoff({
    job: currentJob,
    candidate,
    checks: phaseResult.checks,
    review: reviewEvidence,
    sourceIssueNumber: options.issueNumber,
    pullRequestNumber: pullRequest.number,
    readCurrent: options.readCurrent,
  });
  if (!readiness.readyForHuman) {
    return blocked(
      implementation,
      readiness.reasons.join("; ") || "Candidate is not ready for handoff",
      review,
    );
  }
  const handoff = await options.publication.publishPullRequestHandoff({
    jobId: job.id,
    lease: currentLease,
    pullRequestNumber: pullRequest.number,
    branch: candidate.head.branch,
    baseBranch: options.policy.baseBranch,
    headSha: candidate.head.sha,
    briefHash: candidate.briefHash,
    readCurrent: options.readCurrent,
  });
  if (handoff.remote === undefined || handoff.remote.draft) {
    return blocked(
      implementation,
      "Human handoff publication is incomplete",
      review,
    );
  }
  return {
    outcome: "ready-for-human",
    implementation,
    review,
    pullRequest: handoff.remote,
  };
};
