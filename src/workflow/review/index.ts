import {
  parseRepositoryPolicy,
  parseWorkBrief,
  type Finding,
  type FindingSeverity,
  type RepositoryPolicy,
  type RevisionReference,
  type ReviewAxis,
  type ReviewEvidence,
  type WorkBrief,
} from "../contracts/index.js";

export type ReviewRunOutcome =
  | "passed"
  | "actionable-findings"
  | "incomplete"
  | "blocked"
  | "failed";

export interface ReviewCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly requiredAxes?: readonly ReviewAxis[];
}

export interface ReviewCheckout {
  readonly base: RevisionReference;
  readonly candidate: RevisionReference;
  readonly immutable: true;
}

export interface ReviewRequest {
  readonly candidate: ReviewCandidate;
  readonly checkout: ReviewCheckout;
  readonly signal: AbortSignal;
}

export interface ReviewFindingInput {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly axis: ReviewAxis;
  readonly title: string;
  readonly evidence: string;
  readonly location?: string;
  readonly requirement?: string;
  readonly verification?: string;
}

export interface ReviewResponse {
  readonly outcome?: ReviewRunOutcome;
  readonly axes: readonly ReviewAxis[];
  readonly findings: readonly ReviewFindingInput[];
  readonly evidence: readonly string[];
  readonly headSha: string;
  readonly baseSha?: string;
  readonly briefHash: string;
  /** Any returned commit or changed file means the reviewer violated read-only review. */
  readonly commits?: readonly string[];
  readonly changedFiles?: readonly string[];
}

export interface ReviewProvider {
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

export interface CurrentCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly briefHash: string;
}

export interface IndependentReviewOptions {
  readonly candidate: ReviewCandidate;
  readonly provider: ReviewProvider;
  readonly readCurrent?: () => Promise<CurrentCandidate>;
  readonly signal?: AbortSignal;
}

export interface ReviewFailure {
  readonly kind: "provider" | "malformed" | "stale-candidate" | "mutation";
  readonly message: string;
}

export interface IndependentReviewResult {
  readonly outcome: ReviewRunOutcome;
  readonly candidate: ReviewCandidate;
  readonly reviewAxes: readonly ReviewAxis[];
  readonly findings: readonly Finding[];
  readonly evidence: readonly string[];
  readonly reviewEvidence: ReviewEvidence;
  readonly failure?: ReviewFailure;
}

const defaultAxes: readonly ReviewAxis[] = ["standards", "spec"];
const validAxes: readonly ReviewAxis[] = ["standards", "spec", "interface"];
const validSeverities: readonly FindingSeverity[] = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
];
const nonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enumValue = <T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new Error(`${path} is invalid`);
  }
  return value as T;
};

const uniqueAxes = (
  values: readonly ReviewAxis[],
  path: string,
): ReviewAxis[] => {
  const axes = values.map((value, index) =>
    enumValue(value, validAxes, `${path}[${index}]`),
  );
  if (new Set(axes).size !== axes.length) {
    throw new Error(`${path} contains duplicate axes`);
  }
  return axes;
};

const sameRevision = (left: RevisionReference, right: RevisionReference) =>
  left.branch === right.branch && left.sha === right.sha;

const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};

const normalizeFinding = (
  value: ReviewFindingInput,
  index: number,
): Finding => ({
  id: nonEmpty(value.id, `findings[${index}].id`),
  severity: enumValue(
    value.severity,
    validSeverities,
    `findings[${index}].severity`,
  ),
  axis: enumValue(value.axis, validAxes, `findings[${index}].axis`),
  // A reviewer reports evidence. Only the repair/authorization workflow may
  // dispose of a finding after independent verification.
  disposition: "open",
  title: nonEmpty(value.title, `findings[${index}].title`),
  evidence: nonEmpty(value.evidence, `findings[${index}].evidence`),
  location:
    value.location === undefined
      ? undefined
      : nonEmpty(value.location, `findings[${index}].location`),
  requirement:
    value.requirement === undefined
      ? undefined
      : nonEmpty(value.requirement, `findings[${index}].requirement`),
  verification:
    value.verification === undefined
      ? undefined
      : nonEmpty(value.verification, `findings[${index}].verification`),
});

const findingKey = (finding: Finding): string =>
  JSON.stringify([
    finding.axis,
    finding.title,
    finding.location ?? "",
    finding.requirement ?? "",
    finding.evidence,
  ]);

