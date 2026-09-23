import {
  parsePhaseResult,
  type CheckEvidence,
  type ReviewEvidence,
} from "../contracts/index.js";
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
import type {
  GitHubPublication,
  GitHubPullRequestSnapshot,
} from "../../integrations/github/index.js";
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
  /** Host verification of the exact remotely published candidate. */
  readonly verifyChecks?: (
    candidate: HandoffCandidate,
  ) => Promise<readonly CheckEvidence[]>;
}

export interface StandaloneDeliveryResult {
  readonly outcome: "ready-for-human" | "blocked";
  readonly reason?: string;
  readonly issueClosed?: boolean;
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
  const projectBlocked = async (
    implementation: AuthorizedImplementationResult,
    reason: string,
    review?: IndependentReviewResult,
  ): Promise<StandaloneDeliveryResult> => {
    const { job, lease, phaseResult, pullRequest } = implementation;
    if (job !== undefined && lease !== undefined) {
      try {
        const currentLease =
          await options.coordinator.heartbeatBranchLease(lease);
        const phase = review === undefined ? "implementation" : "review";
        const lastPhase = job.phaseResults.at(-1)?.phase;
        await options.publication.publishBlockedDelivery({
          jobId: job.id,
          lease: currentLease,
          issueNumber: options.issueNumber,
          evidence: {
            phase,
            error: reason,
            attempts: Math.max(1, job.phaseAttempts[phase]),
            lastSuccessfulStep: lastPhase,
            branch:
              phaseResult?.head?.branch ?? pullRequest?.branch ?? lease.branch,
            commit: phaseResult?.head?.sha,
            pullRequest:
              pullRequest?.htmlUrl ??
              (pullRequest === undefined
                ? undefined
                : `#${pullRequest.number}`),
            recovery:
              "Review the issue evidence, then re-add the shipyard label to resume this delivery.",
            occurredAt: new Date().toISOString(),
          },
          pullRequest:
            pullRequest === undefined
              ? undefined
              : {
                  number: pullRequest.number,
                  branch: pullRequest.branch,
                  baseBranch: pullRequest.baseBranch,
                  headSha: pullRequest.headSha,
                },
        });
      } catch (error) {
        reason = `${reason}; blocked-state projection failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return blocked(implementation, reason, review);
  };
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
    return projectBlocked(
      implementation,
      implementation.reason ?? "Implementation is not ready for review",
    );
  }
  const candidate: HandoffCandidate = {
    base: options.brief.base,
    head: phaseResult.head,
    briefHash: options.brief.hash,
  };
  let checks: readonly CheckEvidence[] = phaseResult.checks;
  if (options.verifyChecks !== undefined) {
    try {
      checks = await options.verifyChecks(candidate);
    } catch (error) {
      return projectBlocked(
        implementation,
        `Candidate checks failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    for (const required of options.policy.checks.filter(
      (check) => check.required,
    )) {
      const actual = checks.find((check) => check.name === required.name);
      if (
        actual === undefined ||
        actual.status !== "passed" ||
        actual.baseSha !== candidate.base.sha ||
        actual.headSha !== candidate.head.sha ||
        actual.briefHash !== candidate.briefHash
      ) {
        return projectBlocked(
          implementation,
          `Required check ${required.name} did not pass for the current candidate`,
        );
      }
    }
  }
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
      return projectBlocked(
        implementation,
        "Prior independent review did not pass",
      );
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
      return projectBlocked(
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
      return projectBlocked(
        implementation,
        dispatch.reason ?? "Review evidence is not dispatchable",
        review,
      );
    }
    const assignment = dispatch.assignment;
    if (assignment.phase !== "review") {
      return projectBlocked(
        implementation,
        "Expected a review assignment",
        review,
      );
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
      checks,
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
    return projectBlocked(
      implementation,
      "Candidate cleanup/self-check failed",
      review,
    );
  }
  const readiness = await prepareHumanHandoff({
    job: currentJob,
    candidate,
    checks,
    review: reviewEvidence,
    sourceIssueNumber: options.issueNumber,
    pullRequestNumber: pullRequest.number,
    readCurrent: options.readCurrent,
  });
  if (!readiness.readyForHuman) {
    return projectBlocked(
      implementation,
      readiness.reasons.join("; ") || "Candidate is not ready for handoff",
      review,
    );
  }
  let handoff: Awaited<
    ReturnType<GitHubPublication["publishPullRequestHandoff"]>
  >;
  try {
    handoff = await options.publication.publishPullRequestHandoff({
      jobId: job.id,
      lease: currentLease,
      pullRequestNumber: pullRequest.number,
      branch: candidate.head.branch,
      baseBranch: options.policy.baseBranch,
      headSha: candidate.head.sha,
      briefHash: candidate.briefHash,
      readCurrent: options.readCurrent,
    });
  } catch (error) {
    return projectBlocked(
      implementation,
      `Human handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      review,
    );
  }
  if (handoff.remote === undefined || handoff.remote.draft) {
    return projectBlocked(
      implementation,
      "Human handoff publication is incomplete",
      review,
    );
  }
  let issueClosed = false;
  try {
    const closure = await options.publication.publishStandaloneIssueClosure({
      jobId: job.id,
      lease: currentLease,
      issueNumber: options.issueNumber,
      branch: candidate.head.branch,
      commitSha: candidate.head.sha,
      pullRequestNumber: pullRequest.number,
      checks,
      cleanupCompleted: true,
    });
    issueClosed = closure.issue.remote?.state === "closed";
  } catch (error) {
    return {
      ...(await projectBlocked(
        implementation,
        `Source issue closure failed after human handoff: ${error instanceof Error ? error.message : String(error)}`,
        review,
      )),
      pullRequest: handoff.remote,
    };
  }
  if (!issueClosed) {
    return {
      ...(await projectBlocked(
        implementation,
        "Source issue closure is incomplete after human handoff",
        review,
      )),
      pullRequest: handoff.remote,
    };
  }
  return {
    outcome: "ready-for-human",
    issueClosed: true,
    implementation,
    review,
    pullRequest: handoff.remote,
  };
};
