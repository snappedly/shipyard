import { createHash } from "node:crypto";
import {
  parseWorkBrief,
  type RiskLevel,
  type WorkBrief,
  type WorkItemKind,
} from "../contracts/index.js";
import type {
  ClarificationReply,
  TriageAssessment,
  TriageCategory,
  TriageOutcome,
  TriageRecord,
  TriageSource,
} from "./index.js";

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

export const sourceKind = (source: TriageSource): WorkItemKind =>
  source.kind ?? "executable-issue";

export const sourceKey = (source: TriageSource): string =>
  [source.repository, source.itemId, sourceKind(source)].join("\u0000");

export const sourceFingerprint = (source: TriageSource): string =>
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

export const sourceTimestampOrder = (
  candidateUpdatedAt: string,
  storedUpdatedAt: string,
): "older" | "same" | "newer" | "unknown" => {
  const candidateTime = Date.parse(candidateUpdatedAt);
  const storedTime = Date.parse(storedUpdatedAt);
  if (!Number.isFinite(candidateTime) || !Number.isFinite(storedTime)) {
    return "unknown";
  }
  return candidateTime < storedTime
    ? "older"
    : candidateTime > storedTime
      ? "newer"
      : "same";
};

const storedObject = (
  value: unknown,
  path: string,
): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
};

const parseStoredSource = (value: unknown): TriageSource => {
  const source = storedObject(value, "triage.source");
  const provider = source.provider;
  if (provider !== "github" && provider !== "slack" && provider !== "manual") {
    throw new Error("triage.source.provider is invalid");
  }
  const allowedKinds: readonly WorkItemKind[] = [
    "planning-spec",
    "executable-issue",
    "pr-repair",
  ];
  const kind = source.kind ?? "executable-issue";
  if (
    typeof kind !== "string" ||
    !allowedKinds.includes(kind as WorkItemKind)
  ) {
    throw new Error("triage.source.kind is invalid");
  }
  if (typeof source.body !== "string") {
    throw new Error("triage.source.body must be a string");
  }
  if (source.labels !== undefined && !Array.isArray(source.labels)) {
    throw new Error("triage.source.labels must be an array");
  }
  return normalizeSource({
    provider,
    repository: nonEmpty(source.repository, "triage.source.repository"),
    itemId: nonEmpty(source.itemId, "triage.source.itemId"),
    title: nonEmpty(source.title, "triage.source.title"),
    body: source.body,
    author: optionalNonEmpty(source.author, "triage.source.author"),
    url: optionalNonEmpty(source.url, "triage.source.url"),
    updatedAt: nonEmpty(source.updatedAt, "triage.source.updatedAt"),
    kind: kind as WorkItemKind,
    labels: stringArray(source.labels ?? [], "triage.source.labels"),
  });
};

const parseClarificationReply = (
  value: unknown,
  path: string,
): ClarificationReply => {
  const reply = storedObject(value, path);
  if (typeof reply.body !== "string") {
    throw new Error(`${path}.body must be a string`);
  }
  return {
    id: nonEmpty(reply.id, `${path}.id`),
    body: reply.body,
    author: optionalNonEmpty(reply.author, `${path}.author`),
    updatedAt: nonEmpty(reply.updatedAt, `${path}.updatedAt`),
  };
};

export const normalizeClarificationReply = (
  reply: ClarificationReply,
): ClarificationReply => parseClarificationReply(reply, "clarificationReply");

