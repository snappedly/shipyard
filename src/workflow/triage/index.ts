import { createHash } from "node:crypto";
import {
  createWorkBrief,
  isAuthorizationAllowed,
  type RepositoryPolicy,
  type RiskLevel,
  type RevisionReference,
  type WorkBrief,
  type WorkItemKind,
} from "../contracts/index.js";

export type TriageCategory =
  | "bug"
  | "enhancement"
  | "support"
  | "duplicate"
  | "sensitive"
  | "non-actionable";

export type TriageOutcome =
  | "completed"
  | "needs-info"
  | "duplicate"
  | "sensitive"
  | "non-actionable"
  | "blocked"
  | "failed";

export interface TriageSource {
  readonly provider: "github" | "slack" | "manual";
  readonly repository: string;
  readonly itemId: string;
  readonly title: string;
  readonly body: string;
  readonly author?: string;
  readonly url?: string;
  readonly updatedAt: string;
  readonly kind?: WorkItemKind;
  readonly labels?: readonly string[];
}

export interface ClarificationReply {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly updatedAt: string;
}

export interface TriageAssessment {
  readonly category: TriageCategory;
  readonly evidence: readonly string[];
  readonly relevantFiles: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly exclusions: readonly string[];
  readonly risk: RiskLevel;
  readonly verification: readonly string[];
  readonly unresolvedQuestions: readonly string[];
  readonly requirementsConfirmed: boolean;
  readonly duplicateOf?: string;
  readonly sensitiveReason?: string;
}

export interface TriageInvestigationRequest {
  readonly source: TriageSource;
  readonly policy: RepositoryPolicy;
  readonly base: RevisionReference;
  readonly previous?: TriageRecord;
  readonly clarificationReply?: ClarificationReply;
}

export type TriageInvestigator =
  | ((request: TriageInvestigationRequest) => Promise<TriageAssessment>)
  | {
      investigate(
        request: TriageInvestigationRequest,
      ): Promise<TriageAssessment>;
    };

export interface TriageRecord {
  readonly id: string;
  readonly sourceKey: string;
  /** Retained for durable investigation and resumption; never used as public output. */
  readonly source: TriageSource;
  readonly sourceUpdatedAt: string;
  readonly sourceFingerprint: string;
  readonly revision: number;
  readonly category: TriageCategory;
  readonly outcome: TriageOutcome;
  readonly assessment: TriageAssessment;
  readonly brief?: WorkBrief;
  readonly questions: readonly string[];
  readonly clarificationIds: readonly string[];
  readonly duplicateOf?: string;
  readonly publicMessage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TriageStore {
  get(sourceKey: string): TriageRecord | undefined;
  save(record: TriageRecord): void;
}

export class InMemoryTriageStore implements TriageStore {
  private readonly records = new Map<string, TriageRecord>();

  get(sourceKey: string): TriageRecord | undefined {
    const record = this.records.get(sourceKey);
    return record === undefined ? undefined : clone(record);
  }

  save(record: TriageRecord): void {
    this.records.set(record.sourceKey, clone(record));
  }
}

export interface RunTriageOptions {
  readonly source: TriageSource;
  readonly policy: RepositoryPolicy;
  readonly base: RevisionReference;
  readonly store: TriageStore;
  readonly investigator?: TriageInvestigator;
  readonly clarificationReply?: ClarificationReply;
  readonly now?: () => string;
}

export interface TriageResult {
  readonly outcome: TriageOutcome;
  readonly category: TriageCategory;
  readonly brief?: WorkBrief;
  readonly questions: readonly string[];
  readonly publicMessage: string;
  readonly record: TriageRecord;
  readonly implementationEligible: boolean;
}

const defaultNow = (): string => new Date().toISOString();

const nonEmpty = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value.trim();
};

const optionalNonEmpty = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : nonEmpty(value, path);

const isCategory = (value: unknown): value is TriageCategory =>
  typeof value === "string" &&
  [
    "bug",
    "enhancement",
    "support",
    "duplicate",
    "sensitive",
    "non-actionable",
  ].includes(value);

const isRisk = (value: unknown): value is RiskLevel =>
  typeof value === "string" &&
  ["low", "medium", "high", "critical"].includes(value);

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => nonEmpty(entry, `${path}[${index}]`));
};

