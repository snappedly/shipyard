import {
  isAuthorizationAllowed,
  parseRepositoryPolicy,
  parseWorkBrief,
  type Assignment,
  type CheckEvidence,
  type PhaseResult,
  type RepositoryPolicy,
  type RevisionReference,
  type WorkBrief,
  type WorkflowPhase,
} from "../contracts/index.js";
import {
  executePhase,
  type ExecutePhaseOptions,
  type PhaseExecutionResult,
} from "../execution/index.js";
import type {
  GitHubCheckPublicationInput,
  GitHubPublication,
  GitHubPublicationResult,
  GitHubPullRequestSnapshot,
} from "../../integrations/github/index.js";
import type { ReviewCandidate } from "../review/index.js";
import { sameRevision } from "../shared.js";
import type {
  BranchLease,
  DispatchIntent,
  DispatchResult,
  WorkflowCoordinator,
  WorkflowJob,
} from "../coordinator/index.js";

export interface CurrentImplementationCandidate {
  readonly base: RevisionReference;
  readonly briefHash: string;
}

export interface ImplementationExecutionTemplate extends Omit<
  ExecutePhaseOptions,
  "assignment" | "branch"
> {
  readonly branch?: string;
}

export interface AuthorizedImplementationOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly publication: GitHubPublication;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly workerId: string;
  readonly issueNumber?: number;
  readonly branch?: string;
  readonly execution?: ImplementationExecutionTemplate;
  readonly readCurrent?: () => Promise<CurrentImplementationCandidate>;
  readonly now?: () => string;
  readonly leaseTtlMs?: number;
}

export type ImplementationOutcome =
  | "dispatched"
  | "completed"
  | "needs-info"
  | "blocked"
  | "failed";

export interface ImplementationPublication {
  readonly brief?: GitHubPublicationResult<unknown>;
  readonly checks: readonly GitHubPublicationResult<unknown>[];
  readonly branch?: GitHubPublicationResult<unknown>;
  readonly pullRequest?: GitHubPublicationResult<GitHubPullRequestSnapshot>;
}

export interface AuthorizedImplementationResult {
  readonly outcome: ImplementationOutcome;
  readonly reason?: string;
  readonly job?: WorkflowJob;
  readonly dispatch?: DispatchResult;
  readonly assignment?: Assignment;
  readonly lease?: BranchLease;
  readonly phaseResult?: PhaseResult;
  readonly execution?: PhaseExecutionResult;
  readonly publication?: ImplementationPublication;
  readonly pullRequest?: GitHubPullRequestSnapshot;
  readonly nextPhase?: "review";
  readonly nextDispatch?: DispatchIntent;
  readonly readyForReview: boolean;
}

export interface ReviewSchedulingInput {
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly checks: readonly CheckEvidence[];
  readonly requiredAxes?: ReviewCandidate["requiredAxes"];
}

export interface ReviewSchedulingResult {
  readonly status: "ready" | "blocked";
  readonly reasons: readonly string[];
  readonly candidate?: ReviewCandidate;
}

const defaultNow = (): string => new Date().toISOString();

const branchPart = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^[./-]+|[./-]+$/g, "")
    .slice(0, 80) || "work";

const defaultBranch = (brief: WorkBrief): string =>
  `shipyard/${branchPart(brief.identity.itemId)}-${branchPart(brief.identity.kind)}`;

const phaseResultFor = (
  job: WorkflowJob,
  phase: WorkflowPhase,
): PhaseResult | undefined =>
  [...job.phaseResults].reverse().find((result) => result.phase === phase);

const latestAssignmentFor = (
  job: WorkflowJob,
  phase: WorkflowPhase,
): Assignment | undefined =>
  [...job.assignments]
    .reverse()
    .find((assignment) => assignment.phase === phase);

const requiredChecks = (policy: RepositoryPolicy): readonly string[] =>
  policy.checks.filter((check) => check.required).map((check) => check.name);

const checkByName = (
  checks: readonly CheckEvidence[],
  name: string,
): CheckEvidence | undefined => checks.find((check) => check.name === name);

