import {
  createWorkBrief,
  isAuthorizationAllowed,
  type RepositoryPolicy,
  type RiskLevel,
  type RevisionReference,
  type WorkBrief,
  type WorkItemKind,
} from "../contracts/index.js";
import type { PostgresQueryClient } from "../coordinator/postgres-storage.js";
import { PostgresWorkflowPhaseRecordStore } from "../phase-storage.js";
import {
  normalizeAssessment,
  normalizeClarificationReply,
  normalizeSource,
  parseTriageRecord,
  sourceFingerprint,
  sourceKey,
  sourceKind,
} from "./persistence.js";
import { reconcileTriageSource } from "./reconciliation.js";

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

export interface TriageSourceConflict {
  readonly fingerprint: string;
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
  readonly pendingClarificationReplies?: readonly ClarificationReply[];
  readonly sourceConflict?: TriageSourceConflict;
  readonly duplicateOf?: string;
  readonly publicMessage: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TriageStore {
  get(
    sourceKey: string,
  ): TriageRecord | undefined | Promise<TriageRecord | undefined>;
  /**
   * Atomically save only when the stored revision still matches the read
   * revision. Custom stores must implement this as one compare-and-save.
   */
  compareAndSave(
    record: TriageRecord,
    expectedRevision: number | undefined,
  ): boolean | Promise<boolean>;
}

export class InMemoryTriageStore implements TriageStore {
  private readonly records = new Map<string, TriageRecord>();

  get(sourceKey: string): TriageRecord | undefined {
    const record = this.records.get(sourceKey);
    return record === undefined ? undefined : clone(record);
  }

  compareAndSave(
    record: TriageRecord,
    expectedRevision: number | undefined,
  ): boolean {
    const current = this.records.get(record.sourceKey);
    if (current?.revision !== expectedRevision) return false;
    this.records.set(record.sourceKey, clone(record));
    return true;
  }
}

export interface PostgresTriageStoreOptions {
  readonly client: PostgresQueryClient;
}

/** Durable triage records backed by the coordinator's PostgreSQL database. */
export class PostgresTriageStore implements TriageStore {
  private readonly records: PostgresWorkflowPhaseRecordStore;

  constructor(options: PostgresTriageStoreOptions) {
    this.records = new PostgresWorkflowPhaseRecordStore(options);
  }

  async get(sourceKey: string): Promise<TriageRecord | undefined> {
    const record = await this.records.get("triage", sourceKey);
    return record === undefined ? undefined : parseTriageRecord(record);
  }

