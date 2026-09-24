import { createHash } from "node:crypto";

export const WORKFLOW_CONTRACT_VERSION = 1 as const;

export type WorkItemKind = "planning-spec" | "executable-issue" | "pr-repair";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type WorkflowPhase =
  | "triage"
  | "implementation"
  | "checking"
  | "review"
  | "repair"
  | "handoff"
  | "merge"
  | "release-verification";

export type LifecycleState =
  | "queued"
  | "waiting-info"
  | "authorized"
  | "implementing"
  | "checking"
  | "reviewing"
  | "repairing"
  | "human-review"
  | "merged"
  | "release-verifying"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type PhaseOutcome =
  | "completed"
  | "needs-info"
  | "blocked"
  | "failed"
  | "cancelled";

export type CheckStatus =
  | "passed"
  | "failed"
  | "incomplete"
  | "blocked"
  | "unknown";

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";

export type ReviewAxis = "standards" | "spec" | "interface";

export type FindingDisposition =
  | "open"
  | "fixed"
  | "rejected"
  | "accepted"
  | "deferred";

export interface WorkIdentity {
  readonly repository: string;
  readonly itemId: string;
  readonly kind: WorkItemKind;
}

export interface SourceReference {
  readonly provider: "github" | "slack" | "manual";
  readonly repository: string;
  readonly itemId: string;
  readonly url?: string;
  /** Original content is retained durably but must not be echoed to an unauthorized destination. */
  readonly originalBody: string;
  readonly author?: string;
}

export interface RevisionReference {
  readonly branch: string;
  readonly sha: string;
}

export interface Authorization {
  readonly status: "pending" | "approved" | "withdrawn";
  readonly actor?: string;
  readonly actorRole?: "maintainer" | "owner" | "policy";
  readonly approvedAt?: string;
}

export interface VerificationPlan {
  readonly checks: readonly string[];
  readonly artifacts: readonly string[];
}

export interface WorkBrief {
  readonly contractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
  readonly identity: WorkIdentity;
  readonly source: SourceReference;
  readonly problem: string;
  readonly evidence: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly exclusions: readonly string[];
  readonly risk: RiskLevel;
  readonly verification: VerificationPlan;
  readonly unresolvedQuestions: readonly string[];
  readonly authorization: Authorization;
  readonly base: RevisionReference;
  readonly policyRevision: string;
  readonly skillRevision: string;
  readonly createdAt: string;
}

export interface CheckCommand {
  readonly name: string;
  readonly command: string;
  readonly required: boolean;
}

export interface PhaseBudget {
  readonly maxAttempts: number;
  readonly timeoutSeconds: number;
}

export type AgentRole = "routine" | "strong";

export interface AgentModelRoles {
  readonly routine: string;
  readonly strong: string;
}

export type WorkerPolicy = {
  readonly provider: string;
  readonly sandbox: string;
  readonly skillRevision: string;
} & (
  | { readonly model: string; readonly models?: never }
  | { readonly model?: never; readonly models: AgentModelRoles }
);

export interface AgentSelection {
  readonly provider: string;
  readonly model: string;
  readonly role: AgentRole;
}

export interface RepositoryPolicy {
  readonly contractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  readonly repository: string;
  readonly revision: string;
  readonly baseBranch: string;
  readonly issueClosure:
    | "merge-and-ci"
    | "staging-verification"
    | "production-verification";
  readonly authorization: {
    readonly required: boolean;
    readonly allowedActors: readonly ("maintainer" | "owner" | "policy")[];
    readonly autoStartRisk: readonly RiskLevel[];
  };
  readonly worker: WorkerPolicy;
  readonly checks: readonly CheckCommand[];
  readonly phaseBudgets: Readonly<Record<WorkflowPhase, PhaseBudget>>;
  readonly repairBudget: {
    readonly maxBatches: number;
    readonly maxFollowUps: number;
  };
}