export const parseTriageRecord = (value: unknown): TriageRecord => {
  const record = storedObject(value, "triage record");
  const source = parseStoredSource(record.source);
  const assessment = normalizeAssessment(record.assessment);
  const outcome = record.outcome;
  const outcomes: readonly TriageOutcome[] = [
    "completed",
    "needs-info",
    "duplicate",
    "sensitive",
    "non-actionable",
    "blocked",
    "failed",
  ];
  if (
    typeof outcome !== "string" ||
    !outcomes.includes(outcome as TriageOutcome)
  ) {
    throw new Error("triage.outcome is invalid");
  }
  if (!isCategory(record.category))
    throw new Error("triage.category is invalid");
  const revision = record.revision;
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 1
  ) {
    throw new Error("triage.revision must be a positive integer");
  }
  const parsedBrief =
    record.brief === undefined ? undefined : parseWorkBrief(record.brief);
  const clarificationIds = stringArray(
    record.clarificationIds,
    "triage.clarificationIds",
  );
  const pendingClarificationReplies =
    record.pendingClarificationReplies === undefined
      ? []
      : (() => {
          if (!Array.isArray(record.pendingClarificationReplies)) {
            throw new Error(
              "triage.pendingClarificationReplies must be an array",
            );
          }
          return record.pendingClarificationReplies.map((reply, index) =>
            parseClarificationReply(
              reply,
              `triage.pendingClarificationReplies[${index}]`,
            ),
          );
        })();
  const sourceConflict =
    record.sourceConflict === undefined
      ? undefined
      : (() => {
          const conflict = storedObject(
            record.sourceConflict,
            "triage.sourceConflict",
          );
          const fingerprint = nonEmpty(
            conflict.fingerprint,
            "triage.sourceConflict.fingerprint",
          );
          if (!/^[0-9a-f]{64}$/.test(fingerprint)) {
            throw new Error("triage.sourceConflict.fingerprint is invalid");
          }
          return {
            fingerprint,
            updatedAt: nonEmpty(
              conflict.updatedAt,
              "triage.sourceConflict.updatedAt",
            ),
          };
        })();
  const pendingIds = pendingClarificationReplies.map(({ id }) => id);
  if (
    new Set(pendingIds).size !== pendingIds.length ||
    pendingIds.some((id) => clarificationIds.includes(id))
  ) {
    throw new Error("Stored triage clarification replies are not unique");
  }
  const parsed: TriageRecord = {
    id: nonEmpty(record.id, "triage.id"),
    sourceKey: nonEmpty(record.sourceKey, "triage.sourceKey"),
    source,
    sourceUpdatedAt: nonEmpty(record.sourceUpdatedAt, "triage.sourceUpdatedAt"),
    sourceFingerprint: nonEmpty(
      record.sourceFingerprint,
      "triage.sourceFingerprint",
    ),
    revision,
    category: record.category,
    outcome: outcome as TriageOutcome,
    assessment,
    brief: parsedBrief,
    questions: stringArray(record.questions, "triage.questions"),
    clarificationIds,
    ...(pendingClarificationReplies.length === 0
      ? {}
      : { pendingClarificationReplies }),
    ...(sourceConflict === undefined ? {} : { sourceConflict }),
    duplicateOf: optionalNonEmpty(record.duplicateOf, "triage.duplicateOf"),
    publicMessage: nonEmpty(record.publicMessage, "triage.publicMessage"),
    createdAt: nonEmpty(record.createdAt, "triage.createdAt"),
    updatedAt: nonEmpty(record.updatedAt, "triage.updatedAt"),
  };
  if (parsed.sourceKey !== sourceKey(source)) {
    throw new Error("Stored triage source key does not match its source");
  }
  if (parsed.sourceUpdatedAt !== source.updatedAt) {
    throw new Error("Stored triage source timestamp does not match its source");
  }
  if (parsed.sourceFingerprint !== sourceFingerprint(source)) {
    throw new Error("Stored triage fingerprint does not match its source");
  }
  if (parsed.category !== assessment.category) {
    throw new Error("Stored triage category does not match its assessment");
  }
  if (
    sourceConflict !== undefined &&
    (parsed.outcome !== "blocked" ||
      parsedBrief !== undefined ||
      sourceConflict.fingerprint === parsed.sourceFingerprint)
  ) {
    throw new Error("Stored triage source conflict is inconsistent");
  }
  if (
    parsedBrief !== undefined &&
    (parsedBrief.revision !== revision ||
      parsedBrief.identity.repository !== source.repository ||
      parsedBrief.identity.itemId !== source.itemId ||
      parsedBrief.identity.kind !== sourceKind(source))
  ) {
    throw new Error("Stored triage brief does not match its source revision");
  }
  return parsed;
};

export const normalizeSource = (source: TriageSource): TriageSource => ({
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

export const normalizeAssessment = (value: unknown): TriageAssessment => {
  const assessment = storedObject(value, "assessment");
  if (!isCategory(assessment.category))
    throw new Error("assessment.category is invalid");
  if (!isRisk(assessment.risk)) throw new Error("assessment.risk is invalid");
  if (typeof assessment.requirementsConfirmed !== "boolean") {
    throw new Error("assessment.requirementsConfirmed must be a boolean");
  }
  const duplicateOf = optionalNonEmpty(
    assessment.duplicateOf,
    "assessment.duplicateOf",
  );
  const sensitiveReason = optionalNonEmpty(
    assessment.sensitiveReason,
    "assessment.sensitiveReason",
  );
  return {
    category: assessment.category,
    evidence: stringArray(assessment.evidence, "assessment.evidence"),
    relevantFiles: stringArray(
      assessment.relevantFiles,
      "assessment.relevantFiles",
    ),
    acceptanceCriteria: stringArray(
      assessment.acceptanceCriteria,
      "assessment.acceptanceCriteria",
    ),
    exclusions: stringArray(assessment.exclusions, "assessment.exclusions"),
    risk: assessment.risk,
    verification: stringArray(
      assessment.verification,
      "assessment.verification",
    ),
    unresolvedQuestions: stringArray(
      assessment.unresolvedQuestions,
      "assessment.unresolvedQuestions",
    ),
    requirementsConfirmed: assessment.requirementsConfirmed,
    duplicateOf,
    sensitiveReason,
  };
};