const readinessReason = (
  brief: WorkBrief,
  result: PhaseResult,
): string | undefined => {
  if (result.commits.length === 0) return "Implementation returned no commit";
  if (result.evidence.length < brief.acceptanceCriteria.length) {
    return "Implementation did not return evidence for every acceptance criterion";
  }
  for (const required of brief.verification.checks) {
    const check = result.checks.find(
      (candidate) =>
        candidate.name === required || candidate.command === required,
    );
    if (check === undefined) return `Required check is missing: ${required}`;
  }
  return undefined;
};

const checkReadiness = (
  policy: RepositoryPolicy,
  result: PhaseResult,
): string | undefined => {
  for (const required of requiredChecks(policy)) {
    const check = checkByName(result.checks, required);
    if (check === undefined) return `Required check is missing: ${required}`;
    if (check.status !== "passed") {
      return `Required check ${required} is ${check.status}`;
    }
  }
  return undefined;
};

const checkConclusion = (
  check: CheckEvidence,
): GitHubCheckPublicationInput["conclusion"] => {
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

const checkSummary = (check: CheckEvidence): string =>
  `${check.summary}${check.exitCode === undefined ? "" : ` (exit ${check.exitCode})`}`;

const publicPrBody = (
  brief: WorkBrief,
  result: PhaseResult,
  readinessIssue: string | undefined,
  policy: RepositoryPolicy,
): string =>
  [
    "## Shipyard implementation",
    "",
    `Source issue: #${brief.identity.itemId}`,
    `Brief revision: ${brief.revision}`,
    `Brief hash: \`${brief.hash}\``,
    `Risk: ${brief.risk}`,
    "",
    "### Acceptance evidence",
    ...result.evidence.map((evidence) => `- ${evidence}`),
    "",
    "### Checks",
    ...policy.checks.map((check) => {
      const actual = checkByName(result.checks, check.name);
      return `- ${check.name}: ${actual?.status ?? "missing"}`;
    }),
    "",
    readinessIssue === undefined
      ? "All configured implementation gates are satisfied; independent review is next."
      : `Readiness is blocked: ${readinessIssue}`,
    "",
    "The source issue remains open until the configured closure point.",
  ].join("\n");

const implementationTitle = (brief: WorkBrief): string =>
  `[Shipyard] ${brief.problem.split("\n")[0] ?? brief.identity.itemId}`;

const blocked = (
  reason: string,
  extra: Omit<
    AuthorizedImplementationResult,
    "outcome" | "reason" | "readyForReview"
  > = {},
): AuthorizedImplementationResult => ({
  ...extra,
  outcome: "blocked",
  reason,
  readyForReview: false,
});

const validateInputs = (
  brief: WorkBrief,
  policy: RepositoryPolicy,
): string | undefined => {
  if (brief.identity.kind !== "executable-issue") {
    return "Only executable issues may enter implementation";
  }
  if (!isAuthorizationAllowed(brief, policy)) {
    return "Implementation authorization is not approved";
  }
  if (brief.unresolvedQuestions.length > 0) {
    return "Implementation is waiting for clarification";
  }
  if (brief.acceptanceCriteria.length === 0) {
    return "Implementation requires acceptance criteria";
  }
  if (brief.identity.repository !== policy.repository) {
    return "Brief and policy repositories do not match";
  }
  if (brief.policyRevision !== policy.revision) {
    return "Brief uses a stale policy revision";
  }
  if (brief.base.branch !== policy.baseBranch) {
    return "Brief base branch does not match repository policy";
  }
  return undefined;
};

/** Build a review candidate only after the current implementation checks pass. */
export const prepareIndependentReview = (
  input: ReviewSchedulingInput,
): ReviewSchedulingResult => {
  const brief = parseWorkBrief(input.brief);
  const policy = parseRepositoryPolicy(input.policy);
  const reasons: string[] = [];
  if (brief.identity.kind !== "executable-issue") {
    reasons.push("Only executable issues may be reviewed");
  }
  if (!isAuthorizationAllowed(brief, policy)) {
    reasons.push("Review candidate authorization is not approved");
  }
  if (brief.identity.repository !== policy.repository) {
    reasons.push("Review policy repository does not match the brief");
  }
  if (brief.policyRevision !== policy.revision) {
    reasons.push("Review candidate uses a stale policy revision");
  }
  if (!sameRevision(brief.base, input.base)) {
    reasons.push("Review base does not match the brief base");
  }
  for (const check of policy.checks) {
    if (!check.required) continue;
    const actual = input.checks.find(
      (candidate) =>
        candidate.name === check.name || candidate.command === check.command,
    );
    if (actual === undefined)
      reasons.push(`Required check is missing: ${check.name}`);
    else if (actual.status !== "passed") {
      reasons.push(`Required check ${check.name} is ${actual.status}`);
    }
  }
  if (reasons.length > 0) return { status: "blocked", reasons };
  return {
    status: "ready",
    reasons: [],
    candidate: {
      base: input.base,
      head: input.head,
      brief,
      policy,
      requiredAxes: ["standards", "spec", ...(input.requiredAxes ?? [])],
    },
  };
};

const resultOutcome = (
  result: PhaseResult,
): Extract<ImplementationOutcome, "completed" | "needs-info" | "failed"> => {
  switch (result.outcome) {
    case "completed":
      return "completed";
    case "needs-info":
      return "needs-info";
    case "failed":
    case "cancelled":
    case "blocked":
      return "failed";
  }
};

export const runAuthorizedImplementation = async (
  options: AuthorizedImplementationOptions,
): Promise<AuthorizedImplementationResult> => {
  const brief = parseWorkBrief(options.brief);
  const policy = parseRepositoryPolicy(options.policy);
  const invalid = validateInputs(brief, policy);
  if (invalid !== undefined) return blocked(invalid);
  if (options.readCurrent !== undefined) {
    let current: CurrentImplementationCandidate;
    try {
      current = await options.readCurrent();
    } catch (error) {
      return blocked(
        `Could not validate the current candidate: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sameRevision(current.base, brief.base)) {
      return blocked("The configured base revision is stale");
    }
    if (current.briefHash !== brief.hash) {
      return blocked("The executable brief is stale");
    }
  }

  const now = options.now ?? defaultNow;
  let job = await options.coordinator.getCurrentJob(brief.identity);
  if (
    job === undefined ||
    job.control !== "active" ||
    job.brief.hash !== brief.hash
  ) {
    const ingested = await options.coordinator.ingest({
      deliveryId: `implementation:${brief.id}:${brief.revision}:${brief.hash}`,
      brief,
      policy,
      phase: "implementation",
      relevantRevision: brief.base.sha,
      observedAt: now(),
      sourceState: "open",
      payload: { source: "authorized-implementation", briefId: brief.id },
    });
    job = ingested.job;
  }
  if (job === undefined) return blocked("Coordinator did not return a job");

  let assignment = latestAssignmentFor(job, "implementation");
  let dispatch: DispatchResult | undefined;
  let phaseResult = phaseResultFor(job, "implementation");
  if (phaseResult !== undefined) {
    const completedRepair = [...job.phaseResults]
      .reverse()
      .find(
        (result) =>
          result.phase === "repair" &&
          result.outcome === "completed" &&
          result.head !== undefined &&
          result.base !== undefined &&
          result.briefHash === brief.hash &&
          sameRevision(result.base, brief.base),
      );
    if (
      completedRepair?.head !== undefined &&
      phaseResult.head?.sha !== completedRepair.head.sha
    ) {
      phaseResult = {
        ...phaseResult,
        head: completedRepair.head,
        checks: completedRepair.checks,
        commits: [...phaseResult.commits, ...completedRepair.commits],
        evidence: [...phaseResult.evidence, ...completedRepair.evidence],
        summary: `${phaseResult.summary} A consolidated repair was applied.`,
      };
    }
  }
  if (phaseResult === undefined) {
    dispatch = await options.coordinator.dispatchNext({
      repository: brief.identity.repository,
      workerId: options.workerId,
      jobId: job.id,
    });
    if (dispatch.status !== "dispatched" || dispatch.assignment === undefined) {
      return blocked(dispatch.reason ?? "Implementation is not dispatchable", {
        job: dispatch.job ?? job,
        dispatch,
      });
    }
    job = dispatch.job ?? job;
    assignment = dispatch.assignment;
  }
  if (assignment === undefined) {
    return blocked("Implementation assignment is missing", { job, dispatch });
  }

  const branch =
    options.branch ?? phaseResult?.head?.branch ?? defaultBranch(brief);
  let lease: BranchLease;
  try {
    lease = await options.coordinator.acquireBranchLease({
      repository: brief.identity.repository,
      branch,
      jobId: job.id,
      workerId: options.workerId,
      ttlMs: options.leaseTtlMs ?? 60_000,
    });
  } catch (error) {
    return blocked(
      `Implementation branch is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      { job, dispatch, assignment },
    );
  }

  let execution: PhaseExecutionResult | undefined;
  if (phaseResult === undefined && options.execution !== undefined) {
    execution = await executePhase({
      ...options.execution,
      assignment,
      branch,
    });
    phaseResult = execution.phaseResult;
    if (phaseResult.head?.branch !== branch) {
      phaseResult = {
        ...phaseResult,
        outcome: "failed",
        head: { branch, sha: phaseResult.head?.sha ?? brief.base.sha },
        commits: [],
        summary: "Implementation returned a head on a different branch",
        evidence: [
          ...phaseResult.evidence,
          "Implementation branch did not match the coordinator lease.",
        ],
      };
    }
    await options.coordinator.recordPhaseResult({
      jobId: job.id,
      result: phaseResult,
      lease,
    });
    job = (await options.coordinator.getJob(job.id)) ?? job;
  }

  if (phaseResult === undefined) {
    return {
      outcome: "dispatched",
      job,
      dispatch,
      assignment,
      lease,
      readyForReview: false,
    };
  }
  if (phaseResult.outcome !== "completed") {
    return {
      outcome: resultOutcome(phaseResult),
      reason:
        phaseResult.questions[0] ??
        phaseResult.summary ??
        "Implementation did not complete",
      job,
      dispatch,
      assignment,
      lease,
      phaseResult,
      execution,
      readyForReview: false,
    };
  }
  if (
    options.issueNumber === undefined ||
    !Number.isInteger(options.issueNumber)
  ) {
    return blocked(
      "A numeric source issue is required for draft PR publication",
      {
        job,
        dispatch,
        assignment,
        lease,
        phaseResult,
        execution,
      },
    );
  }
  if (phaseResult.head === undefined || phaseResult.head.branch !== branch) {
    return blocked(
      "Implementation candidate is not bound to the leased branch",
      {
        job,
        dispatch,
        assignment,
        lease,
        phaseResult,
        execution,
      },
    );
  }
  if (options.readCurrent !== undefined) {
    let current: CurrentImplementationCandidate;
    try {
      current = await options.readCurrent();
    } catch (error) {
      return blocked(
        `Could not validate the current candidate before publication: ${error instanceof Error ? error.message : String(error)}`,
        { job, dispatch, assignment, lease, phaseResult, execution },
      );
    }
    if (
      !sameRevision(current.base, brief.base) ||
      current.briefHash !== brief.hash
    ) {
      return blocked(
        "The implementation candidate became stale before publication",
        {
          job,
          dispatch,
          assignment,
          lease,
          phaseResult,
          execution,
        },
      );
    }
  }

  const evidenceIssue = readinessReason(brief, phaseResult);
  const checkIssue = checkReadiness(policy, phaseResult);
  const readinessIssue = evidenceIssue ?? checkIssue;
  const publicationChecks: GitHubPublicationResult<unknown>[] = [];
  const branchPublication = await options.publication.publishBranch({
    jobId: job.id,
    lease,
    branch,
    headSha: phaseResult.head.sha,
  });
  if (branchPublication.remote === undefined) {
    return blocked("Issue branch publication is still in flight", {
      job,
      dispatch,
      assignment,
      lease,
      phaseResult,
      execution,
      publication: { checks: publicationChecks, branch: branchPublication },
    });
  }
  if (branchPublication.remote.headSha !== phaseResult.head.sha) {
    return blocked("A pre-existing branch points at a different head", {
      job,
      dispatch,
      assignment,
      lease,
      phaseResult,
      execution,
      publication: { checks: publicationChecks, branch: branchPublication },
    });
  }
  const briefPublication = await options.publication.publishBrief({
    jobId: job.id,
    lease,
    issueNumber: options.issueNumber,
    brief,
  });
  const pullRequest = await options.publication.publishPullRequest({
    jobId: job.id,
    lease,
    title: implementationTitle(brief),
    body: publicPrBody(brief, phaseResult, readinessIssue, policy),
    branch,
    baseBranch: policy.baseBranch,
    headSha: phaseResult.head.sha,
    draft: true,
    metadata: {
      version: 1,
      repository: brief.identity.repository,
      itemId: brief.identity.itemId,
      kind: brief.identity.kind,
      briefRevision: brief.revision,
      briefHash: brief.hash,
      baseBranch: policy.baseBranch,
      baseSha: brief.base.sha,
      branch,
      headSha: phaseResult.head.sha,
    },
  });
  if (pullRequest.remote === undefined) {
    return blocked("Draft pull request publication is still in flight", {
      job,
      dispatch,
      assignment,
      lease,
      phaseResult,
      execution,
      publication: {
        brief: briefPublication as GitHubPublicationResult<unknown>,
        checks: publicationChecks,
        branch: branchPublication,
        pullRequest,
      },
    });
  }
  if (
    pullRequest.remote.headSha !== phaseResult.head.sha ||
    pullRequest.remote.branch !== branch ||
    pullRequest.remote.baseBranch !== policy.baseBranch
  ) {
    return blocked("An existing pull request has a different candidate", {
      job,
      dispatch,
      assignment,
      lease,
      phaseResult,
      execution,
      publication: {
        brief: briefPublication as GitHubPublicationResult<unknown>,
        checks: publicationChecks,
        branch: branchPublication,
        pullRequest,
      },
    });
  }
  for (const check of phaseResult.checks) {
    const published = await options.publication.publishCheck({
      jobId: job.id,
      lease,
      branch,
      name: check.name,
      headSha: phaseResult.head.sha,
      status: "completed",
      conclusion: checkConclusion(check),
      summary: checkSummary(check),
    });
    publicationChecks.push(published as GitHubPublicationResult<unknown>);
  }
  const publication = {
    brief: briefPublication as GitHubPublicationResult<unknown>,
    checks: publicationChecks,
    branch: branchPublication,
    pullRequest,
  };
  let nextDispatch: DispatchIntent | undefined;
  if (readinessIssue === undefined) {
    const reviewCandidate = prepareIndependentReview({
      brief,
      policy,
      base: brief.base,
      head: phaseResult.head,
      checks: phaseResult.checks,
    });
    if (reviewCandidate.status === "blocked") {
      return blocked(reviewCandidate.reasons.join("; "), {
        job,
        dispatch,
        assignment,
        lease,
        phaseResult,
        execution,
        publication,
      });
    }
    const review = await options.coordinator.schedulePhase({
      jobId: job.id,
      phase: "review",
      relevantRevision: phaseResult.head.sha,
      head: phaseResult.head,
    });
    if (review.status === "blocked") {
      return blocked(
        review.reason ?? "Independent review could not be queued",
        {
          job: review.job,
          dispatch,
          assignment,
          lease,
          phaseResult,
          execution,
          publication,
        },
      );
    }
    nextDispatch = review.dispatch;
  }
  return {
    outcome: readinessIssue === undefined ? "completed" : "blocked",
    reason: readinessIssue,
    job,
    dispatch,
    assignment,
    lease,
    phaseResult,
    execution,
    publication,
    pullRequest: pullRequest.remote,
    nextPhase: readinessIssue === undefined ? "review" : undefined,
    nextDispatch,
    readyForReview: readinessIssue === undefined,
  };
};

export type { ExecutePhaseOptions, PhaseExecutionResult };
