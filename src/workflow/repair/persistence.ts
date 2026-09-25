import { createHash } from "node:crypto";
import {
  parseWorkBrief,
  type Finding,
  type RevisionReference,
} from "../contracts/index.js";
import type { EffectIntent, EffectStatus } from "../coordinator/index.js";
import type {
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubPublicationResult,
} from "../../integrations/github/index.js";
import type { RepairBatch, RepairBatchResult } from "./index.js";

const object = (value: unknown, path: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
};

const string = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
};

const optionalString = (value: unknown, path: string): string | undefined =>
  value === undefined ? undefined : string(value, path);

const integer = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`${path} must be a safe integer`);
  }
  return value;
};

const positiveInteger = (value: unknown, path: string): number => {
  const parsed = integer(value, path);
  if (parsed < 1) throw new Error(`${path} must be positive`);
  return parsed;
};

const optionalPositiveInteger = (
  value: unknown,
  path: string,
): number | undefined =>
  value === undefined ? undefined : positiveInteger(value, path);

const optionalNumber = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
};

const stringArray = (value: unknown, path: string): string[] => {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => string(item, `${path}[${index}]`));
};

const enumValue = <T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
): T => {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    throw new Error(`${path} is invalid`);
  }
  return value as T;
};

const parseRevision = (value: unknown, path: string): RevisionReference => {
  const revision = object(value, path);
  return {
    branch: string(revision.branch, `${path}.branch`),
    sha: string(revision.sha, `${path}.sha`),
  };
};

const parseFinding = (value: unknown): Finding => {
  const finding = object(value, "finding");
  return {
    id: string(finding.id, "finding.id"),
    severity: enumValue(
      finding.severity,
      ["info", "low", "medium", "high", "critical"],
      "finding.severity",
    ),
    axis: enumValue(
      finding.axis,
      ["standards", "spec", "interface"],
      "finding.axis",
    ),
    disposition: enumValue(
      finding.disposition,
      ["open", "fixed", "rejected", "accepted", "deferred"],
      "finding.disposition",
    ),
    title: string(finding.title, "finding.title"),
    evidence: string(finding.evidence, "finding.evidence"),
    location: optionalString(finding.location, "finding.location"),
    requirement: optionalString(finding.requirement, "finding.requirement"),
    verification: optionalString(finding.verification, "finding.verification"),
  };
};

const parseEffect = (value: unknown): EffectIntent => {
  const effect = object(value, "publication.effect");
  return {
    id: string(effect.id, "effect.id"),
    jobId: string(effect.jobId, "effect.jobId"),
    kind: string(effect.kind, "effect.kind"),
    marker: string(effect.marker, "effect.marker"),
    payload: effect.payload,
    status: enumValue(
      effect.status,
      ["pending", "claimed", "succeeded", "uncertain", "failed", "cancelled"],
      "effect.status",
    ) as EffectStatus,
    externalRef: effect.externalRef,
    workerId: optionalString(effect.workerId, "effect.workerId"),
    fencingToken: optionalNumber(effect.fencingToken, "effect.fencingToken"),
    claimedAt: optionalNumber(effect.claimedAt, "effect.claimedAt"),
    claimExpiresAt: optionalNumber(
      effect.claimExpiresAt,
      "effect.claimExpiresAt",
    ),
    error: optionalString(effect.error, "effect.error"),
    createdAt: string(effect.createdAt, "effect.createdAt"),
    updatedAt: string(effect.updatedAt, "effect.updatedAt"),
  };
};

const parseIssue = (value: unknown): GitHubIssueSnapshot => {
  const issue = object(value, "GitHub issue");
  if (typeof issue.body !== "string") {
    throw new Error("issue.body must be a string");
  }
  return {
    number: positiveInteger(issue.number, "issue.number"),
    title: string(issue.title, "issue.title"),
    body: issue.body,
    state: enumValue(issue.state, ["open", "closed"], "issue.state"),
    updatedAt: string(issue.updatedAt, "issue.updatedAt"),
    htmlUrl: optionalString(issue.htmlUrl, "issue.htmlUrl"),
    authorLogin: optionalString(issue.authorLogin, "issue.authorLogin"),
    labels: stringArray(issue.labels, "issue.labels"),
    pullRequestNumber: optionalPositiveInteger(
      issue.pullRequestNumber,
      "issue.pullRequestNumber",
    ),
  };
};

