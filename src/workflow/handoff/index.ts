import {
  isAuthorizationAllowed,
  parseRepositoryPolicy,
  parseWorkBrief,
  type CheckEvidence,
  type Finding,
  type RepositoryPolicy,
  type RevisionReference,
  type ReviewAxis,
  type ReviewEvidence,
  type WorkBrief,
} from "../contracts/index.js";
import type { WorkflowJob } from "../coordinator/index.js";
import { sameRevision } from "../shared.js";

export interface HandoffCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly briefHash: string;
}

export interface BranchProtectionState {
  readonly enforced: boolean;
  readonly humanApprovalRequired: boolean;
  /** Fresh provider evidence; caller-supplied booleans alone are not a merge gate. */
  readonly provider: "github";
  readonly verifiedAt: string;
}

export interface HumanApproval {
  readonly actor: string;
  readonly actorRole: "owner" | "maintainer";
  readonly approvedAt: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly briefHash: string;
}

export interface HandoffReadinessInput {
  readonly job: WorkflowJob;
  readonly candidate: HandoffCandidate;
  readonly checks: readonly CheckEvidence[];
  readonly review: ReviewEvidence;
  readonly requiredAxes?: readonly ReviewAxis[];
  readonly branchProtection?: BranchProtectionState;
  readonly humanApproval?: HumanApproval;
  readonly now?: () => string;
  readonly freshnessWindowSeconds?: number;
}

export interface HandoffPacket {
  readonly sourceIssue: string;
  readonly pullRequest?: string;
  readonly candidate: HandoffCandidate;
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly change: string;
  readonly risk: WorkBrief["risk"];
  readonly acceptanceCriteria: readonly string[];
  readonly acceptanceEvidence: readonly string[];
  readonly checks: readonly CheckEvidence[];
  readonly reviewAxes: readonly ReviewAxis[];
  readonly findings: readonly Finding[];
  readonly limitations: readonly string[];
}

export type HandoffOutcome =
  | "blocked"
  | "ready-for-review"
  | "review-requested"
  /** Retained for source-item triage; PR handoff uses ready-for-review. */
  | "ready-for-human"
  | "repair-needed"
  | "rejected"
  | "abandoned"
  | "merge-ready"
  | "merged"
  | "open";

export interface HandoffReadinessResult {
  readonly outcome:
    | "blocked"
    | "ready-for-review"
    | "review-requested"
    | "merge-ready";
  readonly readyForReview: boolean;
  readonly reviewRequested: boolean;
  readonly readyForHuman: boolean;
  readonly mergeReady: boolean;
  readonly reasons: readonly string[];
  readonly packet: HandoffPacket;
}

export interface HumanHandoffPublisher {
  requestReview(input: {
    readonly packet: HandoffPacket;
    readonly pullRequestNumber: number;
  }): Promise<void>;
}

export interface PrepareHandoffOptions extends HandoffReadinessInput {
  readonly sourceIssueNumber: number;
  readonly pullRequestNumber: number;
  readonly publisher?: HumanHandoffPublisher;
  readonly readCurrent?: () => Promise<HandoffCandidate>;
}

export interface HumanReviewDecisionInput {
  readonly decision:
    | "approved"
    | "changes-requested"
    | "rejected"
    | "abandoned";
  readonly reason?: string;
}

export interface HumanReviewDecision {
  readonly outcome: Extract<
    HandoffOutcome,
    "merge-ready" | "repair-needed" | "rejected" | "abandoned"
  >;
  readonly reason?: string;
}

export interface HumanReviewRoundTripOptions {
  readonly candidate: HandoffCandidate;
  readonly pullRequestNumber: number;
  readonly decision: HumanReviewDecisionInput;
  /** Re-reads the PR head and brief before applying the human decision. */
  readonly readCurrent: () => Promise<HandoffCandidate>;
  /** Keeps a requested-changes repair on the existing PR branch. */
  readonly requestRepair: (input: {
    readonly candidate: HandoffCandidate;
    readonly pullRequestNumber: number;
    readonly reason: string;
  }) => Promise<void>;
}

export interface HumanReviewRoundTripResult {
  readonly outcome:
    | "blocked"
    | Extract<
        HandoffOutcome,
        "merge-ready" | "repair-needed" | "rejected" | "abandoned"
      >;
  readonly reason?: string;
  readonly candidate: HandoffCandidate;
  readonly pullRequestNumber: number;
}

export interface MergeTransport {
  mergeProtected(input: {
    readonly pullRequestNumber: number;
    readonly headSha: string;
    readonly baseBranch: string;
  }): Promise<{ readonly mergedSha: string }>;
}

