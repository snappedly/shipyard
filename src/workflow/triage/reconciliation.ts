import type {
  ClarificationReply,
  TriageRecord,
  TriageSource,
  TriageSourceConflict,
} from "./index.js";
import { sourceTimestampOrder } from "./persistence.js";

type Reconciliation =
  | { readonly kind: "unchanged"; readonly record: TriageRecord }
  | {
      readonly kind: "source-conflict";
      readonly existing: TriageRecord;
      readonly sourceConflict: TriageSourceConflict;
      readonly pendingReplies: readonly ClarificationReply[];
    }
  | {
      readonly kind: "investigate";
      readonly source: TriageSource;
      readonly sourceFingerprint: string;
      readonly pendingReplies: readonly ClarificationReply[];
    };

export const reconcileTriageSource = (input: {
  readonly source: TriageSource;
  readonly sourceFingerprint: string;
  readonly existing?: TriageRecord;
  readonly incomingReply?: ClarificationReply;
}): Reconciliation => {
  const { source, sourceFingerprint, existing, incomingReply } = input;
  const timestampOrder =
    existing === undefined
      ? "newer"
      : sourceTimestampOrder(source.updatedAt, existing.sourceUpdatedAt);
  const sourceChanged =
    existing !== undefined && existing.sourceFingerprint !== sourceFingerprint;
  const sourceTimestampAmbiguous =
    sourceChanged && timestampOrder !== "older" && timestampOrder !== "newer";
  const replyAlreadyApplied =
    incomingReply !== undefined &&
    (existing?.clarificationIds.includes(incomingReply.id) ?? false);
  const storedReplies = existing?.pendingClarificationReplies ?? [];
  const pendingIds = new Set(storedReplies.map(({ id }) => id));
  const newReply =
    incomingReply !== undefined &&
    !replyAlreadyApplied &&
    !pendingIds.has(incomingReply.id)
      ? incomingReply
      : undefined;
  const pendingReplies =
    newReply === undefined ? [...storedReplies] : [...storedReplies, newReply];
  const priorConflictIsUnresolved =
    existing?.sourceConflict !== undefined && timestampOrder !== "newer";

  if (
    existing !== undefined &&
    (sourceTimestampAmbiguous || priorConflictIsUnresolved)
  ) {
    const sourceConflict = sourceTimestampAmbiguous
      ? { fingerprint: sourceFingerprint, updatedAt: source.updatedAt }
      : existing.sourceConflict!;
    if (
      existing.sourceConflict?.fingerprint === sourceConflict.fingerprint &&
      existing.outcome === "blocked" &&
      existing.brief === undefined &&
      newReply === undefined
    ) {
      return { kind: "unchanged", record: existing };
    }
    return {
      kind: "source-conflict",
      existing,
      sourceConflict,
      pendingReplies,
    };
  }

  // Older snapshots cannot replace current content. Their new replies can
  // still be applied to the saved source below.
  const storedSnapshotWins =
    existing !== undefined &&
    (existing.sourceFingerprint === sourceFingerprint ||
      timestampOrder !== "newer");
  const currentSource = storedSnapshotWins ? existing.source : source;
  const currentFingerprint = storedSnapshotWins
    ? existing.sourceFingerprint
    : sourceFingerprint;
  if (
    existing !== undefined &&
    pendingReplies.length === 0 &&
    existing.sourceFingerprint === currentFingerprint
  ) {
    return { kind: "unchanged", record: existing };
  }
  return {
    kind: "investigate",
    source: currentSource,
    sourceFingerprint: currentFingerprint,
    pendingReplies,
  };
};