const parseComment = (value: unknown): GitHubCommentSnapshot => {
  const comment = object(value, "GitHub comment");
  if (typeof comment.body !== "string") {
    throw new Error("comment.body must be a string");
  }
  return {
    id: string(comment.id, "comment.id"),
    body: comment.body,
    updatedAt: string(comment.updatedAt, "comment.updatedAt"),
    htmlUrl: optionalString(comment.htmlUrl, "comment.htmlUrl"),
    authorLogin: optionalString(comment.authorLogin, "comment.authorLogin"),
  };
};

const parsePublication = <T>(
  value: unknown,
  path: string,
  parseRemote: (value: unknown) => T,
): GitHubPublicationResult<T> => {
  const publication = object(value, path);
  const marker = string(publication.marker, `${path}.marker`);
  const disposition = enumValue(
    publication.disposition,
    ["published", "reconciled", "already-succeeded", "in-flight"],
    `${path}.disposition`,
  );
  const remote = publication.remote;
  const parsedRemote = remote === undefined ? undefined : parseRemote(remote);
  const effect = parseEffect(publication.effect);
  if (effect.marker !== marker) {
    throw new Error(`${path}.effect.marker does not match its marker`);
  }
  if (disposition === "in-flight") {
    if (effect.status !== "claimed" || parsedRemote !== undefined) {
      throw new Error(`${path} has an invalid in-flight publication state`);
    }
  } else {
    if (effect.status !== "succeeded" || parsedRemote === undefined) {
      throw new Error(`${path} has an invalid completed publication state`);
    }
    if (effect.externalRef === undefined) {
      throw new Error(`${path}.effect.externalRef is missing`);
    }
    const parsedExternalRef = parseRemote(effect.externalRef);
    if (JSON.stringify(parsedExternalRef) !== JSON.stringify(parsedRemote)) {
      throw new Error(`${path}.remote does not match its effect reference`);
    }
  }
  return {
    marker,
    remote: parsedRemote,
    disposition,
    effect,
  };
};

const markerHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const repairLinkMarker = (jobId: string, repairIssueUrl: string): string =>
  `repair-link:${encodeURIComponent(jobId)}:${markerHash(repairIssueUrl)}`;

const markerComment = (marker: string): string => `<!-- shipyard:${marker} -->`;

const parseBatch = (value: unknown): RepairBatch => {
  const batch = object(value, "repair.batch");
  const candidate = object(batch.candidate, "repair.batch.candidate");
  const brief = parseWorkBrief(batch.brief);
  if (!Array.isArray(batch.findings)) {
    throw new Error("repair.batch.findings must be an array");
  }
  if (typeof batch.followUp !== "boolean") {
    throw new Error("repair.batch.followUp must be boolean");
  }
  const parsed: RepairBatch = {
    id: string(batch.id, "repair.batch.id"),
    jobId: string(batch.jobId, "repair.batch.jobId"),
    sourceIssueNumber: optionalPositiveInteger(
      batch.sourceIssueNumber,
      "repair.batch.sourceIssueNumber",
    ),
    pullRequestNumber: optionalPositiveInteger(
      batch.pullRequestNumber,
      "repair.batch.pullRequestNumber",
    ),
    candidate: {
      base: parseRevision(candidate.base, "repair.batch.candidate.base"),
      head: parseRevision(candidate.head, "repair.batch.candidate.head"),
      briefHash: string(
        candidate.briefHash,
        "repair.batch.candidate.briefHash",
      ),
    },
    brief,
    findings: batch.findings.map(parseFinding),
    followUp: batch.followUp,
    createdAt: string(batch.createdAt, "repair.batch.createdAt"),
  };
  if (parsed.candidate.briefHash !== brief.hash) {
    throw new Error("Stored repair batch brief hash does not match its brief");
  }
  return parsed;
};