  compareAndSave(
    record: TriageRecord,
    expectedRevision: number | undefined,
  ): Promise<boolean> {
    return this.records.compareAndSaveTriage(
      record.sourceKey,
      expectedRevision,
      record,
      record.updatedAt,
    );
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
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const MAX_TRIAGE_WRITE_CONFLICT_RETRIES = 5;

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

const outcomeForAssessment = (
  source: TriageSource,
  assessment: TriageAssessment,
): TriageOutcome => {
  const category = assessment.category;
  const questions = assessment.unresolvedQuestions;
  if (sourceKind(source) !== "executable-issue") return "blocked";
  if (category === "duplicate") return "duplicate";
  if (category === "sensitive") return "sensitive";
  if (category === "non-actionable") return "non-actionable";
  return !assessment.requirementsConfirmed ||
    questions.length > 0 ||
    assessment.acceptanceCriteria.length === 0
    ? "needs-info"
    : "completed";
};

const sourceConflictMessage = (hasPendingReplies: boolean): string =>
  hasPendingReplies
    ? "Triage is blocked because the source update cannot be ordered against the saved revision; the clarification reply is saved and will be applied after the source is refreshed."
    : "Triage is blocked because the source update cannot be ordered against the saved revision; refresh the source before triage can continue.";

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
  const incomingReply =
    clarificationReply === undefined
      ? undefined
      : normalizeClarificationReply(clarificationReply);
  const key = sourceKey(source);
  const fingerprint = sourceFingerprint(source);
  for (
    let conflictAttempt = 0;
    conflictAttempt <= MAX_TRIAGE_WRITE_CONFLICT_RETRIES;
    conflictAttempt += 1
  ) {
    const existing = await store.get(key);
    const reconciliation = reconcileTriageSource({
      source,
      sourceFingerprint: fingerprint,
      existing,
      incomingReply,
    });
    if (reconciliation.kind === "unchanged") {
      return resultFromRecord(reconciliation.record, policy);
    }
    if (reconciliation.kind === "source-conflict") {
      const { existing, sourceConflict, pendingReplies } = reconciliation;
      const timestamp = now();
      const record: TriageRecord = {
        id: existing.id,
        sourceKey: key,
        source: existing.source,
        sourceUpdatedAt: existing.sourceUpdatedAt,
        sourceFingerprint: existing.sourceFingerprint,
        revision: existing.revision + 1,
        category: existing.category,
        outcome: "blocked",
        assessment: existing.assessment,
        questions: [],
        clarificationIds: existing.clarificationIds,
        ...(pendingReplies.length === 0
          ? {}
          : { pendingClarificationReplies: pendingReplies }),
        sourceConflict,
        publicMessage: sourceConflictMessage(pendingReplies.length > 0),
        duplicateOf: existing.duplicateOf,
        createdAt: existing.createdAt,
        updatedAt: timestamp,
      };
      if (await store.compareAndSave(record, existing.revision)) {
        return resultFromRecord(record, policy);
      }
      continue;
    }
    const {
      source: currentSource,
      sourceFingerprint: currentFingerprint,
      pendingReplies: currentPendingReplies,
    } = reconciliation;

    const timestamp = now();
    let assessment: TriageAssessment | undefined;
    try {
      let previous = existing;
      if (currentPendingReplies.length === 0) {
        assessment = normalizeAssessment(
          await investigate(investigator, {
            source: currentSource,
            policy,
            base,
            previous,
          }),
        );
      } else {
        for (const [index, reply] of currentPendingReplies.entries()) {
          assessment = normalizeAssessment(
            await investigate(investigator, {
              source: currentSource,
              policy,
              base,
              previous,
              clarificationReply: reply,
            }),
          );
          const processedReplyIds = currentPendingReplies
            .slice(0, index + 1)
            .map(({ id }) => id);
          const remainingReplies = currentPendingReplies.slice(index + 1);
          const previousOutcome = outcomeForAssessment(
            currentSource,
            assessment,
          );
          const previousCategory = assessment.category;
          const previousDuplicateId = safeDuplicateId(assessment.duplicateOf);
          previous = {
            id:
              existing?.id ??
              `${currentSource.repository}:${sourceKind(currentSource)}:${currentSource.itemId}`,
            sourceKey: key,
            source: currentSource,
            sourceUpdatedAt: currentSource.updatedAt,
            sourceFingerprint: currentFingerprint,
            revision: existing?.revision ?? 1,
            category: previousCategory,
            outcome: previousOutcome,
            assessment,
            questions: assessment.unresolvedQuestions,
            clarificationIds: [
              ...(existing?.clarificationIds ?? []),
              ...processedReplyIds,
            ],
            ...(remainingReplies.length === 0
              ? {}
              : { pendingClarificationReplies: remainingReplies }),
            duplicateOf: previousDuplicateId,
            publicMessage: publicMessage(
              previousOutcome,
              previousCategory,
              assessment.unresolvedQuestions,
              previousDuplicateId,
            ),
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          };
        }
      }
    } catch {
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
          `${currentSource.repository}:${sourceKind(currentSource)}:${currentSource.itemId}`,
        sourceKey: key,
        source: currentSource,
        sourceUpdatedAt: currentSource.updatedAt,
        sourceFingerprint: currentFingerprint,
        revision: existing === undefined ? 1 : existing.revision + 1,
        category: failedAssessment.category,
        outcome: "failed",
        assessment: failedAssessment,
        questions: [],
        clarificationIds: existing?.clarificationIds ?? [],
        ...(currentPendingReplies.length === 0
          ? {}
          : { pendingClarificationReplies: currentPendingReplies }),
        publicMessage: publicMessage("failed", failedAssessment.category, []),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      };
      if (await store.compareAndSave(record, existing?.revision)) {
        return resultFromRecord(record, policy);
      }
      continue;
    }

    if (assessment === undefined) {
      throw new Error("Triage investigator returned no assessment");
    }
    const questions = assessment.unresolvedQuestions;
    const category = assessment.category;
    const duplicateId = safeDuplicateId(assessment.duplicateOf);
    const outcome = outcomeForAssessment(currentSource, assessment);
    const nextRevision = existing === undefined ? 1 : existing.revision + 1;
    const brief = makeBrief(
      currentSource,
      assessment,
      policy,
      base,
      nextRevision,
      existing?.createdAt ?? timestamp,
    );
    const record: TriageRecord = {
      id: existing?.id ?? brief.id,
      sourceKey: key,
      source: currentSource,
      sourceUpdatedAt: currentSource.updatedAt,
      sourceFingerprint: currentFingerprint,
      revision: nextRevision,
      category,
      outcome,
      assessment,
      brief,
      questions,
      clarificationIds: [
        ...(existing?.clarificationIds ?? []),
        ...currentPendingReplies.map(({ id }) => id),
      ],
      duplicateOf: duplicateId,
      publicMessage: publicMessage(outcome, category, questions, duplicateId),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    if (await store.compareAndSave(record, existing?.revision)) {
      return resultFromRecord(record, policy);
    }
  }
  throw new Error(
    `Triage record for ${source.repository} item ${source.itemId} changed during ${MAX_TRIAGE_WRITE_CONFLICT_RETRIES + 1} consecutive updates`,
  );
};

export { defaultInvestigator as defaultTriageInvestigator };