const sha256 = (value: string): string =>
  createHash("sha256").update(value).digest("hex");

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const sourceKind = (source: TriageSource): WorkItemKind =>
  source.kind ?? "executable-issue";

const sourceKey = (source: TriageSource): string =>
  [source.repository, source.itemId, sourceKind(source)].join("\u0000");

const sourceFingerprint = (source: TriageSource): string =>
  sha256(
    JSON.stringify({
      provider: source.provider,
      repository: source.repository,
      itemId: source.itemId,
      title: source.title,
      body: source.body,
      author: source.author ?? "",
      url: source.url ?? "",
      updatedAt: source.updatedAt,
      kind: sourceKind(source),
      labels: [...(source.labels ?? [])].sort(),
    }),
  );

const normalizeSource = (source: TriageSource): TriageSource => ({
  ...source,
  repository: nonEmpty(source.repository, "source.repository"),
  itemId: nonEmpty(source.itemId, "source.itemId"),
  title: nonEmpty(source.title, "source.title"),
  body: typeof source.body === "string" ? source.body : "",
  author: optionalNonEmpty(source.author, "source.author"),
  url: optionalNonEmpty(source.url, "source.url"),
  updatedAt: nonEmpty(source.updatedAt, "source.updatedAt"),
  kind: sourceKind(source),
  labels: [...(source.labels ?? [])].map((label, index) =>
    nonEmpty(label, `source.labels[${index}]`),
  ),
});

const normalizeAssessment = (value: TriageAssessment): TriageAssessment => {
  if (!value || typeof value !== "object") {
    throw new Error("investigator returned no assessment");
  }
  if (!isCategory(value.category))
    throw new Error("assessment.category is invalid");
  if (!isRisk(value.risk)) throw new Error("assessment.risk is invalid");
  if (typeof value.requirementsConfirmed !== "boolean") {
    throw new Error("assessment.requirementsConfirmed must be a boolean");
  }
  const duplicateOf = optionalNonEmpty(
    value.duplicateOf,
    "assessment.duplicateOf",
  );
  const sensitiveReason = optionalNonEmpty(
    value.sensitiveReason,
    "assessment.sensitiveReason",
  );
  return {
    category: value.category,
    evidence: stringArray(value.evidence, "assessment.evidence"),
    relevantFiles: stringArray(value.relevantFiles, "assessment.relevantFiles"),
    acceptanceCriteria: stringArray(
      value.acceptanceCriteria,
      "assessment.acceptanceCriteria",
    ),
    exclusions: stringArray(value.exclusions, "assessment.exclusions"),
    risk: value.risk,
    verification: stringArray(value.verification, "assessment.verification"),
    unresolvedQuestions: stringArray(
      value.unresolvedQuestions,
      "assessment.unresolvedQuestions",
    ),
    requirementsConfirmed: value.requirementsConfirmed,
    duplicateOf,
    sensitiveReason,
  };
};

const safeDuplicateId = (value: string | undefined): string | undefined => {
  if (
    value === undefined ||
    !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(value)
  ) {
    return undefined;
  }
  return value;
};