const deduplicateFindings = (findings: readonly Finding[]): Finding[] => {
  const byKey = new Map<string, Finding>();
  const byId = new Map<string, string>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const previousKey = byId.get(finding.id);
    if (previousKey !== undefined && previousKey !== key) {
      throw new Error(`Finding id ${finding.id} identifies different findings`);
    }
    byId.set(finding.id, key);
    if (!byKey.has(key)) byKey.set(key, finding);
  }
  return [...byKey.values()];
};

const blockingFinding = (finding: Finding): boolean =>
  finding.severity !== "info" &&
  (finding.disposition === "open" || finding.disposition === "deferred");

const candidateIsStale = (
  expected: ReviewCandidate,
  current: CurrentCandidate,
): boolean =>
  !sameRevision(expected.base, current.base) ||
  !sameRevision(expected.head, current.head) ||
  expected.brief.hash !== current.briefHash;

const reviewEvidence = (
  candidate: ReviewCandidate,
  outcome: ReviewRunOutcome,
  axes: readonly ReviewAxis[],
  findings: readonly Finding[],
): ReviewEvidence => ({
  outcome,
  axes,
  findings,
  headSha: candidate.head.sha,
  baseSha: candidate.base.sha,
  briefHash: candidate.brief.hash,
});

const result = (input: {
  readonly candidate: ReviewCandidate;
  readonly outcome: ReviewRunOutcome;
  readonly axes: readonly ReviewAxis[];
  readonly findings?: readonly Finding[];
  readonly evidence?: readonly string[];
  readonly failure?: ReviewFailure;
}): IndependentReviewResult => {
  const findings = input.findings ?? [];
  return {
    outcome: input.outcome,
    candidate: input.candidate,
    reviewAxes: input.axes,
    findings,
    evidence: input.evidence ?? [],
    reviewEvidence: reviewEvidence(
      input.candidate,
      input.outcome,
      input.axes,
      findings,
    ),
    failure: input.failure,
  };
};