export interface MergeCandidateOptions extends Omit<
  HandoffReadinessInput,
  "branchProtection"
> {
  readonly pullRequestNumber: number;
  readonly humanApproval: HumanApproval;
  /** Re-reads the PR, branch and brief identity immediately before merging. */
  readonly readCurrent: () => Promise<HandoffCandidate>;
  /** Fetches fresh provider evidence immediately before a protected merge. */
  readonly readBranchProtection: () => Promise<BranchProtectionState>;
  readonly transport: MergeTransport;
}

export interface MergeResult {
  readonly outcome: "blocked" | "merged";
  readonly reason?: string;
  readonly mergedSha?: string;
}

export interface CompletionInput {
  readonly policy: RepositoryPolicy;
  readonly mergedSha: string;
  readonly candidate: HandoffCandidate;
  readonly checks: readonly CheckEvidence[];
}

export interface CompletionResult {
  readonly outcome: "completed" | "open";
  readonly reason?: string;
  readonly mergedSha: string;
  readonly checks: readonly CheckEvidence[];
}

export interface SourceIssueCloser {
  closeIssue(input: {
    readonly issueNumber: number;
    readonly mergedSha: string;
    readonly checks: readonly CheckEvidence[];
  }): Promise<void>;
}

export interface CloseSourceIssueOptions extends CompletionInput {
  readonly sourceIssueNumber: number;
  readonly closer: SourceIssueCloser;
}

export interface SourceIssueClosureResult extends CompletionResult {
  readonly closed: boolean;
}

const defaultAxes: readonly ReviewAxis[] = ["standards", "spec"];

const isFreshTimestamp = (
  value: string,
  now: string,
  freshnessWindowSeconds: number,
): boolean => {
  const timestamp = Date.parse(value);
  const current = Date.parse(now);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(current) &&
    timestamp <= current &&
    current - timestamp <= freshnessWindowSeconds * 1000
  );
};

const requiredChecks = (policy: RepositoryPolicy): readonly string[] =>
  policy.checks.filter((check) => check.required).map((check) => check.name);

const blockingFinding = (finding: Finding): boolean =>
  finding.severity !== "info" &&
  (finding.disposition === "open" || finding.disposition === "deferred");

const implementationEvidence = (
  job: WorkflowJob,
  candidate: HandoffCandidate,
): readonly string[] =>
  [...job.phaseResults]
    .reverse()
    .find(
      (result) =>
        result.outcome === "completed" &&
        (result.phase === "implementation" || result.phase === "repair") &&
        result.base !== undefined &&
        result.head !== undefined &&
        sameRevision(result.base, candidate.base) &&
        sameRevision(result.head, candidate.head) &&
        result.briefHash === candidate.briefHash,
    )?.evidence ?? [];

const allRequiredChecksPassed = (
  policy: RepositoryPolicy,
  checks: readonly CheckEvidence[],
  expected?: {
    readonly baseSha?: string;
    readonly headSha: string;
    readonly briefHash?: string;
  },
): string[] => {
  const reasons: string[] = [];
  for (const name of requiredChecks(policy)) {
    const named = checks.filter((candidate) => candidate.name === name);
    if (named.length === 0) {
      reasons.push(`Required check is missing: ${name}`);
      continue;
    }
    const check =
      expected === undefined
        ? named[0]
        : named.find(
            (candidate) =>
              candidate.headSha === expected.headSha &&
              (expected.baseSha === undefined ||
                candidate.baseSha === expected.baseSha) &&
              (expected.briefHash === undefined ||
                candidate.briefHash === expected.briefHash),
          );
    if (check === undefined) {
      reasons.push(
        `Required check is stale for the current candidate: ${name}`,
      );
    } else if (check.status !== "passed") {
      reasons.push(`Required check ${name} is ${check.status}`);
    }
  }
  return reasons;
};