const defaultInvestigator: TriageInvestigator = {
  async investigate({ source }): Promise<TriageAssessment> {
    const text = `${source.title}\n${source.body}`.toLowerCase();
    const labels = new Set(
      (source.labels ?? []).map((label) => label.toLowerCase()),
    );
    const duplicateMatch = text.match(
      /(?:duplicate|dupe)(?: of|:|#)\s*([\w./:-]+)/i,
    );
    const category: TriageCategory =
      labels.has("sensitive") ||
      /\b(secret|token|password|credential|security report)\b/.test(text)
        ? "sensitive"
        : labels.has("duplicate") || duplicateMatch !== null
          ? "duplicate"
          : labels.has("support") ||
              /\?|\b(how do i|support|question)\b/.test(text)
            ? "support"
            : labels.has("bug") ||
                /\b(bug|fix|error|crash|broken|fail(?:ed|ure)?)\b/.test(text)
              ? "bug"
              : "enhancement";
    const highRisk =
      /\b(auth|billing|payment|migration|destructive|security)\b/.test(text);
    const hasExplicitRequirements =
      /\b(acceptance|expected|should|must|given|when|then)\b/.test(text) &&
      source.body.trim().length > 0;
    return {
      category,
      evidence: [
        "Classification derived from the submitted title, body, and labels.",
      ],
      relevantFiles: [],
      acceptanceCriteria: hasExplicitRequirements
        ? ["Implement only the explicitly described behavior."]
        : [],
      exclusions: [
        "Do not expand scope beyond the retained source and confirmed answers.",
      ],
      risk: highRisk ? "high" : "low",
      verification: [],
      unresolvedQuestions: hasExplicitRequirements
        ? []
        : [
            "What observable behavior should change, and how will it be accepted?",
          ],
      requirementsConfirmed: hasExplicitRequirements,
      duplicateOf: safeDuplicateId(duplicateMatch?.[1]),
    };
  },
};

const investigate = (
  investigator: TriageInvestigator,
  request: TriageInvestigationRequest,
): Promise<TriageAssessment> =>
  typeof investigator === "function"
    ? investigator(request)
    : investigator.investigate(request);

const canAutoAuthorize = (
  source: TriageSource,
  assessment: TriageAssessment,
  policy: RepositoryPolicy,
): boolean =>
  sourceKind(source) === "executable-issue" &&
  !policy.authorization.required &&
  policy.authorization.allowedActors.includes("policy") &&
  policy.authorization.autoStartRisk.includes(assessment.risk) &&
  assessment.requirementsConfirmed &&
  assessment.unresolvedQuestions.length === 0 &&
  assessment.acceptanceCriteria.length > 0 &&
  assessment.category !== "support" &&
  assessment.category !== "duplicate" &&
  assessment.category !== "sensitive" &&
  assessment.category !== "non-actionable";

const publicMessage = (
  outcome: TriageOutcome,
  category: TriageCategory,
  questions: readonly string[],
  duplicateId?: string,
): string => {
  switch (outcome) {
    case "needs-info":
      return `Triage needs clarification (${questions.length} question${questions.length === 1 ? "" : "s"}); the work item remains paused.`;
    case "duplicate":
      return duplicateId === undefined
        ? "Triage routed this report as a duplicate for maintainer review."
        : `Triage routed this report as a duplicate of #${duplicateId}.`;
    case "sensitive":
      return "Triage routed this report to the private security channel; sensitive details are not reproduced here.";
    case "non-actionable":
      return "Triage routed this report for maintainer disposition.";
    case "blocked":
      return "Triage recorded the work item but ordinary implementation dispatch is blocked for this item type.";
    case "failed":
      return "Triage could not complete; a maintainer must inspect the failure without relying on source text in public output.";
    case "completed":
      return category === "support"
        ? "Triage recorded this support request for a maintainer response."
        : "Triage completed; implementation authorization remains a separate policy decision.";
  }
};

const makeBrief = (
  source: TriageSource,
  assessment: TriageAssessment,
  policy: RepositoryPolicy,
  base: RevisionReference,
  revision: number,
  createdAt: string,
): WorkBrief => {
  const originalBody =
    source.body.trim().length > 0 ? source.body : "(empty source body)";
  const authorization = canAutoAuthorize(source, assessment, policy)
    ? {
        status: "approved" as const,
        actor: "policy",
        actorRole: "policy" as const,
        approvedAt: createdAt,
      }
    : { status: "pending" as const };
  return createWorkBrief({
    id: `${source.repository}:${sourceKind(source)}:${source.itemId}`,
    revision,
    identity: {
      repository: source.repository,
      itemId: source.itemId,
      kind: sourceKind(source),
    },
    source: {
      provider: source.provider,
      repository: source.repository,
      itemId: source.itemId,
      url: source.url,
      originalBody,
      author: source.author,
    },
    problem: source.title,
    evidence: assessment.evidence,
    acceptanceCriteria: assessment.acceptanceCriteria,
    exclusions: assessment.exclusions,
    risk: assessment.risk,
    verification: {
      checks: assessment.verification,
      artifacts: assessment.relevantFiles,
    },
    unresolvedQuestions: assessment.unresolvedQuestions,
    authorization,
    base,
    policyRevision: policy.revision,
    skillRevision: policy.worker.skillRevision,
    createdAt,
  });
};

const resultFromRecord = (
  record: TriageRecord,
  policy: RepositoryPolicy,
): TriageResult => ({
  outcome: record.outcome,
  category: record.category,
  brief: record.brief,
  questions: record.questions,
  publicMessage: record.publicMessage,
  record,
  implementationEligible:
    record.outcome === "completed" &&
    record.category !== "support" &&
    record.brief?.identity.kind === "executable-issue" &&
    record.brief !== undefined &&
    record.brief.policyRevision === policy.revision &&
    isAuthorizationAllowed(record.brief, policy),
});

export const runTriage = async ({
  source: rawSource,
  policy,
  base,
  store,
  investigator = defaultInvestigator,
  clarificationReply,
  now = defaultNow,
}: RunTriageOptions): Promise<TriageResult> => {
  const source = normalizeSource(rawSource);
  if (source.repository !== policy.repository) {
    throw new Error("source.repository must match policy.repository");
  }
  const key = sourceKey(source);
  const fingerprint = sourceFingerprint(source);
  const existing = store.get(key);
  const replyAlreadyApplied =
    clarificationReply !== undefined &&
    existing?.clarificationIds.includes(clarificationReply.id);
  if (
    existing !== undefined &&
    (clarificationReply === undefined || replyAlreadyApplied) &&
    existing.sourceFingerprint === fingerprint
  ) {
    return resultFromRecord(existing, policy);
  }
  if (
    existing !== undefined &&
    clarificationReply === undefined &&
    existing.sourceUpdatedAt === source.updatedAt &&
    existing.sourceFingerprint === fingerprint
  ) {
    return resultFromRecord(existing, policy);
  }

  const timestamp = now();
  let assessment: TriageAssessment;
  try {
    assessment = normalizeAssessment(
      await investigate(investigator, {
        source,
        policy,
        base,
        previous: existing,
        clarificationReply,
      }),
    );
  } catch (error) {
    const failedAssessment: TriageAssessment = {
      category: "non-actionable",
      evidence: [
        "The investigator did not return a usable structured assessment.",
      ],
      relevantFiles: [],
      acceptanceCriteria: [],
      exclusions: [
        "No implementation may start from an incomplete assessment.",
      ],
      risk: "high",
      verification: [],
      unresolvedQuestions: [],
      requirementsConfirmed: false,
    };
    const record: TriageRecord = {
      id:
        existing?.id ??
        `${source.repository}:${sourceKind(source)}:${source.itemId}`,
      sourceKey: key,
      source,
      sourceUpdatedAt: source.updatedAt,
      sourceFingerprint: fingerprint,
      revision: existing?.revision ?? 1,
      category: failedAssessment.category,
      outcome: "failed",
      assessment: failedAssessment,
      questions: [],
      clarificationIds: existing?.clarificationIds ?? [],
      publicMessage: publicMessage("failed", failedAssessment.category, []),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    store.save(record);
    return resultFromRecord(record, policy);
  }

  const questions = assessment.unresolvedQuestions;
  const category = assessment.category;
  const kind = sourceKind(source);
  const duplicateId = safeDuplicateId(assessment.duplicateOf);
  const isSpecialDisposition =
    category === "duplicate" ||
    category === "sensitive" ||
    category === "non-actionable";
  const isBlockedKind = kind !== "executable-issue";
  const needsInfo =
    !isSpecialDisposition &&
    !isBlockedKind &&
    (!assessment.requirementsConfirmed ||
      questions.length > 0 ||
      assessment.acceptanceCriteria.length === 0);
  const outcome: TriageOutcome = isBlockedKind
    ? "blocked"
    : category === "duplicate"
      ? "duplicate"
      : category === "sensitive"
        ? "sensitive"
        : category === "non-actionable"
          ? "non-actionable"
          : needsInfo
            ? "needs-info"
            : "completed";
  const nextRevision = existing === undefined ? 1 : existing.revision + 1;
  const brief = makeBrief(
    source,
    assessment,
    policy,
    base,
    nextRevision,
    existing?.createdAt ?? timestamp,
  );
  const record: TriageRecord = {
    id: existing?.id ?? brief.id,
    sourceKey: key,
    source,
    sourceUpdatedAt: source.updatedAt,
    sourceFingerprint: fingerprint,
    revision: nextRevision,
    category,
    outcome,
    assessment,
    brief,
    questions,
    clarificationIds:
      clarificationReply === undefined
        ? (existing?.clarificationIds ?? [])
        : [...(existing?.clarificationIds ?? []), clarificationReply.id],
    duplicateOf: duplicateId,
    publicMessage: publicMessage(outcome, category, questions, duplicateId),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
  store.save(record);
  return resultFromRecord(record, policy);
};

export { defaultInvestigator as defaultTriageInvestigator };