/** Whether a brief carries an authorization accepted by this repository policy. */
export const isAuthorizationAllowed = (
  brief: Pick<WorkBrief, "authorization">,
  policy: Pick<RepositoryPolicy, "authorization">,
): boolean =>
  brief.authorization.status === "approved" &&
  brief.authorization.actor !== undefined &&
  brief.authorization.actor.trim().length > 0 &&
  brief.authorization.approvedAt !== undefined &&
  brief.authorization.approvedAt.trim().length > 0 &&
  brief.authorization.actorRole !== undefined &&
  policy.authorization.allowedActors.includes(brief.authorization.actorRole);

export interface CheckEvidence {
  readonly name: string;
  readonly command: string;
  readonly status: CheckStatus;
  readonly summary: string;
  /** Candidate identity for checks that are used as a lifecycle gate. */
  readonly baseSha?: string;
  readonly headSha?: string;
  readonly briefHash?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly exitCode?: number;
  readonly artifactRefs?: readonly string[];
}

export interface Finding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly axis: ReviewAxis;
  readonly disposition: FindingDisposition;
  readonly title: string;
  readonly evidence: string;
  readonly location?: string;
  readonly requirement?: string;
  readonly verification?: string;
}

export interface ReviewEvidence {
  readonly outcome:
    | "passed"
    | "actionable-findings"
    | "incomplete"
    | "blocked"
    | "failed";
  readonly axes: readonly ReviewAxis[];
  readonly findings: readonly Finding[];
  readonly headSha: string;
  readonly baseSha?: string;
  readonly briefHash: string;
}

export interface PhaseResult {
  readonly contractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  readonly assignmentId: string;
  readonly phase: WorkflowPhase;
  readonly outcome: PhaseOutcome;
  readonly identity: WorkIdentity;
  /** Brief revision executed by this phase. */
  readonly briefHash: string;
  readonly base?: RevisionReference;
  readonly head?: RevisionReference;
  readonly summary: string;
  readonly evidence: readonly string[];
  readonly checks: readonly CheckEvidence[];
  readonly commits: readonly string[];
  readonly artifacts: readonly string[];
  readonly questions: readonly string[];
  readonly findings: readonly Finding[];
  /** Review axes explicitly completed, including axes with no findings. */
  readonly reviewAxes?: readonly ReviewAxis[];
  readonly completedAt: string;
}

export interface Assignment {
  readonly contractVersion: typeof WORKFLOW_CONTRACT_VERSION;
  readonly id: string;
  readonly phase: WorkflowPhase;
  readonly attempt: number;
  readonly identity: WorkIdentity;
  readonly briefId: string;
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly policyRevision: string;
  readonly skillRevision: string;
  /** Missing only on assignments persisted before role model selection shipped. */
  readonly agentSelection?: AgentSelection;
  readonly base: RevisionReference;
  readonly head?: RevisionReference;
  readonly createdAt: string;
}

export interface TransitionContext {
  readonly kind: WorkItemKind;
  readonly authorization: Authorization["status"];
  readonly checks?: readonly CheckEvidence[];
  /** Required check names from the repository policy. */
  readonly requiredCheckNames?: readonly string[];
  /** Exact candidate identity required for lifecycle-gating check evidence. */
  readonly checkCandidate?: {
    readonly baseSha: string;
    readonly headSha: string;
    readonly briefHash: string;
  };
  readonly review?: ReviewEvidence;
  readonly currentHeadSha?: string;
  readonly assignedHeadSha?: string;
}

export class ContractValidationError extends Error {
  readonly issues: readonly string[];

  constructor(message: string, issues: readonly string[] = []) {
    super(message);
    this.name = "ContractValidationError";
    this.issues = issues.length > 0 ? issues : [message];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const nonEmptyString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ContractValidationError(`${path} must be a non-empty string`);
  }
  return value;
};

const optionalString = (value: unknown, path: string): string | undefined => {
  if (value === undefined) return undefined;
  return nonEmptyString(value, path);
};

