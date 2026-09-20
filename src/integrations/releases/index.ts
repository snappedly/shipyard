import { createHash } from "node:crypto";

export type ReleaseEnvironment = "staging" | "production";
export type ReleaseCheckStatus = "passed" | "failed" | "missing" | "unknown";

export interface ReleaseCandidate {
  readonly sourceSha: string;
  readonly reviewedHeadSha: string;
  readonly briefHash: string;
  readonly artifactDigest: string;
  /** Provider-specific immutable locator; integrity is bound separately by artifactDigest. */
  readonly artifactRef: string;
  readonly version?: string;
}

export interface ReleasePolicy {
  readonly repository: string;
  readonly stagingName: string;
  readonly productionName: string;
  readonly requiredStagingChecks: readonly string[];
  readonly requireHumanApproval: boolean;
  /** Maximum age for a production approval before it must be renewed. */
  readonly approvalFreshnessSeconds?: number;
  /** Roles allowed to approve production; release coordinators may request but not approve. */
  readonly approvalRoles?: readonly ("owner" | "maintainer")[];
  /** Recovery is recorded as a requested action; it is never inferred or executed by default. */
  readonly recoveryMode: "roll-forward" | "rollback" | "owner-decision";
}

export interface ReleaseActor {
  readonly id: string;
  readonly role: "release-coordinator" | "owner" | "maintainer";
}

export interface ReleaseCheck {
  readonly name: string;
  readonly status: ReleaseCheckStatus;
  readonly summary: string;
}

export interface ReleaseVerification {
  readonly environment: ReleaseEnvironment;
  readonly candidate: ReleaseCandidate;
  readonly deploymentId: string;
  readonly checks: readonly ReleaseCheck[];
  readonly smoke: "passed" | "failed" | "missing" | "unknown";
  readonly health: "passed" | "failed" | "missing" | "unknown";
  readonly recordedAt: string;
  readonly failureReason?: string;
}

export interface ProductionApproval {
  readonly actor: ReleaseActor;
  readonly approvedAt: string;
  readonly candidate: ReleaseCandidate;
}

export type ReleaseStateStatus =
  | "staging-requested"
  | "staging-failed"
  | "staging-verified"
  | "production-approved"
  | "production-requested"
  | "production-failed"
  | "production-verified";

export interface ReleaseState {
  readonly key: string;
  readonly candidate: ReleaseCandidate;
  readonly status: ReleaseStateStatus;
  readonly staging?: ReleaseVerification;
  readonly approval?: ProductionApproval;
  readonly recovery?: RecoveryRecord;
  readonly production?: ReleaseVerification;
  readonly updatedAt: string;
}

export interface ReleaseStore {
  get(key: string): ReleaseState | undefined;
  save(state: ReleaseState): void;
}

export class InMemoryReleaseStore implements ReleaseStore {
  private readonly states = new Map<string, ReleaseState>();

  get(key: string): ReleaseState | undefined {
    const state = this.states.get(key);
    return state === undefined ? undefined : structuredClone(state);
  }

  save(state: ReleaseState): void {
    this.states.set(state.key, structuredClone(state));
  }
}

export interface ReleaseTransport {
  requestDeployment(input: {
    readonly environment: ReleaseEnvironment;
    readonly environmentName: string;
    readonly candidate: ReleaseCandidate;
    readonly actor: ReleaseActor;
    readonly idempotencyKey: string;
  }): Promise<{ readonly deploymentId: string }>;
  reconcileDeployment?(input: {
    readonly environment: ReleaseEnvironment;
    readonly environmentName: string;
    readonly candidate: ReleaseCandidate;
    readonly idempotencyKey: string;
  }): Promise<{ readonly deploymentId: string } | undefined>;
}

export interface ReleaseIntegrationOptions {
  readonly policy: ReleasePolicy;
  readonly store: ReleaseStore;
  readonly transport: ReleaseTransport;
  readonly actor: ReleaseActor;
  /** Validate a provider-specific immutable locator not covered by built-in formats. */
  readonly validateArtifactRef?: (
    candidate: ReleaseCandidate,
  ) => string | undefined;
  readonly now?: () => string;
}

