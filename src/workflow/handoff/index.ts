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

export interface CandidateEvidenceInvalidationInput {
  readonly candidate: HandoffCandidate;
  readonly checks: readonly CheckEvidence[];
  readonly review?: ReviewEvidence;
  readonly reason: string;
}

export interface CandidateEvidenceInvalidationResult {
  readonly candidate: HandoffCandidate;
  readonly checks: readonly CheckEvidence[];
  readonly review?: ReviewEvidence;
  readonly invalidated: true;
  readonly reason: string;
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
  readonly readCurrent: () => Promise<HandoffCandidate>;
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

export interface PublishedStandaloneCandidate {
  readonly branch: string;
  readonly headSha: string;
  readonly pullRequestNumber: number;
  readonly state: "open" | "closed";
}

export interface StandaloneCompletionInput {
  readonly policy: RepositoryPolicy;
  readonly candidate: HandoffCandidate;
  readonly published: PublishedStandaloneCandidate;
  readonly commitSha: string;
  readonly checks: readonly CheckEvidence[];
  /** The worker/coordinator cleanup self-check completed successfully. */
  readonly cleanupCompleted: boolean;
}

export interface StandaloneCompletionResult {
  readonly outcome: "completed" | "open";
  readonly reason?: string;
  readonly commitSha: string;
  readonly pullRequestNumber: number;
  readonly checks: readonly CheckEvidence[];
}

export interface StandaloneSourceIssueCloser {
  closeIssue(input: {
    readonly issueNumber: number;
    readonly commitSha: string;
    readonly pullRequestNumber: number;
    readonly branch: string;
    readonly checks: readonly CheckEvidence[];
    /** Stable evidence text to retain on the source issue. */
    readonly comment: string;
  }): Promise<void>;
}

export interface CloseStandaloneSourceIssueOptions extends StandaloneCompletionInput {
  readonly sourceIssueNumber: number;
  readonly closer: StandaloneSourceIssueCloser;
}

export interface StandaloneSourceIssueClosureResult extends StandaloneCompletionResult {
  readonly closed: boolean;
}

export interface PlanningSpecIssueReference {
  readonly number: number;
  readonly kind: "child" | "repair";
  readonly state: "open" | "closed";
  readonly htmlUrl?: string;
}

export interface PlanningSpecBlocker {
  readonly id: string;
  readonly active: boolean;
  readonly reason?: string;
}

/** Candidate identity retained in the integration pull request metadata. */
export interface PlanningSpecCandidateMetadata {
  readonly repository: string;
  readonly itemId: string;
  readonly kind: "planning-spec";
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly headSha: string;
}

export interface PlanningSpecCandidate {
  readonly metadata: PlanningSpecCandidateMetadata;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl?: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly mergedSha?: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: string;
}

export interface PlanningSpecCompletionInput {
  readonly policy: RepositoryPolicy;
  readonly parentIssueNumber: number;
  readonly expected: PlanningSpecCandidateMetadata;
  readonly candidate: PlanningSpecCandidate;
  readonly checks: readonly CheckEvidence[];
  readonly originalChildren: readonly PlanningSpecIssueReference[];
  readonly repairChildren: readonly PlanningSpecIssueReference[];
  readonly blockers?: readonly PlanningSpecBlocker[];
}

export interface PlanningSpecCompletionResult {
  readonly outcome: "completed" | "open";
  readonly reason?: string;
  readonly mergedSha?: string;
  readonly candidate: PlanningSpecCandidate;
  readonly originalChildren: readonly PlanningSpecIssueReference[];
  readonly repairChildren: readonly PlanningSpecIssueReference[];
  readonly blockers: readonly PlanningSpecBlocker[];
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

const samePlanningSpecMetadata = (
  actual: PlanningSpecCandidateMetadata,
  expected: PlanningSpecCandidateMetadata,
): boolean =>
  actual.repository === expected.repository &&
  actual.itemId === expected.itemId &&
  actual.kind === expected.kind &&
  actual.briefRevision === expected.briefRevision &&
  actual.briefHash === expected.briefHash &&
  actual.baseBranch === expected.baseBranch &&
  actual.baseSha === expected.baseSha &&
  actual.branch === expected.branch &&
  actual.headSha === expected.headSha;

const planningSpecOpen = (
  input: PlanningSpecCompletionInput,
  reason: string,
  blockers: readonly PlanningSpecBlocker[],
): PlanningSpecCompletionResult => ({
  outcome: "open",
  reason,
  mergedSha: input.candidate.mergedSha,
  candidate: input.candidate,
  originalChildren: input.originalChildren,
  repairChildren: input.repairChildren,
  blockers,
});

const issueReferenceKey = (issue: PlanningSpecIssueReference): string =>
  String(issue.number);

/**
 * Reconcile aggregate planning-spec completion from current provider state.
 * This gate has no merge capability: a provider-reported manual merge is the
 * only transition that can satisfy the candidate portion of the contract.
 */
export const completePlanningSpec = (
  input: PlanningSpecCompletionInput,
): PlanningSpecCompletionResult => {
  const policy = parseRepositoryPolicy(input.policy);
  const blockers = [...(input.blockers ?? [])];
  const candidate = input.candidate;

  if (policy.repository !== input.expected.repository) {
    return planningSpecOpen(
      input,
      "Planning-spec policy repository does not match the exact PR metadata",
      blockers,
    );
  }
  if (String(input.parentIssueNumber) !== input.expected.itemId) {
    return planningSpecOpen(
      input,
      "Planning-spec parent does not match the exact PR metadata",
      blockers,
    );
  }
  if (!samePlanningSpecMetadata(candidate.metadata, input.expected)) {
    return planningSpecOpen(
      input,
      "Integration pull request metadata does not match the current planning spec",
      blockers,
    );
  }
  if (candidate.pullRequestNumber < 1) {
    return planningSpecOpen(
      input,
      "Integration pull request is invalid",
      blockers,
    );
  }
  if (
    candidate.branch !== candidate.metadata.branch ||
    candidate.headSha !== candidate.metadata.headSha ||
    candidate.baseBranch !== candidate.metadata.baseBranch
  ) {
    return planningSpecOpen(
      input,
      "Integration pull request candidate does not match its metadata",
      blockers,
    );
  }
  if (candidate.state !== "closed") {
    return planningSpecOpen(
      input,
      "Integration pull request is still open",
      blockers,
    );
  }
  if (!candidate.merged) {
    return planningSpecOpen(
      input,
      "Integration pull request closed without a merge",
      blockers,
    );
  }
  if (candidate.draft) {
    return planningSpecOpen(
      input,
      "Merged integration pull request was still a draft",
      blockers,
    );
  }
  const mergedSha = candidate.mergedSha?.trim();
  if (mergedSha === undefined || mergedSha.length === 0) {
    return planningSpecOpen(
      input,
      "Merged integration revision is missing",
      blockers,
    );
  }
  if (policy.issueClosure !== "merge-and-ci") {
    return planningSpecOpen(
      input,
      "Planning spec remains open until release verification",
      blockers,
    );
  }

  const issueReferences = [...input.originalChildren, ...input.repairChildren];
  if (input.originalChildren.length === 0) {
    return planningSpecOpen(
      input,
      "No original child issues are scoped to the planning spec",
      blockers,
    );
  }
  const issueIds = new Set<string>();
  for (const issue of issueReferences) {
    if (issue.number < 1 || issueIds.has(issueReferenceKey(issue))) {
      return planningSpecOpen(
        input,
        "Planning-spec child and repair scope is ambiguous",
        blockers,
      );
    }
    issueIds.add(issueReferenceKey(issue));
    if (issue.state !== "closed") {
      return planningSpecOpen(
        input,
        `${issue.kind === "repair" ? "Repair" : "Child"} issue #${issue.number} is still open`,
        blockers,
      );
    }
  }
  const activeBlocker = blockers.find((blocker) => blocker.active);
  if (activeBlocker !== undefined) {
    return planningSpecOpen(
      input,
      `Scoped blocker remains active: ${activeBlocker.id}${activeBlocker.reason === undefined ? "" : ` (${activeBlocker.reason})`}`,
      blockers,
    );
  }
  const checkReasons = allRequiredChecksPassed(policy, input.checks, {
    baseSha: candidate.metadata.baseSha,
    headSha: mergedSha,
    briefHash: candidate.metadata.briefHash,
  });
  if (checkReasons.length > 0) {
    return planningSpecOpen(input, checkReasons.join("; "), blockers);
  }
  return {
    outcome: "completed",
    mergedSha,
    candidate,
    originalChildren: input.originalChildren,
    repairChildren: input.repairChildren,
    blockers,
  };
};

const issueLink = (issue: PlanningSpecIssueReference): string =>
  issue.htmlUrl === undefined
    ? `#${issue.number}`
    : `[#${issue.number}](${issue.htmlUrl})`;

/** Concise, stable evidence for the single aggregate parent comment. */
export const formatPlanningSpecCompletionComment = (input: {
  readonly pullRequestNumber: number;
  readonly pullRequestUrl?: string;
  readonly mergedSha: string;
  readonly originalChildren: readonly PlanningSpecIssueReference[];
  readonly repairChildren: readonly PlanningSpecIssueReference[];
}): string => {
  const pullRequest =
    input.pullRequestUrl === undefined
      ? `#${input.pullRequestNumber}`
      : `[#${input.pullRequestNumber}](${input.pullRequestUrl})`;
  return [
    "Shipyard completed the planning-spec delivery.",
    `- Pull request: ${pullRequest}`,
    `- Merged revision: \`${input.mergedSha}\``,
    `- Child issues: ${input.originalChildren.map(issueLink).join(", ")}`,
    `- Repair issues: ${input.repairChildren.length === 0 ? "none" : input.repairChildren.map(issueLink).join(", ")}`,
  ].join("\n");
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

/** Invalidate candidate-bound evidence after a repair or pre-merge scope change. */
export const invalidateCandidateEvidence = (
  input: CandidateEvidenceInvalidationInput,
): CandidateEvidenceInvalidationResult => ({
  candidate: input.candidate,
  checks: input.checks.map((check) => ({
    ...check,
    status: "unknown",
    summary: `Invalidated: ${input.reason}`,
  })),
  review: undefined,
  invalidated: true,
  reason: input.reason,
});

export const prepareHumanHandoff = async (
  input: PrepareHandoffOptions,
): Promise<HandoffReadinessResult> => {
  const brief = parseWorkBrief(input.job.brief);
  const blockedForCurrentState = (reason: string): HandoffReadinessResult => {
    const invalidated = invalidateCandidateEvidence({
      candidate: input.candidate,
      checks: input.checks,
      review: input.review,
      reason,
    });
    const packet = packetFor({ ...input, checks: invalidated.checks }, brief);
    return {
      outcome: "blocked",
      readyForReview: false,
      reviewRequested: false,
      readyForHuman: false,
      mergeReady: false,
      reasons: [reason],
      packet: {
        ...packet,
        pullRequest: `#${input.pullRequestNumber}`,
        reviewAxes: [],
        findings: [],
        limitations: [...packet.limitations, reason],
      },
    };
  };

  if (input.readCurrent === undefined) {
    return blockedForCurrentState(
      "A provider current-state reader is required before human handoff",
    );
  }

  let current: HandoffCandidate;
  try {
    current = await input.readCurrent();
  } catch (error) {
    return blockedForCurrentState(
      `Could not validate the current candidate: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !sameRevision(current.base, input.candidate.base) ||
    !sameRevision(current.head, input.candidate.head) ||
    current.briefHash !== input.candidate.briefHash
  ) {
    return blockedForCurrentState("Candidate changed before human handoff");
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

const standaloneOpen = (
  input: StandaloneCompletionInput,
  reason: string,
): StandaloneCompletionResult => ({
  outcome: "open",
  reason,
  commitSha: input.commitSha,
  pullRequestNumber: input.published.pullRequestNumber,
  checks: input.checks,
});

/** Gate standalone issue closure on a remotely published, open PR candidate. */
export const completeStandaloneIssue = (
  input: StandaloneCompletionInput,
): StandaloneCompletionResult => {
  const policy = parseRepositoryPolicy(input.policy);
  if (input.commitSha.trim().length === 0) {
    return standaloneOpen(input, "Published commit is missing");
  }
  if (
    !Number.isInteger(input.published.pullRequestNumber) ||
    input.published.pullRequestNumber < 1
  ) {
    return standaloneOpen(input, "Published pull request is missing");
  }
  if (input.published.state !== "open") {
    return standaloneOpen(input, "Published pull request is not open");
  }
  if (
    input.published.branch !== input.candidate.head.branch ||
    input.published.headSha !== input.candidate.head.sha ||
    input.commitSha !== input.candidate.head.sha
  ) {
    return standaloneOpen(
      input,
      "Published pull request does not point at the current candidate",
    );
  }
  if (!input.cleanupCompleted) {
    return standaloneOpen(
      input,
      "Implementation cleanup/self-check is incomplete",
    );
  }
  const checkReasons = allRequiredChecksPassed(policy, input.checks, {
    baseSha: input.candidate.base.sha,
    headSha: input.candidate.head.sha,
    briefHash: input.candidate.briefHash,
  });
  if (checkReasons.length > 0) {
    return standaloneOpen(input, checkReasons.join("; "));
  }
  return {
    outcome: "completed",
    commitSha: input.commitSha,
    pullRequestNumber: input.published.pullRequestNumber,
    checks: input.checks,
  };
};

/** Close a standalone source issue with durable commit/PR evidence. */
export const closeStandaloneSourceIssue = async (
  input: CloseStandaloneSourceIssueOptions,
): Promise<StandaloneSourceIssueClosureResult> => {
  const completion = completeStandaloneIssue(input);
  if (completion.outcome === "open") {
    return { ...completion, closed: false };
  }
  const comment = [
    "Shipyard completed the standalone implementation.",
    `- Commit: \`${completion.commitSha}\``,
    `- Pull request: #${completion.pullRequestNumber}`,
    `- Branch: \`${input.published.branch}\``,
    "- Focused checks passed and cleanup/self-check completed.",
  ].join("\n");
  try {
    await input.closer.closeIssue({
      issueNumber: input.sourceIssueNumber,
      commitSha: completion.commitSha,
      pullRequestNumber: completion.pullRequestNumber,
      branch: input.published.branch,
      checks: completion.checks,
      comment,
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

export const completePublishedSourceIssue = completeStandaloneIssue;
export const closePublishedSourceIssue = closeStandaloneSourceIssue;