const enumValue = <T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T => {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new ContractValidationError(
      `${path} must be one of: ${values.join(", ")}`,
    );
  }
  return value as T;
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) {
    throw new ContractValidationError(`${path} must be an array`);
  }
  return value.map((entry, index) =>
    nonEmptyString(entry, `${path}[${index}]`),
  );
};

const enumArray = <T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
): T[] =>
  stringArray(value, path).map((entry, index) =>
    enumValue(entry, values, `${path}[${index}]`),
  );

const positiveInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new ContractValidationError(`${path} must be a positive integer`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ContractValidationError(`${path} must be a non-negative integer`);
  }
  return value;
};

const contractVersion = (value: unknown): typeof WORKFLOW_CONTRACT_VERSION => {
  if (value !== WORKFLOW_CONTRACT_VERSION) {
    throw new ContractValidationError(
      `Unsupported workflow contract version: ${String(value)}`,
    );
  }
  return WORKFLOW_CONTRACT_VERSION;
};

const parseIdentity = (value: unknown, path = "identity"): WorkIdentity => {
  if (!isRecord(value)) {
    throw new ContractValidationError(`${path} must be an object`);
  }
  return {
    repository: nonEmptyString(value.repository, `${path}.repository`),
    itemId: nonEmptyString(value.itemId, `${path}.itemId`),
    kind: enumValue(
      value.kind,
      ["planning-spec", "executable-issue", "pr-repair"],
      `${path}.kind`,
    ),
  };
};

const parseRevision = (value: unknown, path: string): RevisionReference => {
  if (!isRecord(value)) {
    throw new ContractValidationError(`${path} must be an object`);
  }
  return {
    branch: nonEmptyString(value.branch, `${path}.branch`),
    sha: nonEmptyString(value.sha, `${path}.sha`),
  };
};

const parseAuthorization = (value: unknown): Authorization => {
  if (!isRecord(value)) {
    throw new ContractValidationError("authorization must be an object");
  }
  const result: Authorization = {
    status: enumValue(
      value.status,
      ["pending", "approved", "withdrawn"],
      "authorization.status",
    ),
    actor: optionalString(value.actor, "authorization.actor"),
    actorRole:
      value.actorRole === undefined
        ? undefined
        : enumValue(
            value.actorRole,
            ["maintainer", "owner", "policy"] as const,
            "authorization.actorRole",
          ),
    approvedAt: optionalString(value.approvedAt, "authorization.approvedAt"),
  };
  if (result.status === "approved" && (!result.actor || !result.approvedAt)) {
    throw new ContractValidationError(
      "approved authorization requires actor and approvedAt",
    );
  }
  return result;
};

const parseSource = (value: unknown): SourceReference => {
  if (!isRecord(value)) {
    throw new ContractValidationError("source must be an object");
  }
  return {
    provider: enumValue(
      value.provider,
      ["github", "slack", "manual"],
      "source.provider",
    ),
    repository: nonEmptyString(value.repository, "source.repository"),
    itemId: nonEmptyString(value.itemId, "source.itemId"),
    url: optionalString(value.url, "source.url"),
    originalBody: nonEmptyString(value.originalBody, "source.originalBody"),
    author: optionalString(value.author, "source.author"),
  };
};

const parseVerification = (value: unknown): VerificationPlan => {
  if (!isRecord(value)) {
    throw new ContractValidationError("verification must be an object");
  }
  return {
    checks: stringArray(value.checks, "verification.checks"),
    artifacts: stringArray(value.artifacts, "verification.artifacts"),
  };
};

const briefHashInput = (brief: Omit<WorkBrief, "hash">): string =>
  canonicalJson(brief);

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

export type CreateWorkBriefInput = Omit<
  WorkBrief,
  "contractVersion" | "id" | "revision" | "hash"
> & {
  readonly id?: string;
  readonly revision?: number;
  /** Accepted for callers carrying a previously materialized brief; always recomputed. */
  readonly hash?: string;
  readonly contractVersion?: typeof WORKFLOW_CONTRACT_VERSION;
};