/** Parse the durable repair projection; coordinator jobs and leases are reacquired. */
export const parseRepairBatchResult = (value: unknown): RepairBatchResult => {
  const result = object(value, "repair batch result");
  const batch = parseBatch(result.batch);
  const repairIssue =
    result.repairIssue === undefined
      ? undefined
      : parseIssue(result.repairIssue);
  const issuePublication =
    result.issuePublication === undefined
      ? undefined
      : parsePublication(
          result.issuePublication,
          "issuePublication",
          parseIssue,
        );
  const linkPublication =
    result.linkPublication === undefined
      ? undefined
      : parsePublication(
          result.linkPublication,
          "linkPublication",
          parseComment,
        );
  if (issuePublication !== undefined) {
    if (
      issuePublication.effect.jobId !== batch.jobId ||
      issuePublication.effect.kind !== "github-repair-issue"
    ) {
      throw new Error(
        "Stored repair issue publication does not match its batch",
      );
    }
    const issueTitle = `[Shipyard] Repair PR #${batch.pullRequestNumber ?? batch.brief.identity.itemId}`;
    const expectedMarker = `repair-issue:${encodeURIComponent(batch.jobId)}:${markerHash(issueTitle)}`;
    const payload = object(
      issuePublication.effect.payload,
      "issuePublication.effect.payload",
    );
    if (
      issuePublication.marker !== expectedMarker ||
      string(payload.repository, "issuePublication.repository") !==
        batch.brief.identity.repository
    ) {
      throw new Error("Stored repair issue marker or repository is invalid");
    }
    if (
      issuePublication.remote !== undefined &&
      !issuePublication.remote.body.startsWith(
        `${markerComment(expectedMarker)}\n`,
      )
    ) {
      throw new Error("Stored repair issue has a different marker");
    }
    if (
      repairIssue !== undefined &&
      issuePublication.remote?.number !== repairIssue.number
    ) {
      throw new Error("Stored repair issue does not match its publication");
    }
  }
  if (linkPublication !== undefined) {
    if (
      batch.sourceIssueNumber === undefined ||
      linkPublication.effect.jobId !== batch.jobId ||
      linkPublication.effect.kind !== "github-repair-link"
    ) {
      throw new Error(
        "Stored repair link publication does not match its batch",
      );
    }
    const payload = object(
      linkPublication.effect.payload,
      "linkPublication.effect.payload",
    );
    if (
      positiveInteger(payload.issueNumber, "linkPublication.issueNumber") !==
        batch.sourceIssueNumber ||
      string(payload.repository, "linkPublication.repository") !==
        batch.brief.identity.repository
    ) {
      throw new Error(
        "Stored repair link publication targets a different issue",
      );
    }
    const repairIssueUrl = issuePublication?.remote?.htmlUrl;
    if (repairIssueUrl === undefined) {
      throw new Error("Stored repair link has no repair issue URL");
    }
    const expectedMarker = repairLinkMarker(batch.jobId, repairIssueUrl);
    if (linkPublication.marker !== expectedMarker) {
      throw new Error("Stored repair link marker does not match its issue URL");
    }
    if (
      linkPublication.remote !== undefined &&
      !linkPublication.remote.body.startsWith(
        `${markerComment(expectedMarker)}\n`,
      )
    ) {
      throw new Error("Stored repair link comment has a different marker");
    }
  }
  return {
    outcome: enumValue(
      result.outcome,
      ["scheduled", "duplicate", "blocked"],
      "repair.outcome",
    ),
    reason: optionalString(result.reason, "repair.reason"),
    batch,
    repairIssue,
    issuePublication,
    linkPublication,
  };
};