export interface ReleaseOperationResult {
  readonly outcome:
    | "requested"
    | "duplicate"
    | "verified"
    | "approved"
    | "blocked"
    | "failed";
  readonly reason?: string;
  readonly state?: ReleaseState;
}

export interface RecoveryRecord {
  readonly candidate: ReleaseCandidate;
  readonly action: ReleasePolicy["recoveryMode"];
  readonly reason: string;
  readonly authorizedBy: ReleaseActor;
  readonly recordedAt: string;
}

const canonicalCandidate = (candidate: ReleaseCandidate): string =>
  JSON.stringify({
    artifactDigest: candidate.artifactDigest,
    artifactRef: candidate.artifactRef,
    briefHash: candidate.briefHash,
    reviewedHeadSha: candidate.reviewedHeadSha,
    sourceSha: candidate.sourceSha,
    version: candidate.version ?? "",
  });

export const releaseCandidateKey = (candidate: ReleaseCandidate): string =>
  createHash("sha256").update(canonicalCandidate(candidate)).digest("hex");

const sameCandidate = (
  left: ReleaseCandidate,
  right: ReleaseCandidate,
): boolean => releaseCandidateKey(left) === releaseCandidateKey(right);

const defaultNow = (): string => new Date().toISOString();

const isFreshTimestamp = (
  value: string,
  now: string,
  maxAgeSeconds: number,
): boolean => {
  const timestamp = Date.parse(value);
  const current = Date.parse(now);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(current) &&
    timestamp <= current &&
    current - timestamp <= maxAgeSeconds * 1000
  );
};

const approvalRoles = (
  policy: ReleasePolicy,
): readonly ("owner" | "maintainer")[] =>
  policy.approvalRoles ?? ["owner", "maintainer"];