export const createWorkBrief = (input: CreateWorkBriefInput): WorkBrief => {
  const withoutHash: Omit<WorkBrief, "hash"> = {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    id:
      input.id ??
      `${input.identity.repository}:${input.identity.kind}:${input.identity.itemId}`,
    revision: input.revision ?? 1,
    identity: parseIdentity(input.identity),
    source: parseSource(input.source),
    problem: nonEmptyString(input.problem, "problem"),
    evidence: stringArray(input.evidence, "evidence"),
    acceptanceCriteria: stringArray(
      input.acceptanceCriteria,
      "acceptanceCriteria",
    ),
    exclusions: stringArray(input.exclusions, "exclusions"),
    risk: enumValue(input.risk, ["low", "medium", "high", "critical"], "risk"),
    verification: parseVerification(input.verification),
    unresolvedQuestions: stringArray(
      input.unresolvedQuestions,
      "unresolvedQuestions",
    ),
    authorization: parseAuthorization(input.authorization),
    base: parseRevision(input.base, "base"),
    policyRevision: nonEmptyString(input.policyRevision, "policyRevision"),
    skillRevision: nonEmptyString(input.skillRevision, "skillRevision"),
    createdAt: nonEmptyString(input.createdAt, "createdAt"),
  };
  if (
    withoutHash.identity.repository !== withoutHash.source.repository ||
    withoutHash.identity.itemId !== withoutHash.source.itemId
  ) {
    throw new ContractValidationError(
      "work brief source must identify the same repository and item as its identity",
    );
  }
  const brief: WorkBrief = {
    ...withoutHash,
    hash: sha256(briefHashInput(withoutHash)),
  };
  return parseWorkBrief(brief);
};

export const parseWorkBrief = (value: unknown): WorkBrief => {
  if (!isRecord(value)) {
    throw new ContractValidationError("work brief must be an object");
  }
  const parsedWithoutHash: Omit<WorkBrief, "hash"> = {
    contractVersion: contractVersion(value.contractVersion),
    id: nonEmptyString(value.id, "id"),
    revision: positiveInteger(value.revision, "revision"),
    identity: parseIdentity(value.identity),
    source: parseSource(value.source),
    problem: nonEmptyString(value.problem, "problem"),
    evidence: stringArray(value.evidence, "evidence"),
    acceptanceCriteria: stringArray(
      value.acceptanceCriteria,
      "acceptanceCriteria",
    ),
    exclusions: stringArray(value.exclusions, "exclusions"),
    risk: enumValue(value.risk, ["low", "medium", "high", "critical"], "risk"),
    verification: parseVerification(value.verification),
    unresolvedQuestions: stringArray(
      value.unresolvedQuestions,
      "unresolvedQuestions",
    ),
    authorization: parseAuthorization(value.authorization),
    base: parseRevision(value.base, "base"),
    policyRevision: nonEmptyString(value.policyRevision, "policyRevision"),
    skillRevision: nonEmptyString(value.skillRevision, "skillRevision"),
    createdAt: nonEmptyString(value.createdAt, "createdAt"),
  };
  const hash = nonEmptyString(value.hash, "hash");
  if (
    parsedWithoutHash.identity.repository !==
      parsedWithoutHash.source.repository ||
    parsedWithoutHash.identity.itemId !== parsedWithoutHash.source.itemId
  ) {
    throw new ContractValidationError(
      "work brief source must identify the same repository and item as its identity",
    );
  }
  const expectedHash = sha256(briefHashInput(parsedWithoutHash));
  if (hash !== expectedHash) {
    throw new ContractValidationError("work brief hash does not match content");
  }
  return { ...parsedWithoutHash, hash };
};

const parsePhaseBudget = (value: unknown, path: string): PhaseBudget => {
  if (!isRecord(value)) {
    throw new ContractValidationError(`${path} must be an object`);
  }
  return {
    maxAttempts: positiveInteger(value.maxAttempts, `${path}.maxAttempts`),
    timeoutSeconds: positiveInteger(
      value.timeoutSeconds,
      `${path}.timeoutSeconds`,
    ),
  };
};