const candidateReasons = (
  job: WorkflowJob,
  candidate: HandoffCandidate,
  review: ReviewEvidence,
  requiredAxes: readonly ReviewAxis[],
): string[] => {
  const reasons: string[] = [];
  let brief: WorkBrief;
  try {
    brief = parseWorkBrief(job.brief);
  } catch {
    return ["Workflow brief is malformed"];
  }
  if (brief.identity.kind !== "executable-issue") {
    reasons.push("Only executable issues may reach human PR handoff");
  }
  if (!isAuthorizationAllowed(brief, job.policy)) {
    reasons.push("Implementation authorization is not approved");
  }
  if (brief.identity.repository !== job.policy.repository) {
    reasons.push("Workflow policy repository does not match the brief");
  }
  if (job.control !== "active") reasons.push(`Workflow job is ${job.control}`);
  if (!sameRevision(brief.base, candidate.base)) {
    reasons.push("Candidate base does not match the brief base");
  }
  if (review.baseSha !== candidate.base.sha) {
    reasons.push("Review evidence is bound to a different base revision");
  }
  if (review.headSha !== candidate.head.sha) {
    reasons.push("Review evidence is bound to a different candidate head");
  }
  if (
    review.briefHash !== candidate.briefHash ||
    review.briefHash !== brief.hash
  ) {
    reasons.push("Review evidence is bound to a different brief revision");
  }
  const implementationHead = [...job.phaseResults]
    .reverse()
    .find(
      (result) =>
        result.phase === "implementation" || result.phase === "repair",
    )?.head;
  if (
    implementationHead !== undefined &&
    !sameRevision(implementationHead, candidate.head)
  ) {
    reasons.push("Candidate head does not match the implementation result");
  }
  if (review.outcome !== "passed") {
    reasons.push(`Independent review outcome is ${review.outcome}`);
  }
  if (
    implementationEvidence(job, candidate).length <
    brief.acceptanceCriteria.length
  ) {
    reasons.push("Implementation acceptance evidence is missing");
  }
  for (const axis of requiredAxes) {
    if (!review.axes.includes(axis))
      reasons.push(`Review axis is missing: ${axis}`);
  }
  for (const finding of review.findings) {
    if (blockingFinding(finding)) {
      reasons.push(`Blocking finding remains: ${finding.id}`);
    }
  }
  return reasons;
};

const packetFor = (
  input: HandoffReadinessInput,
  brief: WorkBrief,
): HandoffPacket => ({
  sourceIssue: `#${brief.identity.itemId}`,
  candidate: input.candidate,
  briefRevision: brief.revision,
  briefHash: brief.hash,
  change: brief.problem,
  risk: brief.risk,
  acceptanceCriteria: brief.acceptanceCriteria,
  acceptanceEvidence: implementationEvidence(input.job, input.candidate),
  checks: input.checks,
  reviewAxes: input.review.axes,
  findings: input.review.findings,
  limitations: [
    ...brief.exclusions,
    ...brief.unresolvedQuestions.map((question) => `Unresolved: ${question}`),
  ],
});

const approvalMatches = (
  candidate: HandoffCandidate,
  brief: WorkBrief,
  policy: RepositoryPolicy,
  approval: HumanApproval | undefined,
): boolean =>
  approval !== undefined &&
  approval.actor.trim().length > 0 &&
  approval.approvedAt.trim().length > 0 &&
  policy.authorization.allowedActors.includes(approval.actorRole) &&
  approval.baseSha === candidate.base.sha &&
  approval.headSha === candidate.head.sha &&
  approval.briefHash === brief.hash;

export const evaluateHandoffReadiness = (
  input: HandoffReadinessInput,
): HandoffReadinessResult => {
  const brief = parseWorkBrief(input.job.brief);
  const policy = parseRepositoryPolicy(input.job.policy);
  const requiredAxes = [
    ...new Set([...defaultAxes, ...(input.requiredAxes ?? [])]),
  ] as ReviewAxis[];
  const reasons = [
    ...candidateReasons(input.job, input.candidate, input.review, requiredAxes),
    ...allRequiredChecksPassed(policy, input.checks, {
      baseSha: input.candidate.base.sha,
      headSha: input.candidate.head.sha,
      briefHash: input.candidate.briefHash,
    }),
  ];
  const packet: HandoffPacket = {
    ...packetFor(input, brief),
    pullRequest: undefined,
  };
  const readyForHuman = reasons.length === 0;
  const protection = input.branchProtection;
  const freshnessWindowSeconds = input.freshnessWindowSeconds ?? 300;
  const freshMergeEvidence =
    Number.isFinite(freshnessWindowSeconds) &&
    freshnessWindowSeconds > 0 &&
    protection?.provider === "github" &&
    isFreshTimestamp(
      protection.verifiedAt,
      input.now?.() ?? new Date().toISOString(),
      freshnessWindowSeconds,
    ) &&
    input.humanApproval !== undefined &&
    isFreshTimestamp(
      input.humanApproval.approvedAt,
      input.now?.() ?? new Date().toISOString(),
      freshnessWindowSeconds,
    );
  const mergeReady =
    readyForHuman &&
    protection?.enforced === true &&
    protection.humanApprovalRequired === true &&
    freshMergeEvidence &&
    approvalMatches(input.candidate, brief, policy, input.humanApproval);
  if (!readyForHuman) {
    return {
      outcome: "blocked",
      readyForReview: false,
      reviewRequested: false,
      readyForHuman: false,
      mergeReady: false,
      reasons,
      packet,
    };
  }
  return {
    outcome: mergeReady ? "merge-ready" : "ready-for-review",
    readyForReview: true,
    reviewRequested: false,
    readyForHuman: true,
    mergeReady,
    reasons,
    packet,
  };
};

