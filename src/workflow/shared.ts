import type {
  Finding,
  RepositoryPolicy,
  RevisionReference,
  WorkIdentity,
} from "./contracts/index.js";

export const sameWorkIdentity = (
  left: WorkIdentity,
  right: WorkIdentity,
): boolean =>
  left.repository === right.repository &&
  left.itemId === right.itemId &&
  left.kind === right.kind;

export const sameRevision = (
  left: RevisionReference,
  right: RevisionReference,
): boolean => left.branch === right.branch && left.sha === right.sha;

export const isBlockingFinding = (finding: Finding): boolean =>
  finding.severity !== "info" &&
  (finding.disposition === "open" || finding.disposition === "deferred");

export const requiredCheckNames = (
  policy: RepositoryPolicy,
): readonly string[] =>
  policy.checks.filter((check) => check.required).map((check) => check.name);

export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};