const workflowPhases: readonly WorkflowPhase[] = [
  "triage",
  "implementation",
  "checking",
  "review",
  "repair",
  "handoff",
  "merge",
  "release-verification",
];

export type CreateRepositoryPolicyInput = Omit<
  RepositoryPolicy,
  "contractVersion"
>;

export const parseRepositoryPolicy = (value: unknown): RepositoryPolicy => {
  if (!isRecord(value)) {
    throw new ContractValidationError("repository policy must be an object");
  }
  if (!isRecord(value.authorization)) {
    throw new ContractValidationError("policy.authorization must be an object");
  }
  if (!isRecord(value.worker)) {
    throw new ContractValidationError("policy.worker must be an object");
  }
  const workerModels =
    value.worker.models === undefined
      ? undefined
      : (() => {
          if (value.worker.model !== undefined) {
            throw new ContractValidationError(
              "policy.worker.model cannot be combined with policy.worker.models",
            );
          }
          if (!isRecord(value.worker.models)) {
            throw new ContractValidationError(
              "policy.worker.models must be an object",
            );
          }
          return {
            routine: nonEmptyString(
              value.worker.models.routine,
              "policy.worker.models.routine",
            ),
            strong: nonEmptyString(
              value.worker.models.strong,
              "policy.worker.models.strong",
            ),
          };
        })();
  if (!Array.isArray(value.checks)) {
    throw new ContractValidationError("policy.checks must be an array");
  }
  const phaseBudgetRecord = value.phaseBudgets;
  if (!isRecord(phaseBudgetRecord)) {
    throw new ContractValidationError("policy.phaseBudgets must be an object");
  }
  if (!isRecord(value.repairBudget)) {
    throw new ContractValidationError("policy.repairBudget must be an object");
  }
  const phaseBudgets = Object.fromEntries(
    workflowPhases.map((phase) => {
      if (!(phase in phaseBudgetRecord)) {
        throw new ContractValidationError(
          `policy.phaseBudgets.${phase} is required`,
        );
      }
      return [
        phase,
        parsePhaseBudget(
          phaseBudgetRecord[phase],
          `policy.phaseBudgets.${phase}`,
        ),
      ];
    }),
  ) as Record<WorkflowPhase, PhaseBudget>;
  const checks = value.checks.map((check, index) => {
    if (!isRecord(check)) {
      throw new ContractValidationError(
        `policy.checks[${index}] must be an object`,
      );
    }
    return {
      name: nonEmptyString(check.name, `policy.checks[${index}].name`),
      command: nonEmptyString(check.command, `policy.checks[${index}].command`),
      required:
        typeof check.required === "boolean"
          ? check.required
          : (() => {
              throw new ContractValidationError(
                `policy.checks[${index}].required must be a boolean`,
              );
            })(),
    };
  });
  const allowedActors = stringArray(
    value.authorization.allowedActors,
    "policy.authorization.allowedActors",
  ).map((actor) =>
    enumValue(
      actor,
      ["maintainer", "owner", "policy"] as const,
      "policy.authorization.allowedActors",
    ),
  );
  const autoStartRisk = stringArray(
    value.authorization.autoStartRisk,
    "policy.authorization.autoStartRisk",
  ).map((risk) =>
    enumValue(
      risk,
      ["low", "medium", "high", "critical"] as const,
      "policy.authorization.autoStartRisk",
    ),
  );
  const required = value.authorization.required;
  if (typeof required !== "boolean") {
    throw new ContractValidationError(
      "policy.authorization.required must be a boolean",
    );
  }
  const maxBatches = positiveInteger(
    value.repairBudget.maxBatches,
    "policy.repairBudget.maxBatches",
  );
  const maxFollowUps = nonNegativeInteger(
    value.repairBudget.maxFollowUps,
    "policy.repairBudget.maxFollowUps",
  );
  return {
    contractVersion: contractVersion(value.contractVersion),
    repository: nonEmptyString(value.repository, "policy.repository"),
    revision: nonEmptyString(value.revision, "policy.revision"),
    baseBranch: nonEmptyString(value.baseBranch, "policy.baseBranch"),
    issueClosure: enumValue(
      value.issueClosure,
      [
        "merge-and-ci",
        "staging-verification",
        "production-verification",
      ] as const,
      "policy.issueClosure",
    ),
    authorization: { required, allowedActors, autoStartRisk },
    worker: {
      provider: nonEmptyString(value.worker.provider, "policy.worker.provider"),
      ...(workerModels === undefined
        ? { model: nonEmptyString(value.worker.model, "policy.worker.model") }
        : { models: workerModels }),
      sandbox: nonEmptyString(value.worker.sandbox, "policy.worker.sandbox"),
      skillRevision: nonEmptyString(
        value.worker.skillRevision,
        "policy.worker.skillRevision",
      ),
    },
    checks,
    phaseBudgets,
    repairBudget: { maxBatches, maxFollowUps },
  };
};