/** Run a read-only, candidate-bound review and normalize its evidence. */
export const runIndependentReview = async (
  options: IndependentReviewOptions,
): Promise<IndependentReviewResult> => {
  let candidate: ReviewCandidate;
  let requiredAxes: ReviewAxis[];
  try {
    const brief = parseWorkBrief(options.candidate.brief);
    const policy = parseRepositoryPolicy(options.candidate.policy);
    if (policy.repository !== brief.identity.repository) {
      throw new Error("Review policy repository does not match the brief");
    }
    if (!sameRevision(brief.base, options.candidate.base)) {
      throw new Error("Review base does not match the brief base");
    }
    candidate = deepFreeze({
      ...options.candidate,
      brief,
      policy,
    });
    requiredAxes = uniqueAxes(
      [...defaultAxes, ...(options.candidate.requiredAxes ?? [])],
      "requiredAxes",
    );
    if (requiredAxes.length === 0)
      throw new Error("requiredAxes cannot be empty");
  } catch (error) {
    const fallback = options.candidate;
    return result({
      candidate: fallback,
      outcome: "failed",
      axes: [],
      failure: { kind: "malformed", message: errorMessage(error) },
    });
  }

  if (options.readCurrent) {
    try {
      const current = await options.readCurrent();
      if (candidateIsStale(candidate, current)) {
        return result({
          candidate,
          outcome: "blocked",
          axes: [],
          failure: {
            kind: "stale-candidate",
            message: "Review candidate changed before the reviewer started",
          },
        });
      }
    } catch (error) {
      return result({
        candidate,
        outcome: "blocked",
        axes: [],
        failure: {
          kind: "stale-candidate",
          message: `Could not validate the current candidate: ${errorMessage(error)}`,
        },
      });
    }
  }

  let response: ReviewResponse;
  try {
    response = await options.provider.review(
      deepFreeze({
        candidate,
        checkout: {
          base: candidate.base,
          candidate: candidate.head,
          immutable: true,
        },
        signal: options.signal ?? new AbortController().signal,
      }),
    );
  } catch (error) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      failure: { kind: "provider", message: errorMessage(error) },
    });
  }

  if (!isRecord(response)) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      failure: {
        kind: "malformed",
        message: "Review provider returned a non-object result",
      },
    });
  }
  const responseEvidence = Array.isArray(response.evidence)
    ? response.evidence
    : [];
  const validOutcomes: readonly ReviewRunOutcome[] = [
    "passed",
    "actionable-findings",
    "incomplete",
    "blocked",
    "failed",
  ];
  if (
    response.outcome !== undefined &&
    !validOutcomes.includes(response.outcome)
  ) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      evidence: responseEvidence,
      failure: { kind: "malformed", message: "Review outcome is invalid" },
    });
  }
  if (
    (response.commits !== undefined && !Array.isArray(response.commits)) ||
    (response.changedFiles !== undefined &&
      !Array.isArray(response.changedFiles))
  ) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      evidence: responseEvidence,
      failure: {
        kind: "malformed",
        message: "Review mutation fields must be arrays",
      },
    });
  }
  if (
    (response.commits?.length ?? 0) > 0 ||
    (response.changedFiles?.length ?? 0) > 0
  ) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      evidence: responseEvidence,
      failure: {
        kind: "mutation",
        message:
          "Reviewer returned candidate changes; review must be read-only",
      },
    });
  }

  let axes: ReviewAxis[];
  let findings: Finding[];
  try {
    axes = uniqueAxes(response.axes, "axes");
    if (
      typeof response.headSha !== "string" ||
      response.headSha !== candidate.head.sha
    ) {
      throw new Error("Review evidence is bound to a different candidate head");
    }
    if (
      response.baseSha !== undefined &&
      (typeof response.baseSha !== "string" ||
        response.baseSha !== candidate.base.sha)
    ) {
      throw new Error("Review evidence is bound to a different base revision");
    }
    if (
      typeof response.briefHash !== "string" ||
      response.briefHash !== candidate.brief.hash
    ) {
      throw new Error("Review evidence is bound to a different brief revision");
    }
    if (!Array.isArray(response.findings)) {
      throw new Error("Review findings must be an array");
    }
    findings = deduplicateFindings(
      response.findings.map((finding, index) =>
        normalizeFinding(finding, index),
      ),
    );
  } catch (error) {
    return result({
      candidate,
      outcome: "failed",
      axes: [],
      evidence: responseEvidence,
      failure: { kind: "malformed", message: errorMessage(error) },
    });
  }

  const missingAxes = requiredAxes.filter((axis) => !axes.includes(axis));
  if (missingAxes.length > 0) {
    return result({
      candidate,
      outcome: "incomplete",
      axes,
      findings,
      evidence: response.evidence,
      failure: {
        kind: "malformed",
        message: `Review did not complete required axes: ${missingAxes.join(", ")}`,
      },
    });
  }

  if (options.readCurrent) {
    let current: CurrentCandidate;
    try {
      current = await options.readCurrent();
    } catch (error) {
      return result({
        candidate,
        outcome: "blocked",
        axes,
        findings,
        evidence: responseEvidence,
        failure: {
          kind: "stale-candidate",
          message: `Could not validate the current candidate: ${errorMessage(error)}`,
        },
      });
    }
    if (candidateIsStale(candidate, current)) {
      return result({
        candidate,
        outcome: "blocked",
        axes,
        findings,
        evidence: responseEvidence,
        failure: {
          kind: "stale-candidate",
          message: "Review candidate changed while the reviewer was running",
        },
      });
    }
  }

  const hasBlockingFindings = findings.some(blockingFinding);
  const requestedOutcome = response.outcome;
  if (requestedOutcome === "passed" && hasBlockingFindings) {
    return result({
      candidate,
      outcome: "actionable-findings",
      axes,
      findings,
      evidence: response.evidence,
      failure: {
        kind: "malformed",
        message: "Review declared pass while blocking findings remain",
      },
    });
  }
  if (requestedOutcome === "actionable-findings" && !hasBlockingFindings) {
    return result({
      candidate,
      outcome: "failed",
      axes,
      findings,
      evidence: response.evidence,
      failure: {
        kind: "malformed",
        message: "Actionable review must identify at least one finding",
      },
    });
  }

  const outcome: ReviewRunOutcome =
    requestedOutcome ??
    (hasBlockingFindings ? "actionable-findings" : "passed");
  if (outcome === "passed" && responseEvidence.length === 0) {
    return result({
      candidate,
      outcome: "incomplete",
      axes,
      findings,
      evidence: responseEvidence,
      failure: {
        kind: "malformed",
        message: "A passing review requires evidence",
      },
    });
  }
  return result({
    candidate,
    outcome,
    axes,
    findings,
    evidence: responseEvidence,
  });
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
