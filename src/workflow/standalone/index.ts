import {
  parsePhaseResult,
  type CheckEvidence,
  type Finding,
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
import { parseGitHubPublicationMetadata } from "../../integrations/github/index.js";
import type { BranchLease, WorkflowJob } from "../coordinator/index.js";
import { sameRevision } from "../shared.js";

export interface StandaloneFixRequest {
  readonly candidate: HandoffCandidate;
  readonly findings: readonly Finding[];
  readonly batch: 1;
  readonly lease: BranchLease;
  readonly signal: AbortSignal;
}

export interface StandaloneFixResult {
  readonly head: HandoffCandidate["head"];
  readonly commits: readonly string[];
  readonly evidence: readonly string[];
}

export interface StandaloneFixer {
  fix(input: StandaloneFixRequest): Promise<StandaloneFixResult>;
}

export interface StandaloneDeliveryOptions extends Omit<
  AuthorizedImplementationOptions,
  "readCurrent"
> {
  readonly execution: NonNullable<AuthorizedImplementationOptions["execution"]>;
  readonly issueNumber: number;
  readonly review: ReviewProvider;
  /** One consolidated repair batch on the current PR candidate. */
  readonly fixer?: StandaloneFixer;
  readonly readCurrent: () => Promise<HandoffCandidate>;
  readonly signal?: AbortSignal;
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

const isActionable = (findings: readonly Finding[]): boolean =>
  findings.some(
    (finding) =>
      finding.severity !== "info" &&
      (finding.disposition === "open" || finding.disposition === "deferred"),
  );

const currentCandidateMatches = (
  expected: HandoffCandidate,
  current: HandoffCandidate,
): boolean =>
  sameRevision(expected.base, current.base) &&
  sameRevision(expected.head, current.head) &&
  expected.briefHash === current.briefHash;

const staleReview = (
  review: IndependentReviewResult,
  message: string,
): IndependentReviewResult => ({
  ...review,
  outcome: "blocked",
  reviewAxes: [],
  findings: [],
  evidence: [],
  reviewEvidence: {
    outcome: "blocked",
    axes: [],
    findings: [],
    baseSha: review.candidate.base.sha,
    headSha: review.candidate.head.sha,
    briefHash: review.candidate.brief.hash,
  },
  failure: { kind: "stale-candidate", message },
});

const checkConclusion = (
  check: CheckEvidence,
): "success" | "failure" | "neutral" | "action_required" | "stale" => {
  switch (check.status) {
    case "passed":
      return "success";
    case "failed":
      return "failure";
    case "blocked":
      return "action_required";
    case "incomplete":
      return "stale";
    case "unknown":
      return "neutral";
  }
};

const publicationBody = (
  body: string,
  checks: readonly CheckEvidence[],
  policy: StandaloneDeliveryOptions["policy"],
  repairEvidence: readonly string[],
): string => {
  const content = body
    .split(/\r?\n/)
    .filter((line) => !/^<!-- shipyard:[^>]+ -->$/.test(line.trim()))
    .join("\n");
  const beforeChecks = content.split(/^### Checks\s*$/m)[0]?.trim() ?? content;
  return [
    beforeChecks,
    "",
    "### Repair evidence",
    ...repairEvidence.map((evidence) => `- ${evidence}`),
    "",
    "### Checks",
    ...policy.checks.map((check) => {
      const actual = checks.find((entry) => entry.name === check.name);
      return `- ${check.name}: ${actual?.status ?? "missing"}`;
    }),
    "",
    "All configured checks and targeted independent review are required before handoff.",
  ].join("\n");
};

const savedReview = (
  candidate: HandoffCandidate,
  brief: StandaloneDeliveryOptions["brief"],
  policy: StandaloneDeliveryOptions["policy"],
  phaseResult: WorkflowJob["phaseResults"][number],
): IndependentReviewResult => {
  const outcome = isActionable(phaseResult.findings)
    ? "actionable-findings"
    : "passed";
  const axes = phaseResult.reviewAxes ?? [];
  return {
    outcome,
    candidate: { ...candidate, brief, policy },
    reviewAxes: axes,
    findings: phaseResult.findings,
    evidence: phaseResult.evidence,
    reviewEvidence: {
      outcome,
      axes,
      findings: phaseResult.findings,
      baseSha: candidate.base.sha,
      headSha: candidate.head.sha,
      briefHash: candidate.briefHash,
    },
  };
};

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
    let blockedPullRequest = pullRequest;
    if (job !== undefined && lease !== undefined) {
      try {
        const currentLease =
          await options.coordinator.heartbeatBranchLease(lease);
        const phase = review === undefined ? "implementation" : "review";
        const lastPhase = job.phaseResults.at(-1)?.phase;
        const projection = await options.publication.publishBlockedDelivery({
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
        blockedPullRequest =
          projection.pullRequest?.remote ?? blockedPullRequest;
      } catch (error) {
        reason = `${reason}; blocked-state projection failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return {
      ...blocked(implementation, reason, review),
      pullRequest: blockedPullRequest,
    };
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
  let currentJob = job;
  let activeLease = lease;
  let currentPullRequest = pullRequest;
  let currentPhaseResult = phaseResult;
  let candidate: HandoffCandidate = {
    base: options.brief.base,
    head: phaseResult.head,
    briefHash: options.brief.hash,
  };
  let checks: readonly CheckEvidence[] = phaseResult.checks;
  const currentImplementation = (): AuthorizedImplementationResult => ({
    ...implementation,
    job: currentJob,
    lease: activeLease,
    phaseResult: currentPhaseResult,
    pullRequest: currentPullRequest,
  });
  const projectCurrentBlocked = (
    reason: string,
    review?: IndependentReviewResult,
  ) => projectBlocked(currentImplementation(), reason, review);
  if (options.verifyChecks !== undefined) {
    try {
      checks = await options.verifyChecks(candidate);
    } catch (error) {
      return projectCurrentBlocked(
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
        return projectCurrentBlocked(
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
  const repairResultIndex =
    job.phaseResults
      .map((result, index) => ({ result, index }))
      .reverse()
      .find(
        ({ result }) =>
          result.phase === "repair" &&
          result.outcome === "completed" &&
          result.head !== undefined &&
          sameRevision(result.head, candidate.head) &&
          result.briefHash === candidate.briefHash,
      )?.index ?? -1;
  const priorActionableReview =
    repairResultIndex < 0
      ? undefined
      : [...job.phaseResults.slice(0, repairResultIndex)]
          .reverse()
          .find(
            (result) =>
              result.phase === "review" &&
              result.outcome === "completed" &&
              result.base !== undefined &&
              result.head !== undefined &&
              sameRevision(result.base, candidate.base) &&
              !sameRevision(result.head, candidate.head) &&
              result.briefHash === candidate.briefHash &&
              isActionable(result.findings),
          );
  const resumedTargetedFindings =
    priorReview === undefined ? priorActionableReview?.findings : undefined;
  let review: IndependentReviewResult | undefined;
  let reviewEvidence: ReviewEvidence;
  if (priorReview !== undefined) {
    if (priorReview.outcome !== "completed") {
      return projectCurrentBlocked("Prior independent review did not pass");
    }
    review = savedReview(candidate, options.brief, options.policy, priorReview);
    reviewEvidence = review.reviewEvidence;
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
      mode: resumedTargetedFindings === undefined ? "full" : "targeted",
      targetedFindings: resumedTargetedFindings,
      signal: options.signal,
    });
    if (
      review.outcome !== "passed" &&
      review.outcome !== "actionable-findings"
    ) {
      return projectCurrentBlocked(
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
      return projectCurrentBlocked(
        dispatch.reason ?? "Review evidence is not dispatchable",
        review,
      );
    }
    const assignment = dispatch.assignment;
    if (assignment.phase !== "review") {
      return projectCurrentBlocked("Expected a review assignment", review);
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
      summary:
        review.outcome === "passed"
          ? "Independent review passed."
          : "Independent review found actionable findings.",
      evidence: review.evidence,
      checks,
      commits: [],
      artifacts: [],
      questions: [],
      findings: review.findings,
      reviewAxes: review.reviewAxes,
      completedAt: new Date().toISOString(),
    });
    activeLease = await options.coordinator.heartbeatBranchLease(activeLease);
    const recorded = await options.coordinator.recordPhaseResult({
      jobId: job.id,
      result: reviewResult,
      lease: activeLease,
    });
    currentJob = recorded.job;
    reviewEvidence = review.reviewEvidence;
  }

  if (review?.outcome === "actionable-findings") {
    if (
      options.fixer === undefined ||
      options.policy.repairBudget.maxBatches < 1 ||
      currentJob.repairBatches >= options.policy.repairBudget.maxBatches
    ) {
      return projectCurrentBlocked(
        "Review found actionable findings and no repair batch is available",
        review,
      );
    }
    const repairFindings = review.findings;

    try {
      if (!currentCandidateMatches(candidate, await options.readCurrent())) {
        return projectCurrentBlocked(
          "Review candidate changed before repair",
          staleReview(review, "Review candidate changed before repair"),
        );
      }
    } catch (error) {
      return projectCurrentBlocked(
        `Could not verify the review candidate before repair: ${error instanceof Error ? error.message : String(error)}`,
        staleReview(
          review,
          "Could not verify the review candidate before repair",
        ),
      );
    }

    let repairLease =
      await options.coordinator.heartbeatBranchLease(activeLease);
    activeLease = repairLease;
    try {
      await options.publication.invalidatePullRequestHandoff({
        jobId: job.id,
        lease: repairLease,
        pullRequestNumber: pullRequest.number,
        branch: candidate.head.branch,
        baseBranch: options.policy.baseBranch,
        headSha: candidate.head.sha,
        briefHash: candidate.briefHash,
        reason: "A consolidated review repair is updating this candidate",
      });
    } catch (error) {
      return projectCurrentBlocked(
        `Could not invalidate stale pull request readiness: ${error instanceof Error ? error.message : String(error)}`,
        review,
      );
    }

    const repairRequest = await options.coordinator.scheduleRepair({
      jobId: currentJob.id,
      brief: options.brief,
      policy: options.policy,
      relevantRevision: candidate.head.sha,
    });
    if (repairRequest.status !== "scheduled") {
      return projectCurrentBlocked(
        repairRequest.reason ?? "Consolidated repair could not be scheduled",
        review,
      );
    }
    currentJob = repairRequest.job;
    const repairDispatch = await options.coordinator.dispatchNext({
      repository: options.brief.identity.repository,
      workerId: options.workerId,
      jobId: currentJob.id,
    });
    if (
      repairDispatch.status !== "dispatched" ||
      repairDispatch.assignment?.phase !== "repair"
    ) {
      return projectCurrentBlocked(
        repairDispatch.reason ?? "Consolidated repair was not dispatched",
        review,
      );
    }
    const repairAssignment = repairDispatch.assignment;
    try {
      const fixed = await options.fixer.fix({
        candidate,
        findings: review.findings,
        batch: 1,
        lease: repairLease,
        signal: options.signal ?? new AbortController().signal,
      });
      if (
        fixed.head.branch !== candidate.head.branch ||
        !/^[a-f0-9]{40,64}$/i.test(fixed.head.sha) ||
        fixed.head.sha === candidate.head.sha ||
        fixed.commits.length === 0 ||
        !fixed.commits.includes(fixed.head.sha) ||
        fixed.evidence.length === 0
      ) {
        throw new Error("Repair batch returned no verifiable new candidate");
      }
      const fixedCandidate: HandoffCandidate = {
        ...candidate,
        head: fixed.head,
      };
      const previousHeadSha = candidate.head.sha;
      if (!currentCandidateMatches(candidate, await options.readCurrent())) {
        return projectCurrentBlocked(
          "Review candidate changed while repair was running",
          staleReview(
            review,
            "Review candidate changed while repair was running",
          ),
        );
      }
      if (options.verifyChecks === undefined) {
        throw new Error("Current-candidate checks are required after repair");
      }
      const repairedChecks = await options.verifyChecks(fixedCandidate);
      for (const required of options.policy.checks.filter(
        (check) => check.required,
      )) {
        const actual = repairedChecks.find(
          (check) => check.name === required.name,
        );
        if (
          actual === undefined ||
          actual.status !== "passed" ||
          actual.baseSha !== fixedCandidate.base.sha ||
          actual.headSha !== fixedCandidate.head.sha ||
          actual.briefHash !== fixedCandidate.briefHash
        ) {
          throw new Error(
            `Required check ${required.name} did not pass for the repaired candidate`,
          );
        }
      }

      repairLease = await options.coordinator.heartbeatBranchLease(repairLease);
      activeLease = repairLease;
      const repairResult = parsePhaseResult({
        contractVersion: 1,
        assignmentId: repairAssignment.id,
        phase: "repair",
        outcome: "completed",
        identity: repairAssignment.identity,
        briefHash: repairAssignment.briefHash,
        base: candidate.base,
        head: fixed.head,
        summary: "One consolidated repair batch completed.",
        evidence: fixed.evidence,
        checks: repairedChecks,
        commits: fixed.commits,
        artifacts: [],
        questions: [],
        findings: [],
        completedAt: new Date().toISOString(),
      });
      const recordedRepair = await options.coordinator.recordPhaseResult({
        jobId: currentJob.id,
        result: repairResult,
        lease: repairLease,
      });
      currentJob = recordedRepair.job;
      candidate = fixedCandidate;
      checks = repairedChecks;
      currentPhaseResult = {
        ...currentPhaseResult,
        head: fixed.head,
        checks: repairedChecks,
        commits: [...currentPhaseResult.commits, ...fixed.commits],
        evidence: [...currentPhaseResult.evidence, ...fixed.evidence],
        summary: `${currentPhaseResult.summary} A consolidated repair was applied.`,
      };
      review = staleReview(
        review,
        "The reviewed candidate was replaced by a repair; targeted re-review is pending",
      );
      reviewEvidence = review.reviewEvidence;

      await options.publication.publishBranch({
        jobId: currentJob.id,
        lease: repairLease,
        branch: candidate.head.branch,
        headSha: candidate.head.sha,
      });
      for (const check of checks) {
        await options.publication.publishCheck({
          jobId: currentJob.id,
          lease: repairLease,
          branch: candidate.head.branch,
          name: check.name,
          headSha: candidate.head.sha,
          status: "completed",
          conclusion: checkConclusion(check),
          summary: check.summary,
        });
      }
      const metadata = parseGitHubPublicationMetadata(pullRequest.body);
      if (metadata === undefined || metadata.headSha !== previousHeadSha) {
        throw new Error(
          "Pull request candidate metadata is unavailable for repair",
        );
      }
      const refreshed = await options.publication.publishPullRequest({
        jobId: currentJob.id,
        lease: repairLease,
        title: pullRequest.title,
        body: publicationBody(
          pullRequest.body,
          checks,
          options.policy,
          fixed.evidence,
        ),
        branch: candidate.head.branch,
        baseBranch: options.policy.baseBranch,
        headSha: candidate.head.sha,
        draft: true,
        metadata: { ...metadata, headSha: candidate.head.sha },
      });
      if (refreshed.remote === undefined) {
        throw new Error("Repaired pull request candidate was not published");
      }
      currentPullRequest = refreshed.remote;

      const scheduledReview = await options.coordinator.schedulePhase({
        jobId: currentJob.id,
        phase: "review",
        relevantRevision: candidate.head.sha,
        head: candidate.head,
      });
      if (scheduledReview.status !== "scheduled") {
        throw new Error(
          scheduledReview.reason ?? "Targeted review could not be scheduled",
        );
      }
      const targetedReview = await runIndependentReview({
        candidate: {
          base: candidate.base,
          head: candidate.head,
          brief: options.brief,
          policy: options.policy,
        },
        provider: options.review,
        readCurrent: options.readCurrent,
        mode: "targeted",
        targetedFindings: repairFindings,
        signal: options.signal,
      });
      if (
        targetedReview.outcome !== "passed" &&
        targetedReview.outcome !== "actionable-findings"
      ) {
        return projectCurrentBlocked(
          targetedReview.failure?.message ??
            `Targeted review ${targetedReview.outcome}`,
          targetedReview,
        );
      }
      const targetedDispatch = await options.coordinator.dispatchNext({
        repository: options.brief.identity.repository,
        workerId: options.workerId,
        jobId: currentJob.id,
      });
      if (
        targetedDispatch.status !== "dispatched" ||
        targetedDispatch.assignment?.phase !== "review"
      ) {
        throw new Error(
          targetedDispatch.reason ?? "Targeted review was not dispatched",
        );
      }
      const targetedAssignment = targetedDispatch.assignment;
      const targetedResult = parsePhaseResult({
        contractVersion: 1,
        assignmentId: targetedAssignment.id,
        phase: "review",
        outcome: "completed",
        identity: targetedAssignment.identity,
        briefHash: targetedAssignment.briefHash,
        base: candidate.base,
        head: candidate.head,
        summary:
          targetedReview.outcome === "passed"
            ? "Targeted independent review passed."
            : "Targeted independent review found unresolved findings.",
        evidence: targetedReview.evidence,
        checks,
        commits: [],
        artifacts: [],
        questions: [],
        findings: targetedReview.findings,
        reviewAxes: targetedReview.reviewAxes,
        completedAt: new Date().toISOString(),
      });
      activeLease = await options.coordinator.heartbeatBranchLease(repairLease);
      const recordedTargeted = await options.coordinator.recordPhaseResult({
        jobId: currentJob.id,
        result: targetedResult,
        lease: activeLease,
      });
      currentJob = recordedTargeted.job;
      review = targetedReview;
      reviewEvidence = targetedReview.reviewEvidence;
      if (targetedReview.outcome !== "passed") {
        return projectCurrentBlocked(
          "Targeted review left actionable findings; the repair budget is exhausted",
          targetedReview,
        );
      }
    } catch (error) {
      return projectCurrentBlocked(
        `Consolidated repair failed: ${error instanceof Error ? error.message : String(error)}`,
        review,
      );
    }
  } else if (review?.outcome !== "passed") {
    return projectCurrentBlocked(
      review?.failure?.message ?? "Independent review did not pass",
      review,
    );
  }

  activeLease = await options.coordinator.heartbeatBranchLease(activeLease);
  if (!(await options.cleanup(candidate))) {
    return projectCurrentBlocked("Candidate cleanup/self-check failed", review);
  }
  const readiness = await prepareHumanHandoff({
    job: currentJob,
    candidate,
    checks,
    review: reviewEvidence,
    sourceIssueNumber: options.issueNumber,
    pullRequestNumber: currentPullRequest.number,
    readCurrent: options.readCurrent,
  });
  if (!readiness.readyForHuman) {
    return projectCurrentBlocked(
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
      lease: activeLease,
      pullRequestNumber: currentPullRequest.number,
      branch: candidate.head.branch,
      baseBranch: options.policy.baseBranch,
      headSha: candidate.head.sha,
      briefHash: candidate.briefHash,
      readCurrent: options.readCurrent,
    });
  } catch (error) {
    return projectCurrentBlocked(
      `Human handoff failed: ${error instanceof Error ? error.message : String(error)}`,
      review,
    );
  }
  if (handoff.remote === undefined || handoff.remote.draft) {
    return projectCurrentBlocked(
      "Human handoff publication is incomplete",
      review,
    );
  }
  let issueClosed = false;
  try {
    const closure = await options.publication.publishStandaloneIssueClosure({
      jobId: job.id,
      lease: activeLease,
      issueNumber: options.issueNumber,
      branch: candidate.head.branch,
      commitSha: candidate.head.sha,
      pullRequestNumber: currentPullRequest.number,
      checks,
      cleanupCompleted: true,
    });
    issueClosed = closure.issue.remote?.state === "closed";
  } catch (error) {
    return {
      ...(await projectCurrentBlocked(
        `Source issue closure failed after human handoff: ${error instanceof Error ? error.message : String(error)}`,
        review,
      )),
      pullRequest: handoff.remote,
    };
  }
  if (!issueClosed) {
    return {
      ...(await projectCurrentBlocked(
        "Source issue closure is incomplete after human handoff",
        review,
      )),
      pullRequest: handoff.remote,
    };
  }
  return {
    outcome: "ready-for-human",
    issueClosed: true,
    implementation: currentImplementation(),
    review,
    pullRequest: handoff.remote,
  };
};