export const createRepositoryPolicy = (
  input: CreateRepositoryPolicyInput,
): RepositoryPolicy =>
  parseRepositoryPolicy({
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    ...input,
  });

export const resolveAgentSelection = (
  policy: Pick<RepositoryPolicy, "worker">,
  phase: WorkflowPhase,
  risk?: RiskLevel | "unknown",
): AgentSelection => {
  const role: AgentRole =
    phase === "review" && risk !== "low" ? "strong" : "routine";
  const worker = policy.worker;
  const modelPath = worker.models
    ? `policy.worker.models.${role}`
    : "policy.worker.model";
  return Object.freeze({
    provider: nonEmptyString(worker.provider, "policy.worker.provider"),
    model: nonEmptyString(worker.models?.[role] ?? worker.model, modelPath),
    role,
  });
};

export const parseCheckEvidence = (value: unknown): CheckEvidence => {
  if (!isRecord(value)) {
    throw new ContractValidationError("check evidence must be an object");
  }
  const status = enumValue(
    value.status,
    ["passed", "failed", "incomplete", "blocked", "unknown"],
    "check.status",
  );
  const summary = nonEmptyString(value.summary, "check.summary");
  const exitCode =
    value.exitCode === undefined
      ? undefined
      : nonNegativeInteger(value.exitCode, "check.exitCode");
  return {
    name: nonEmptyString(value.name, "check.name"),
    command: nonEmptyString(value.command, "check.command"),
    status,
    summary,
    baseSha: optionalString(value.baseSha, "check.baseSha"),
    headSha: optionalString(value.headSha, "check.headSha"),
    briefHash: optionalString(value.briefHash, "check.briefHash"),
    startedAt: optionalString(value.startedAt, "check.startedAt"),
    completedAt: optionalString(value.completedAt, "check.completedAt"),
    exitCode,
    artifactRefs:
      value.artifactRefs === undefined
        ? undefined
        : stringArray(value.artifactRefs, "check.artifactRefs"),
  };
};

const allowedTransitions: Readonly<
  Record<LifecycleState, readonly LifecycleState[]>
> = {
  queued: ["waiting-info", "authorized", "cancelled", "blocked", "failed"],
  "waiting-info": ["queued", "authorized", "cancelled"],
  authorized: ["implementing", "waiting-info", "cancelled", "blocked"],
  implementing: ["checking", "waiting-info", "blocked", "failed", "cancelled"],
  checking: ["reviewing", "repairing", "blocked", "failed", "cancelled"],
  reviewing: ["repairing", "human-review", "blocked", "failed", "cancelled"],
  repairing: ["checking", "reviewing", "blocked", "failed", "cancelled"],
  "human-review": ["merged", "repairing", "blocked", "cancelled"],
  merged: ["release-verifying", "completed", "failed", "blocked"],
  "release-verifying": ["completed", "failed", "blocked"],
  completed: [],
  failed: [],
  blocked: [],
  cancelled: [],
};

