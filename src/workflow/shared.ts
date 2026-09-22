import type { RevisionReference } from "./contracts/index.js";

export const sameRevision = (
  left: RevisionReference,
  right: RevisionReference,
): boolean => left.branch === right.branch && left.sha === right.sha;

export const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
};