const validCandidate = (
  candidate: ReleaseCandidate,
  validateArtifactRef?: ReleaseIntegrationOptions["validateArtifactRef"],
): string | undefined => {
  const fields: readonly [string, unknown][] = [
    ["sourceSha", candidate.sourceSha],
    ["reviewedHeadSha", candidate.reviewedHeadSha],
    ["briefHash", candidate.briefHash],
    ["artifactDigest", candidate.artifactDigest],
    ["artifactRef", candidate.artifactRef],
  ];
  const missing = fields.find(
    ([, value]) => typeof value !== "string" || value.trim().length === 0,
  );
  if (missing !== undefined) return `${missing[0]} is required`;
  const gitObject = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
  if (!gitObject.test(candidate.sourceSha)) {
    return "sourceSha must be a full Git object id";
  }
  if (!gitObject.test(candidate.reviewedHeadSha)) {
    return "reviewedHeadSha must be a full Git object id";
  }
  if (!/^[0-9a-f]{64}$/i.test(candidate.briefHash)) {
    return "briefHash must be a SHA-256 hash";
  }
  if (!/^sha256:[0-9a-f]{64}$/i.test(candidate.artifactDigest)) {
    return "artifactDigest must be a SHA-256 digest";
  }
  if (/[\s?#]/.test(candidate.artifactRef)) {
    return "artifactRef must not contain whitespace, a query, or a fragment";
  }
  const digestReference = candidate.artifactRef.match(
    /@sha256:([0-9a-f]{64})$/i,
  );
  if (digestReference !== null) {
    return digestReference[1]!.toLowerCase() ===
      candidate.artifactDigest.slice("sha256:".length).toLowerCase()
      ? undefined
      : "digest-qualified artifactRef must match artifactDigest";
  }
  const immutableNpmReference =
    /^npm:(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@v?\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i;
  const immutableGitReference =
    /^(?:git|github):[^\s/@]+\/[^\s@]+@[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
  if (
    immutableNpmReference.test(candidate.artifactRef) ||
    immutableGitReference.test(candidate.artifactRef)
  ) {
    return undefined;
  }
  if (validateArtifactRef !== undefined) {
    return validateArtifactRef(candidate);
  }
  return "artifactRef format is not proven immutable";
};

const isIntentDeploymentId = (deploymentId: string): boolean =>
  deploymentId.startsWith("intent:");

const requiredChecksPassed = (
  policy: ReleasePolicy,
  checks: readonly ReleaseCheck[],
): string[] => {
  const reasons: string[] = [];
  for (const required of policy.requiredStagingChecks) {
    const check = checks.find((candidate) => candidate.name === required);
    if (check === undefined)
      reasons.push(`Required staging check is missing: ${required}`);
    else if (check.status !== "passed") {
      reasons.push(`Required staging check ${required} is ${check.status}`);
    }
  }
  return reasons;
};

const verificationReasons = (
  policy: ReleasePolicy,
  verification: ReleaseVerification,
): string[] => [
  ...requiredChecksPassed(policy, verification.checks),
  ...(verification.smoke === "passed"
    ? []
    : [`Staging smoke is ${verification.smoke}`]),
  ...(verification.health === "passed"
    ? []
    : [`Staging health is ${verification.health}`]),
  ...(verification.failureReason ? [verification.failureReason] : []),
];

const blocked = (
  reason: string,
  state?: ReleaseState,
): ReleaseOperationResult => ({
  outcome: "blocked",
  reason,
  state,
});

export class ReleaseIntegration {
  private readonly policy: ReleasePolicy;
  private readonly store: ReleaseStore;
  private readonly transport: ReleaseTransport;
  private readonly actor: ReleaseActor;
  private readonly validateArtifactRef?: ReleaseIntegrationOptions["validateArtifactRef"];
  private readonly now: () => string;

  constructor(options: ReleaseIntegrationOptions) {
    if (options.policy.repository.trim().length === 0) {
      throw new Error("Release policy repository is required");
    }
    if (options.policy.stagingName.trim().length === 0) {
      throw new Error("Release policy staging environment is required");
    }
    if (options.policy.productionName.trim().length === 0) {
      throw new Error("Release policy production environment is required");
    }
    if (options.actor.id.trim().length === 0) {
      throw new Error("Release actor is required");
    }
    if (
      options.policy.approvalRoles?.some(
        (role) => role !== "owner" && role !== "maintainer",
      )
    ) {
      throw new Error("Release approval roles are invalid");
    }
    this.policy = structuredClone(options.policy);
    this.store = options.store;
    this.transport = options.transport;
    this.actor = options.actor;
    this.validateArtifactRef = options.validateArtifactRef;
    this.now = options.now ?? defaultNow;
  }

  // Bind evidence and remote idempotency to the deployment target and gate.
  // Candidate-only records from older versions deliberately do not authorize releases.
  private stateKey(candidate: ReleaseCandidate): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          candidate: releaseCandidateKey(candidate),
          repository: this.policy.repository,
          staging: this.policy.stagingName,
          production: this.policy.productionName,
          checks: [...this.policy.requiredStagingChecks].sort(),
          humanApproval: this.policy.requireHumanApproval,
          roles: [...approvalRoles(this.policy)].sort(),
          freshness: this.policy.approvalFreshnessSeconds ?? 300,
          recovery: this.policy.recoveryMode,
        }),
      )
      .digest("hex");
  }

  async requestStaging(
    candidate: ReleaseCandidate,
  ): Promise<ReleaseOperationResult> {
    const invalid = validCandidate(candidate, this.validateArtifactRef);
    if (invalid !== undefined)
      return blocked(`Invalid release candidate: ${invalid}`);
    const key = this.stateKey(candidate);
    const existing = this.store.get(key);
    const idempotencyKey = `shipyard:${key}:staging`;
    const intentId = `intent:${idempotencyKey}`;
    if (
      existing !== undefined &&
      (existing.status !== "staging-requested" ||
        existing.staging?.deploymentId !== intentId)
    ) {
      return { outcome: "duplicate", state: existing };
    }
    const timestamp = this.now();
    const intent: ReleaseState = existing ?? {
      key,
      candidate,
      status: "staging-requested",
      staging: {
        environment: "staging",
        candidate,
        deploymentId: intentId,
        checks: [],
        smoke: "unknown",
        health: "unknown",
        recordedAt: timestamp,
      },
      updatedAt: timestamp,
    };
    this.store.save(intent);
    const deployment = await this.requestDeployment(
      "staging",
      candidate,
      idempotencyKey,
    );
    if (deployment === undefined) {
      return {
        outcome: "failed",
        reason: "Staging deployment could not be requested",
        state: this.store.get(key),
      };
    }
    const updated: ReleaseState = {
      ...intent,
      staging: {
        ...intent.staging!,
        deploymentId: deployment.deploymentId,
        recordedAt: this.now(),
      },
      updatedAt: this.now(),
    };
    this.store.save(updated);
    return { outcome: "requested", state: updated };
  }

  recordStagingVerification(
    verification: ReleaseVerification,
  ): ReleaseOperationResult {
    const invalid = validCandidate(
      verification.candidate,
      this.validateArtifactRef,
    );
    if (invalid !== undefined)
      return blocked(`Invalid release candidate: ${invalid}`);
    if (verification.environment !== "staging")
      return blocked("Verification is not for staging");
    const key = this.stateKey(verification.candidate);
    const state = this.store.get(key);
    if (state === undefined)
      return blocked("Staging deployment was not requested");
    if (
      state.staging === undefined ||
      isIntentDeploymentId(state.staging.deploymentId)
    ) {
      return blocked(
        "Staging deployment request has not been confirmed",
        state,
      );
    }
    if (state.staging?.deploymentId !== verification.deploymentId) {
      return blocked(
        "Staging verification references a different deployment",
        state,
      );
    }
    if (state.status === "production-failed") {
      return blocked(
        "Production verification failed; recovery is required before staging can be recorded",
        state,
      );
    }
    if (!sameCandidate(state.candidate, verification.candidate)) {
      return blocked(
        "Staging verification references a different candidate",
        state,
      );
    }
    const reasons = verificationReasons(this.policy, verification);
    const updated: ReleaseState = {
      ...state,
      status: reasons.length === 0 ? "staging-verified" : "staging-failed",
      staging: structuredClone(verification),
      updatedAt: this.now(),
    };
    this.store.save(updated);
    return reasons.length === 0
      ? { outcome: "verified", state: updated }
      : { outcome: "failed", reason: reasons.join("; "), state: updated };
  }

  approveProduction(input: {
    readonly candidate: ReleaseCandidate;
    readonly approval: ProductionApproval;
  }): ReleaseOperationResult {
    const invalid = validCandidate(input.candidate, this.validateArtifactRef);
    if (invalid !== undefined)
      return blocked(`Invalid release candidate: ${invalid}`);
    const key = this.stateKey(input.candidate);
    const state = this.store.get(key);
    if (state === undefined)
      return blocked("Candidate has no staging release state");
    if (state.status !== "staging-verified") {
      if (state.status === "production-approved") {
        return { outcome: "duplicate", state };
      }
      return blocked("Production approval requires verified staging", state);
    }
    if (!this.policy.requireHumanApproval) {
      return blocked(
        "Production approval policy is not configured for a human gate",
        state,
      );
    }
    if (!sameCandidate(input.candidate, input.approval.candidate)) {
      return blocked(
        "Production approval does not match the exact candidate",
        state,
      );
    }
    if (input.approval.actor.id.trim().length === 0) {
      return blocked("Production approval actor is missing", state);
    }
    const actorRole = input.approval.actor.role;
    if (actorRole === "release-coordinator") {
      return blocked(
        "Production approval requires an owner or maintainer",
        state,
      );
    }
    if (!approvalRoles(this.policy).includes(actorRole)) {
      return blocked(
        "Production approval role is not allowed by release policy",
        state,
      );
    }
    if (input.approval.approvedAt.trim().length === 0) {
      return blocked("Production approval timestamp is missing", state);
    }
    const approvalFreshnessSeconds =
      this.policy.approvalFreshnessSeconds ?? 300;
    if (
      !Number.isFinite(approvalFreshnessSeconds) ||
      approvalFreshnessSeconds <= 0
    ) {
      return blocked("Production approval freshness policy is invalid", state);
    }
    if (
      !isFreshTimestamp(
        input.approval.approvedAt,
        this.now(),
        approvalFreshnessSeconds,
      )
    ) {
      return blocked("Production approval evidence is not fresh", state);
    }
    const updated: ReleaseState = {
      ...state,
      status: "production-approved",
      approval: structuredClone(input.approval),
      updatedAt: this.now(),
    };
    this.store.save(updated);
    return { outcome: "approved", state: updated };
  }

  async promoteProduction(
    candidate: ReleaseCandidate,
  ): Promise<ReleaseOperationResult> {
    const invalid = validCandidate(candidate, this.validateArtifactRef);
    if (invalid !== undefined)
      return blocked(`Invalid release candidate: ${invalid}`);
    const key = this.stateKey(candidate);
    const state = this.store.get(key);
    if (state === undefined) return blocked("Candidate has no release state");
    const idempotencyKey = `shipyard:${key}:production`;
    const intentId = `intent:${idempotencyKey}`;
    if (state.status === "production-verified") {
      return { outcome: "duplicate", state };
    }
    const pendingIntent =
      state.status === "production-requested" &&
      state.production?.deploymentId === intentId;
    if (state.status === "production-requested" && !pendingIntent) {
      return { outcome: "duplicate", state };
    }
    if (state.status === "production-failed") {
      return blocked(
        "Production verification failed; recovery decision is required",
        state,
      );
    }
    if (
      !pendingIntent &&
      (state.status !== "production-approved" || state.approval === undefined)
    ) {
      return blocked(
        "Production promotion requires exact human approval after staging",
        state,
      );
    }
    if (
      state.approval === undefined ||
      !sameCandidate(candidate, state.approval.candidate)
    ) {
      return blocked("Production approval is stale for this candidate", state);
    }
    const approvalFreshnessSeconds =
      this.policy.approvalFreshnessSeconds ?? 300;
    if (
      !Number.isFinite(approvalFreshnessSeconds) ||
      approvalFreshnessSeconds <= 0
    ) {
      return blocked("Production approval freshness policy is invalid", state);
    }
    if (
      !isFreshTimestamp(
        state.approval.approvedAt,
        this.now(),
        approvalFreshnessSeconds,
      )
    ) {
      return blocked("Production approval evidence is not fresh", state);
    }
    const intent = pendingIntent
      ? state
      : {
          ...state,
          status: "production-requested" as const,
          production: {
            environment: "production" as const,
            candidate,
            deploymentId: intentId,
            checks: [],
            smoke: "unknown" as const,
            health: "unknown" as const,
            recordedAt: this.now(),
          },
          updatedAt: this.now(),
        };
    if (!pendingIntent) this.store.save(intent);
    const deployment = await this.requestDeployment(
      "production",
      candidate,
      idempotencyKey,
    );
    if (deployment === undefined) {
      return {
        outcome: "failed",
        reason: "Production deployment could not be requested",
        state: this.store.get(key),
      };
    }
    const updated: ReleaseState = {
      ...intent,
      production: {
        ...intent.production!,
        deploymentId: deployment.deploymentId,
        recordedAt: this.now(),
      },
      updatedAt: this.now(),
    };
    this.store.save(updated);
    return { outcome: "requested", state: updated };
  }

  private async requestDeployment(
    environment: ReleaseEnvironment,
    candidate: ReleaseCandidate,
    idempotencyKey: string,
  ): Promise<{ readonly deploymentId: string } | undefined> {
    const environmentName =
      environment === "staging"
        ? this.policy.stagingName
        : this.policy.productionName;
    let reconciled: { readonly deploymentId: string } | undefined;
    try {
      reconciled = this.transport.reconcileDeployment
        ? await this.transport.reconcileDeployment({
            environment,
            environmentName,
            candidate,
            idempotencyKey,
          })
        : undefined;
    } catch {
      reconciled = undefined;
    }
    if (reconciled !== undefined) {
      return reconciled.deploymentId.trim().length > 0 ? reconciled : undefined;
    }
    try {
      const deployment = await this.transport.requestDeployment({
        environment,
        environmentName,
        candidate,
        actor: this.actor,
        idempotencyKey,
      });
      if (deployment.deploymentId.trim().length === 0) {
        return undefined;
      }
      return deployment;
    } catch {
      return undefined;
    }
  }

  recordProductionVerification(
    verification: ReleaseVerification,
  ): ReleaseOperationResult {
    const invalid = validCandidate(
      verification.candidate,
      this.validateArtifactRef,
    );
    if (invalid !== undefined)
      return blocked(`Invalid release candidate: ${invalid}`);
    if (verification.environment !== "production")
      return blocked("Verification is not for production");
    const key = this.stateKey(verification.candidate);
    const state = this.store.get(key);
    if (state === undefined || state.production === undefined) {
      return blocked("Production deployment was not requested");
    }
    if (isIntentDeploymentId(state.production.deploymentId)) {
      return blocked(
        "Production deployment request has not been confirmed",
        state,
      );
    }
    if (state.status === "production-failed") {
      return blocked(
        "Production verification already failed; record recovery before any new candidate",
        state,
      );
    }
    if (
      state.production.deploymentId !== verification.deploymentId ||
      !sameCandidate(state.candidate, verification.candidate)
    ) {
      return blocked(
        "Production verification references a different deployment or candidate",
        state,
      );
    }
    const failed =
      requiredChecksPassed(this.policy, verification.checks).length > 0 ||
      verification.smoke !== "passed" ||
      verification.health !== "passed" ||
      verification.checks.some((check) => check.status !== "passed");
    const updated: ReleaseState = {
      ...state,
      status: failed ? "production-failed" : "production-verified",
      production: structuredClone(verification),
      updatedAt: this.now(),
    };
    this.store.save(updated);
    return failed
      ? {
          outcome: "failed",
          reason:
            verification.failureReason ?? "Production verification failed",
          state: updated,
        }
      : { outcome: "verified", state: updated };
  }

  recordRecovery(input: {
    readonly candidate: ReleaseCandidate;
    readonly reason: string;
    readonly authorizedBy: ReleaseActor;
  }): RecoveryRecord {
    const key = this.stateKey(input.candidate);
    const state = this.store.get(key);
    if (state === undefined || state.status !== "production-failed") {
      throw new Error(
        "Recovery can only be recorded for a failed production candidate",
      );
    }
    if (input.reason.trim().length === 0) {
      throw new Error("Recovery reason is required");
    }
    if (
      input.authorizedBy.id.trim().length === 0 ||
      input.authorizedBy.role === "release-coordinator" ||
      !approvalRoles(this.policy).includes(input.authorizedBy.role)
    ) {
      throw new Error("Recovery requires an authorized owner or maintainer");
    }
    const recovery: RecoveryRecord = {
      candidate: structuredClone(input.candidate),
      action: this.policy.recoveryMode,
      reason: input.reason,
      authorizedBy: input.authorizedBy,
      recordedAt: this.now(),
    };
    this.store.save({ ...state, recovery, updatedAt: this.now() });
    return recovery;
  }
}

export const candidateMatchesApproval = (
  candidate: ReleaseCandidate,
  approval: ProductionApproval,
): boolean => sameCandidate(candidate, approval.candidate);