const allRequiredChecksPassed = (
  context: Pick<
    TransitionContext,
    "checks" | "requiredCheckNames" | "checkCandidate"
  >,
): boolean => {
  const checks = context.checks;
  if (checks === undefined) return false;
  if (context.requiredCheckNames === undefined) {
    return (
      checks.length > 0 && checks.every((check) => check.status === "passed")
    );
  }
  if (
    context.requiredCheckNames.length > 0 &&
    context.checkCandidate === undefined
  ) {
    return false;
  }
  return context.requiredCheckNames.every((name) =>
    checks.some(
      (check) =>
        check.name === name &&
        check.status === "passed" &&
        (context.checkCandidate === undefined ||
          (check.baseSha === context.checkCandidate.baseSha &&
            check.headSha === context.checkCandidate.headSha &&
            check.briefHash === context.checkCandidate.briefHash)),
    ),
  );
};

export const requireTransition = (
  from: LifecycleState,
  to: LifecycleState,
  context: TransitionContext,
): void => {
  if (!allowedTransitions[from].includes(to)) {
    throw new ContractValidationError(
      `Transition from ${from} to ${to} is not allowed`,
    );
  }
  if (to === "implementing") {
    if (context.kind !== "executable-issue") {
      throw new ContractValidationError(
        "Only an executable issue may enter implementation; planning spec and PR repair are separate flows",
      );
    }
    if (context.authorization !== "approved") {
      throw new ContractValidationError(
        "Implementation requires approved authorization",
      );
    }
  }
  if (to === "reviewing" && !allRequiredChecksPassed(context)) {
    const unknown = context.checks?.find((check) => check.status === "unknown");
    throw new ContractValidationError(
      unknown
        ? `Cannot review while check ${unknown.name} is unknown`
        : "Cannot review until all required checks pass",
    );
  }
  if (to === "human-review") {
    if (!allRequiredChecksPassed(context)) {
      throw new ContractValidationError(
        "Human review requires a complete set of passing checks",
      );
    }
    if (
      context.review?.outcome !== "passed" ||
      context.review.axes.length === 0 ||
      context.review.findings.some(
        (finding) =>
          finding.severity !== "info" &&
          (finding.disposition === "open" ||
            finding.disposition === "deferred"),
      )
    ) {
      throw new ContractValidationError(
        "Human review requires every review axis to pass and blocking findings to be disposed",
      );
    }
    if (
      context.currentHeadSha !== undefined &&
      context.assignedHeadSha !== undefined &&
      context.currentHeadSha !== context.assignedHeadSha
    ) {
      throw new ContractValidationError(
        "Human review evidence is stale for the current candidate head",
      );
    }
  }
};

export interface CreateAssignmentInput {
  readonly id: string;
  readonly phase: WorkflowPhase;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly attempt: number;
  readonly head?: RevisionReference;
  readonly createdAt: string;
}

export const createAssignment = (input: CreateAssignmentInput): Assignment => {
  const brief = parseWorkBrief(input.brief);
  if (brief.identity.kind === "planning-spec") {
    throw new ContractValidationError(
      "A planning spec cannot receive an execution assignment",
    );
  }
  if (
    input.phase === "implementation" &&
    brief.identity.kind !== "executable-issue"
  ) {
    throw new ContractValidationError(
      "PR repair work must use the repair phase; planning spec cannot be implemented",
    );
  }
  if (
    input.phase === "implementation" &&
    !isAuthorizationAllowed(brief, input.policy)
  ) {
    throw new ContractValidationError(
      "Implementation assignments require approved authorization",
    );
  }
  if (input.policy.repository !== brief.identity.repository) {
    throw new ContractValidationError(
      "Assignment policy repository does not match work identity",
    );
  }
  if (
    ["checking", "review", "handoff", "merge"].includes(input.phase) &&
    input.head === undefined
  ) {
    throw new ContractValidationError(
      `${input.phase} assignments require an immutable candidate head`,
    );
  }
  const assignment: Assignment = {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    id: nonEmptyString(input.id, "assignment.id"),
    phase: input.phase,
    attempt: positiveInteger(input.attempt, "assignment.attempt"),
    identity: brief.identity,
    briefId: brief.id,
    briefRevision: brief.revision,
    briefHash: brief.hash,
    policyRevision: input.policy.revision,
    skillRevision: brief.skillRevision,
    agentSelection: resolveAgentSelection(
      input.policy,
      input.phase,
      brief.risk,
    ),
    base: brief.base,
    head: input.head,
    createdAt: nonEmptyString(input.createdAt, "assignment.createdAt"),
  };
  return Object.freeze(assignment);
};