export const prepareHumanHandoff = async (
  input: PrepareHandoffOptions,
): Promise<HandoffReadinessResult> => {
  if (input.readCurrent !== undefined) {
    let current: HandoffCandidate;
    try {
      current = await input.readCurrent();
    } catch (error) {
      const brief = parseWorkBrief(input.job.brief);
      return {
        outcome: "blocked",
        readyForReview: false,
        reviewRequested: false,
        readyForHuman: false,
        mergeReady: false,
        reasons: [
          `Could not validate the current candidate: ${error instanceof Error ? error.message : String(error)}`,
        ],
        packet: {
          ...packetFor(input, brief),
          pullRequest: `#${input.pullRequestNumber}`,
        },
      };
    }
    if (
      !sameRevision(current.base, input.candidate.base) ||
      !sameRevision(current.head, input.candidate.head) ||
      current.briefHash !== input.candidate.briefHash
    ) {
      const brief = parseWorkBrief(input.job.brief);
      return {
        outcome: "blocked",
        readyForReview: false,
        reviewRequested: false,
        readyForHuman: false,
        mergeReady: false,
        reasons: ["Candidate changed before human handoff"],
        packet: {
          ...packetFor(input, brief),
          pullRequest: `#${input.pullRequestNumber}`,
        },
      };
    }
  }
  const readiness = evaluateHandoffReadiness(input);
  const packet = {
    ...readiness.packet,
    pullRequest: `#${input.pullRequestNumber}`,
  };
  let result: HandoffReadinessResult = { ...readiness, packet };
  if (result.readyForHuman && input.publisher !== undefined) {
    try {
      await input.publisher.requestReview({
        packet,
        pullRequestNumber: input.pullRequestNumber,
      });
      result = {
        ...result,
        outcome: "review-requested",
        reviewRequested: true,
      };
    } catch (error) {
      result = {
        ...result,
        outcome: "blocked",
        readyForReview: false,
        reviewRequested: false,
        readyForHuman: false,
        reasons: [
          `Could not request human review: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }
  return result;
};

export const resolveHumanReviewDecision = (
  input: HumanReviewDecisionInput,
): HumanReviewDecision => {
  switch (input.decision) {
    case "approved":
      return { outcome: "merge-ready", reason: input.reason };
    case "changes-requested":
      return {
        outcome: "repair-needed",
        reason: input.reason ?? "Human review requested changes",
      };
    case "rejected":
      return {
        outcome: "rejected",
        reason: input.reason ?? "Human review rejected the candidate",
      };
    case "abandoned":
      return {
        outcome: "abandoned",
        reason: input.reason ?? "Pull request was abandoned",
      };
  }
};

export const processHumanReviewDecision = async (
  input: HumanReviewRoundTripOptions,
): Promise<HumanReviewRoundTripResult> => {
  let current: HandoffCandidate;
  try {
    current = await input.readCurrent();
  } catch (error) {
    return {
      outcome: "blocked",
      reason: `Could not validate the current candidate: ${error instanceof Error ? error.message : String(error)}`,
      candidate: input.candidate,
      pullRequestNumber: input.pullRequestNumber,
    };
  }
  if (
    !sameRevision(current.base, input.candidate.base) ||
    !sameRevision(current.head, input.candidate.head) ||
    current.briefHash !== input.candidate.briefHash
  ) {
    return {
      outcome: "blocked",
      reason: "Human review decision is stale for the current candidate",
      candidate: input.candidate,
      pullRequestNumber: input.pullRequestNumber,
    };
  }

  const decision = resolveHumanReviewDecision(input.decision);
  if (decision.outcome === "repair-needed") {
    try {
      await input.requestRepair({
        candidate: input.candidate,
        pullRequestNumber: input.pullRequestNumber,
        reason: decision.reason ?? "Human review requested changes",
      });
    } catch (error) {
      return {
        outcome: "blocked",
        reason: `Could not schedule the requested repair: ${error instanceof Error ? error.message : String(error)}`,
        candidate: input.candidate,
        pullRequestNumber: input.pullRequestNumber,
      };
    }
  }
  return {
    ...decision,
    candidate: input.candidate,
    pullRequestNumber: input.pullRequestNumber,
  };
};

export const mergeProtectedCandidate = async (
  input: MergeCandidateOptions,
): Promise<MergeResult> => {
  const brief = parseWorkBrief(input.job.brief);
  const policy = parseRepositoryPolicy(input.job.policy);
  let current: HandoffCandidate;
  try {
    current = await input.readCurrent();
  } catch (error) {
    return {
      outcome: "blocked",
      reason: `Could not validate the current candidate: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (
    !sameRevision(current.base, input.candidate.base) ||
    !sameRevision(current.head, input.candidate.head) ||
    current.briefHash !== input.candidate.briefHash
  ) {
    return {
      outcome: "blocked",
      reason: "current candidate changed before protected merge",
    };
  }
  const freshnessWindowSeconds = input.freshnessWindowSeconds ?? 300;
  if (!Number.isFinite(freshnessWindowSeconds) || freshnessWindowSeconds <= 0) {
    return {
      outcome: "blocked",
      reason: "Freshness window must be a positive number of seconds",
    };
  }
  let branchProtection: BranchProtectionState;
  try {
    branchProtection = await input.readBranchProtection();
  } catch (error) {
    return {
      outcome: "blocked",
      reason: `Could not verify branch protection: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const readiness = evaluateHandoffReadiness({
    ...input,
    branchProtection,
  });
  if (!readiness.readyForHuman) {
    return { outcome: "blocked", reason: readiness.reasons.join("; ") };
  }
  if (!branchProtection.enforced) {
    return {
      outcome: "blocked",
      reason: "Branch protection is not proven enforced",
    };
  }
  if (!branchProtection.humanApprovalRequired) {
    return {
      outcome: "blocked",
      reason: "Human approval gate is not configured",
    };
  }
  if (
    branchProtection.provider !== "github" ||
    !isFreshTimestamp(
      branchProtection.verifiedAt,
      input.now?.() ?? new Date().toISOString(),
      freshnessWindowSeconds,
    )
  ) {
    return {
      outcome: "blocked",
      reason: "Branch protection evidence is not freshly verified",
    };
  }
  if (
    !isFreshTimestamp(
      input.humanApproval.approvedAt,
      input.now?.() ?? new Date().toISOString(),
      freshnessWindowSeconds,
    )
  ) {
    return {
      outcome: "blocked",
      reason: "Human approval evidence is not fresh",
    };
  }
  if (!approvalMatches(input.candidate, brief, policy, input.humanApproval)) {
    return {
      outcome: "blocked",
      reason: "Human approval does not match the exact candidate",
    };
  }
  try {
    const merged = await input.transport.mergeProtected({
      pullRequestNumber: input.pullRequestNumber,
      headSha: input.candidate.head.sha,
      baseBranch: policy.baseBranch,
    });
    return { outcome: "merged", mergedSha: merged.mergedSha };
  } catch (error) {
    return {
      outcome: "blocked",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
};

export const completeSourceIssue = (
  input: CompletionInput,
): CompletionResult => {
  const policy = parseRepositoryPolicy(input.policy);
  if (input.mergedSha.trim().length === 0) {
    return {
      outcome: "open",
      reason: "Merged revision is missing",
      mergedSha: input.mergedSha,
      checks: input.checks,
    };
  }
  if (policy.issueClosure !== "merge-and-ci") {
    return {
      outcome: "open",
      reason: "Source issue remains open until release verification",
      mergedSha: input.mergedSha,
      checks: input.checks,
    };
  }
  const checkReasons = allRequiredChecksPassed(policy, input.checks, {
    headSha: input.mergedSha,
  });
  if (checkReasons.length > 0) {
    return {
      outcome: "open",
      reason: checkReasons.join("; "),
      mergedSha: input.mergedSha,
      checks: input.checks,
    };
  }
  return {
    outcome: "completed",
    mergedSha: input.mergedSha,
    checks: input.checks,
  };
};

export const closeSourceIssue = async (
  input: CloseSourceIssueOptions,
): Promise<SourceIssueClosureResult> => {
  const completion = completeSourceIssue(input);
  if (completion.outcome === "open") {
    return { ...completion, closed: false };
  }
  try {
    await input.closer.closeIssue({
      issueNumber: input.sourceIssueNumber,
      mergedSha: input.mergedSha,
      checks: input.checks,
    });
    return { ...completion, closed: true };
  } catch (error) {
    return {
      ...completion,
      outcome: "open",
      closed: false,
      reason: `Could not close source issue: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