export const parsePhaseResult = (value: unknown): PhaseResult => {
  if (!isRecord(value)) {
    throw new ContractValidationError("phase result must be an object");
  }
  contractVersion(value.contractVersion);
  const outcome = enumValue(
    value.outcome,
    ["completed", "needs-info", "blocked", "failed", "cancelled"],
    "phase result.outcome",
  );
  const evidence = stringArray(value.evidence, "phase result.evidence");
  const commits = stringArray(value.commits, "phase result.commits");
  if (
    outcome === "completed" &&
    evidence.length === 0 &&
    commits.length === 0
  ) {
    throw new ContractValidationError(
      "A completed phase requires evidence; zero commits alone cannot mean success",
    );
  }
  const checksValue = value.checks;
  if (!Array.isArray(checksValue)) {
    throw new ContractValidationError("phase result.checks must be an array");
  }
  const checks = checksValue.map(parseCheckEvidence);
  return {
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    assignmentId: nonEmptyString(
      value.assignmentId,
      "phase result.assignmentId",
    ),
    phase: enumValue(
      value.phase,
      [
        "triage",
        "implementation",
        "checking",
        "review",
        "repair",
        "handoff",
        "merge",
        "release-verification",
      ],
      "phase result.phase",
    ),
    outcome,
    identity: parseIdentity(value.identity, "phase result.identity"),
    briefHash: nonEmptyString(value.briefHash, "phase result.briefHash"),
    base:
      value.base === undefined
        ? undefined
        : parseRevision(value.base, "phase result.base"),
    head:
      value.head === undefined
        ? undefined
        : parseRevision(value.head, "phase result.head"),
    summary: nonEmptyString(value.summary, "phase result.summary"),
    evidence,
    checks,
    commits,
    artifacts: stringArray(value.artifacts, "phase result.artifacts"),
    questions: stringArray(value.questions, "phase result.questions"),
    findings: Array.isArray(value.findings)
      ? value.findings.map(parseFinding)
      : (() => {
          throw new ContractValidationError(
            "phase result.findings must be an array",
          );
        })(),
    reviewAxes:
      value.reviewAxes === undefined
        ? undefined
        : enumArray(
            value.reviewAxes,
            ["standards", "spec", "interface"],
            "phase result.reviewAxes",
          ),
    completedAt: nonEmptyString(value.completedAt, "phase result.completedAt"),
  };
};

const parseFinding = (value: unknown): Finding => {
  if (!isRecord(value)) {
    throw new ContractValidationError("finding must be an object");
  }
  return {
    id: nonEmptyString(value.id, "finding.id"),
    severity: enumValue(
      value.severity,
      ["info", "low", "medium", "high", "critical"],
      "finding.severity",
    ),
    axis: enumValue(
      value.axis,
      ["standards", "spec", "interface"],
      "finding.axis",
    ),
    disposition: enumValue(
      value.disposition,
      ["open", "fixed", "rejected", "accepted", "deferred"],
      "finding.disposition",
    ),
    title: nonEmptyString(value.title, "finding.title"),
    evidence: nonEmptyString(value.evidence, "finding.evidence"),
    location: optionalString(value.location, "finding.location"),
    requirement: optionalString(value.requirement, "finding.requirement"),
    verification: optionalString(value.verification, "finding.verification"),
  };
};
