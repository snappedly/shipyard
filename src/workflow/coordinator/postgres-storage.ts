import {
  parsePhaseResult,
  parseRepositoryPolicy,
  parseWorkBrief,
  type AgentSelection,
  type Assignment,
  type PhaseResult,
  type WorkIdentity,
  type WorkflowPhase,
} from "../contracts/index.js";
import { sameWorkIdentity } from "../shared.js";
import type {
  BranchLease,
  CoordinatorStorage,
  CoordinatorStorageTransaction,
  DispatchIntent,
  EffectIntent,
  RepositoryControl,
  StoredEvent,
  WorkKey,
  WorkflowJob,
} from "./types.js";

/** Minimal query surface implemented by `pg`, Neon, and compatible clients. */
export interface PostgresQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresConnection extends PostgresQueryClient {
  release?: () => void;
}

export interface PostgresCoordinatorStorageOptions {
  /** A connected client or a pool with a transaction-scoped `connect()` method. */
  readonly client: PostgresQueryClient & {
    readonly connect?: () => Promise<PostgresConnection>;
  };
}

const phases: readonly WorkflowPhase[] = [
  "triage",
  "implementation",
  "checking",
  "review",
  "repair",
  "handoff",
  "merge",
  "release-verification",
];

const phase = (value: unknown, path: string): WorkflowPhase => {
  if (typeof value !== "string" || !phases.includes(value as WorkflowPhase)) {
    throw new Error(`${path} contains an unsupported workflow phase`);
  }
  return value as WorkflowPhase;
};

const requiredString = (value: unknown, path: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
};

const numberValue = (value: unknown, path: string): number => {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(result)) throw new Error(`${path} must be an integer`);
  return result;
};

const booleanValue = (value: unknown, path: string): boolean => {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
};

const timestamp = (value: unknown, path: string): string => {
  if (value instanceof Date) return value.toISOString();
  return requiredString(value, path);
};

const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON returned by coordinator storage: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const json = (value: unknown): string => JSON.stringify(value);

const row = <T extends Record<string, unknown>>(
  result: PostgresQueryResult<T>,
  path: string,
): T => {
  const value = result.rows[0];
  if (value === undefined) throw new Error(`${path} was not found`);
  return value;
};

const optionalRow = <T extends Record<string, unknown>>(
  result: PostgresQueryResult<T>,
): T | undefined => result.rows[0];

const parseAssignment = (value: unknown): Assignment => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Stored assignment must be an object");
  }
  const candidate = value as Record<string, unknown>;
  const identity = candidate.identity;
  if (
    typeof identity !== "object" ||
    identity === null ||
    Array.isArray(identity)
  ) {
    throw new Error("Stored assignment identity must be an object");
  }
  const identityRecord = identity as Record<string, unknown>;
  const base = candidate.base;
  if (typeof base !== "object" || base === null || Array.isArray(base)) {
    throw new Error("Stored assignment base must be an object");
  }
  const head = candidate.head;
  const agentSelection = candidate.agentSelection;
  let parsedAgentSelection: AgentSelection | undefined;
  if (agentSelection !== undefined) {
    if (
      typeof agentSelection !== "object" ||
      agentSelection === null ||
      Array.isArray(agentSelection)
    ) {
      throw new Error("Stored assignment agent selection must be an object");
    }
    const selection = agentSelection as Record<string, unknown>;
    if (selection.role !== "routine" && selection.role !== "strong") {
      throw new Error("Stored assignment agent selection role is invalid");
    }
    parsedAgentSelection = {
      provider: requiredString(
        selection.provider,
        "assignment.agentSelection.provider",
      ),
      model: requiredString(selection.model, "assignment.agentSelection.model"),
      role: selection.role,
    };
  }
  const revision = (value: unknown, path: string) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be an object`);
    }
    const record = value as Record<string, unknown>;
    return {
      branch: requiredString(record.branch, `${path}.branch`),
      sha: requiredString(record.sha, `${path}.sha`),
    };
  };
  return {
    contractVersion: numberValue(
      candidate.contractVersion,
      "assignment.contractVersion",
    ) as 1,
    id: requiredString(candidate.id, "assignment.id"),
    phase: phase(candidate.phase, "assignment.phase"),
    attempt: numberValue(candidate.attempt, "assignment.attempt"),
    identity: {
      repository: requiredString(
        identityRecord.repository,
        "assignment.identity.repository",
      ),
      itemId: requiredString(
        identityRecord.itemId,
        "assignment.identity.itemId",
      ),
      kind: requiredString(identityRecord.kind, "assignment.identity.kind") as
        | "planning-spec"
        | "executable-issue"
        | "pr-repair",
    },
    briefId: requiredString(candidate.briefId, "assignment.briefId"),
    briefRevision: numberValue(
      candidate.briefRevision,
      "assignment.briefRevision",
    ),
    briefHash: requiredString(candidate.briefHash, "assignment.briefHash"),
    policyRevision: requiredString(
      candidate.policyRevision,
      "assignment.policyRevision",
    ),
    skillRevision: requiredString(
      candidate.skillRevision,
      "assignment.skillRevision",
    ),
    ...(parsedAgentSelection === undefined
      ? {}
      : { agentSelection: parsedAgentSelection }),
    base: revision(base, "assignment.base"),
    head: head === undefined ? undefined : revision(head, "assignment.head"),
    createdAt: requiredString(candidate.createdAt, "assignment.createdAt"),
  };
};

const parseAssignments = (value: unknown): Assignment[] => {
  if (!Array.isArray(value))
    throw new Error("Stored assignments must be an array");
  return value.map(parseAssignment);
};

const parsePhaseResults = (value: unknown): PhaseResult[] => {
  if (!Array.isArray(value)) {
    throw new Error("Stored phase results must be an array");
  }
  return value.map((result) => parsePhaseResult(result));
};

const eventFromRow = (value: Record<string, unknown>): StoredEvent => {
  const brief = parseWorkBrief(jsonValue(value.brief));
  const policy = parseRepositoryPolicy(jsonValue(value.policy));
  const key: WorkKey = {
    repository: requiredString(value.repository, "event.repository"),
    itemId: requiredString(value.item_id, "event.item_id"),
    briefRevision: numberValue(value.brief_revision, "event.brief_revision"),
    phase: phase(value.phase, "event.phase"),
    relevantRevision: requiredString(
      value.relevant_revision,
      "event.relevant_revision",
    ),
  };
  if (
    !sameWorkIdentity(brief.identity, {
      repository: key.repository,
      itemId: key.itemId,
      kind: brief.identity.kind,
    })
  ) {
    throw new Error("Stored event identity does not match its key");
  }
  return {
    id: requiredString(value.id, "event.id"),
    deliveryId: requiredString(value.delivery_id, "event.delivery_id"),
    brief,
    policy,
    phase: key.phase,
    relevantRevision: key.relevantRevision,
    observedAt: timestamp(value.observed_at, "event.observed_at"),
    sourceState:
      value.source_state === null || value.source_state === undefined
        ? undefined
        : (requiredString(value.source_state, "event.source_state") as
            | "open"
            | "closed"),
    payload: jsonValue(value.payload),
    key,
    status: requiredString(
      value.status,
      "event.status",
    ) as StoredEvent["status"],
    ignoreReason:
      value.ignore_reason === null || value.ignore_reason === undefined
        ? undefined
        : (requiredString(
            value.ignore_reason,
            "event.ignore_reason",
          ) as StoredEvent["ignoreReason"]),
    jobId:
      value.job_id === null || value.job_id === undefined
        ? undefined
        : requiredString(value.job_id, "event.job_id"),
    receivedAt: timestamp(value.received_at, "event.received_at"),
  };
};

const jobFromRow = (value: Record<string, unknown>): WorkflowJob => {
  const brief = parseWorkBrief(jsonValue(value.brief));
  const policy = parseRepositoryPolicy(jsonValue(value.policy));
  const key: WorkKey = {
    repository: requiredString(value.repository, "job.repository"),
    itemId: requiredString(value.item_id, "job.item_id"),
    briefRevision: numberValue(value.brief_revision, "job.brief_revision"),
    phase: phase(value.phase, "job.phase"),
    relevantRevision: requiredString(
      value.relevant_revision,
      "job.relevant_revision",
    ),
  };
  if (
    !sameWorkIdentity(brief.identity, {
      repository: key.repository,
      itemId: key.itemId,
      kind: brief.identity.kind,
    })
  ) {
    throw new Error("Stored job identity does not match its key");
  }
  const phaseAttempts = jsonValue(value.phase_attempts);
  if (
    typeof phaseAttempts !== "object" ||
    phaseAttempts === null ||
    Array.isArray(phaseAttempts)
  ) {
    throw new Error("Stored phase attempts must be an object");
  }
  return {
    id: requiredString(value.id, "job.id"),
    key,
    brief,
    policy,
    state: requiredString(value.state, "job.state") as WorkflowJob["state"],
    control: requiredString(
      value.control,
      "job.control",
    ) as WorkflowJob["control"],
    phaseAttempts: phaseAttempts as WorkflowJob["phaseAttempts"],
    repairBatches: numberValue(value.repair_batches, "job.repair_batches"),
    followUps: numberValue(value.follow_ups, "job.follow_ups"),
    infrastructureRetries: numberValue(
      value.infrastructure_retries,
      "job.infrastructure_retries",
    ),
    infrastructureRetryLimit: numberValue(
      value.infrastructure_retry_limit,
      "job.infrastructure_retry_limit",
    ),
    assignments: parseAssignments(jsonValue(value.assignments)),
    phaseResults: parsePhaseResults(jsonValue(value.phase_results)),
    activeAssignmentId:
      value.active_assignment_id === null ||
      value.active_assignment_id === undefined
        ? undefined
        : requiredString(
            value.active_assignment_id,
            "job.active_assignment_id",
          ),
    latestObservedAt: timestamp(
      value.latest_observed_at,
      "job.latest_observed_at",
    ),
    createdAt: timestamp(value.created_at, "job.created_at"),
    updatedAt: timestamp(value.updated_at, "job.updated_at"),
    version: numberValue(value.version, "job.version"),
  };
};

const dispatchFromRow = (value: Record<string, unknown>): DispatchIntent => ({
  id: requiredString(value.id, "dispatch.id"),
  dedupeKey: requiredString(value.dedupe_key, "dispatch.dedupe_key"),
  key: {
    repository: requiredString(value.repository, "dispatch.repository"),
    itemId: requiredString(value.item_id, "dispatch.item_id"),
    briefRevision: numberValue(value.brief_revision, "dispatch.brief_revision"),
    phase: phase(value.phase, "dispatch.phase"),
    relevantRevision: requiredString(
      value.relevant_revision,
      "dispatch.relevant_revision",
    ),
  },
  jobId: requiredString(value.job_id, "dispatch.job_id"),
  status: requiredString(
    value.status,
    "dispatch.status",
  ) as DispatchIntent["status"],
  assignment:
    value.assignment === null || value.assignment === undefined
      ? undefined
      : parseAssignment(jsonValue(value.assignment)),
  workerId:
    value.worker_id === null || value.worker_id === undefined
      ? undefined
      : requiredString(value.worker_id, "dispatch.worker_id"),
  claimedAt:
    value.claimed_at === null || value.claimed_at === undefined
      ? undefined
      : numberValue(value.claimed_at, "dispatch.claimed_at"),
  claimExpiresAt:
    value.claim_expires_at === null || value.claim_expires_at === undefined
      ? undefined
      : numberValue(value.claim_expires_at, "dispatch.claim_expires_at"),
  error:
    value.error === null || value.error === undefined
      ? undefined
      : requiredString(value.error, "dispatch.error"),
  createdAt: timestamp(value.created_at, "dispatch.created_at"),
  updatedAt: timestamp(value.updated_at, "dispatch.updated_at"),
});

const effectFromRow = (value: Record<string, unknown>): EffectIntent => ({
  id: requiredString(value.id, "effect.id"),
  jobId: requiredString(value.job_id, "effect.job_id"),
  kind: requiredString(value.kind, "effect.kind"),
  marker: requiredString(value.marker, "effect.marker"),
  payload: jsonValue(value.payload),
  status: requiredString(
    value.status,
    "effect.status",
  ) as EffectIntent["status"],
  externalRef: jsonValue(value.external_ref),
  workerId:
    value.worker_id === null || value.worker_id === undefined
      ? undefined
      : requiredString(value.worker_id, "effect.worker_id"),
  fencingToken:
    value.fencing_token === null || value.fencing_token === undefined
      ? undefined
      : numberValue(value.fencing_token, "effect.fencing_token"),
  claimedAt:
    value.claimed_at === null || value.claimed_at === undefined
      ? undefined
      : numberValue(value.claimed_at, "effect.claimed_at"),
  claimExpiresAt:
    value.claim_expires_at === null || value.claim_expires_at === undefined
      ? undefined
      : numberValue(value.claim_expires_at, "effect.claim_expires_at"),
  error:
    value.error === null || value.error === undefined
      ? undefined
      : requiredString(value.error, "effect.error"),
  createdAt: timestamp(value.created_at, "effect.created_at"),
  updatedAt: timestamp(value.updated_at, "effect.updated_at"),
});

const leaseFromRow = (value: Record<string, unknown>): BranchLease => ({
  leaseId: requiredString(value.lease_id, "lease.lease_id"),
  resourceKey: requiredString(value.resource_key, "lease.resource_key"),
  repository: requiredString(value.repository, "lease.repository"),
  branch: requiredString(value.branch, "lease.branch"),
  jobId: requiredString(value.job_id, "lease.job_id"),
  workerId: requiredString(value.worker_id, "lease.worker_id"),
  fencingToken: numberValue(value.fencing_token, "lease.fencing_token"),
  acquiredAt: numberValue(value.acquired_at, "lease.acquired_at"),
  heartbeatAt: numberValue(value.heartbeat_at, "lease.heartbeat_at"),
  expiresAt: numberValue(value.expires_at, "lease.expires_at"),
});

const controlFromRow = (value: Record<string, unknown>): RepositoryControl => ({
  repository: requiredString(value.repository, "control.repository"),
  stopped: booleanValue(value.stopped, "control.stopped"),
  reason:
    value.reason === null || value.reason === undefined
      ? undefined
      : requiredString(value.reason, "control.reason"),
  updatedAt: timestamp(value.updated_at, "control.updated_at"),
});

class PostgresTransaction implements CoordinatorStorageTransaction {
  constructor(private readonly client: PostgresQueryClient) {}

  private async one<T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
    path: string,
  ): Promise<T> {
    return row(await this.client.query<T>(text, values), path);
  }

  async insertEventIfAbsent(event: StoredEvent) {
    const inserted = await this.client.query<Record<string, unknown>>(
      `INSERT INTO shipyard_events (
         id, delivery_id, repository, item_id, brief_revision, phase,
         relevant_revision, observed_at, source_state, brief, policy, status,
         ignore_reason, job_id, received_at, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                 $12, $13, $14, $15, $16::jsonb)
       ON CONFLICT (delivery_id) DO NOTHING
       RETURNING *`,
      [
        event.id,
        event.deliveryId,
        event.key.repository,
        event.key.itemId,
        event.key.briefRevision,
        event.key.phase,
        event.key.relevantRevision,
        event.observedAt,
        event.sourceState ?? null,
        json(event.brief),
        json(event.policy),
        event.status,
        event.ignoreReason ?? null,
        event.jobId ?? null,
        event.receivedAt,
        event.payload === undefined ? null : json(event.payload),
      ],
    );
    if (inserted.rows.length > 0) {
      return { event: eventFromRow(inserted.rows[0]!), inserted: true };
    }
    const existing = await this.one<Record<string, unknown>>(
      "SELECT * FROM shipyard_events WHERE delivery_id = $1",
      [event.deliveryId],
      "event",
    );
    return { event: eventFromRow(existing), inserted: false };
  }

  async saveEvent(event: StoredEvent): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_events (
         id, delivery_id, repository, item_id, brief_revision, phase,
         relevant_revision, observed_at, source_state, brief, policy, status,
         ignore_reason, job_id, received_at, payload
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
                 $12, $13, $14, $15, $16::jsonb)
       ON CONFLICT (delivery_id) DO UPDATE SET
         status = EXCLUDED.status,
         ignore_reason = EXCLUDED.ignore_reason,
         job_id = EXCLUDED.job_id`,
      [
        event.id,
        event.deliveryId,
        event.key.repository,
        event.key.itemId,
        event.key.briefRevision,
        event.key.phase,
        event.key.relevantRevision,
        event.observedAt,
        event.sourceState ?? null,
        json(event.brief),
        json(event.policy),
        event.status,
        event.ignoreReason ?? null,
        event.jobId ?? null,
        event.receivedAt,
        event.payload === undefined ? null : json(event.payload),
      ],
    );
  }

  async lockWorkIdentity(identity: WorkIdentity): Promise<void> {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${identity.repository}\u0000${identity.itemId}\u0000${identity.kind}`],
    );
  }

  async getJob(jobId: string): Promise<WorkflowJob | undefined> {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : jobFromRow(value);
  }

  async findJobByKey(key: WorkKey, briefHash: string) {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM shipyard_jobs
       WHERE repository = $1 AND item_id = $2 AND brief_revision = $3
         AND phase = $4 AND relevant_revision = $5
         AND brief->>'hash' = $6
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [
        key.repository,
        key.itemId,
        key.briefRevision,
        key.phase,
        key.relevantRevision,
        briefHash,
      ],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : jobFromRow(value);
  }

  async findCurrentJob(identity: WorkIdentity) {
    const result = await this.client.query<Record<string, unknown>>(
      `SELECT * FROM shipyard_jobs
       WHERE repository = $1 AND item_id = $2 AND item_kind = $3
         AND control <> 'superseded'
       ORDER BY latest_observed_at DESC, updated_at DESC LIMIT 1 FOR UPDATE`,
      [identity.repository, identity.itemId, identity.kind],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : jobFromRow(value);
  }

  async insertJob(job: WorkflowJob): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_jobs (
         id, repository, item_id, item_kind, brief_revision, phase,
         relevant_revision, brief, policy, state, control, phase_attempts,
         repair_batches, follow_ups, infrastructure_retries,
         infrastructure_retry_limit, assignments, phase_results,
         active_assignment_id, latest_observed_at, created_at, updated_at, version
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11,
                 $12::jsonb, $13, $14, $15, $16, $17::jsonb, $18::jsonb,
                 $19, $20, $21, $22, $23)`,
      jobValues(job),
    );
  }

  async saveJob(job: WorkflowJob): Promise<void> {
    const result = await this.client.query(
      `UPDATE shipyard_jobs SET
         repository = $2, item_id = $3, item_kind = $4, brief_revision = $5,
         phase = $6, relevant_revision = $7, brief = $8::jsonb,
         policy = $9::jsonb, state = $10, control = $11,
         phase_attempts = $12::jsonb, repair_batches = $13, follow_ups = $14,
         infrastructure_retries = $15, infrastructure_retry_limit = $16,
         assignments = $17::jsonb, phase_results = $18::jsonb,
         active_assignment_id = $19, latest_observed_at = $20,
         created_at = $21, updated_at = $22, version = $23
       WHERE id = $1 AND version = $24
       RETURNING id`,
      [...jobValues(job), job.version - 1],
    );
    if (result.rows.length !== 1) {
      throw new Error(`Workflow job ${job.id} was updated concurrently`);
    }
  }

  async findDispatchByDedupeKey(dedupeKey: string) {
    const result = await this.client.query<Record<string, unknown>>(
      dispatchSelect("d.dedupe_key = $1"),
      [dedupeKey],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : dispatchFromRow(value);
  }

  async findDispatchByAssignmentId(assignmentId: string) {
    const result = await this.client.query<Record<string, unknown>>(
      dispatchSelect("d.assignment->>'id' = $1"),
      [assignmentId],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : dispatchFromRow(value);
  }

  async findPendingDispatch(
    repository: string,
    nowMilliseconds: number,
    selector: {
      readonly jobId?: string;
      readonly dispatchId?: string;
    } = {},
  ) {
    const predicates = [
      "j.repository = $1",
      "(d.status = 'pending' OR (d.status IN ('claimed', 'started') AND d.claim_expires_at <= $2))",
    ];
    const values: unknown[] = [repository, nowMilliseconds];
    if (selector.jobId !== undefined) {
      values.push(selector.jobId);
      predicates.push(`d.job_id = $${values.length}`);
    }
    if (selector.dispatchId !== undefined) {
      values.push(selector.dispatchId);
      predicates.push(`d.id = $${values.length}`);
    }
    const result = await this.client.query<Record<string, unknown>>(
      `${dispatchSelect(predicates.join(" AND "))} ORDER BY d.created_at ASC LIMIT 1 FOR UPDATE OF d, j SKIP LOCKED`,
      values,
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : dispatchFromRow(value);
  }

  async insertDispatchIfAbsent(dispatch: DispatchIntent) {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO shipyard_dispatches (
         id, dedupe_key, job_id, repository, item_id, brief_revision, phase,
         relevant_revision, status, assignment, worker_id, claimed_at,
         claim_expires_at, error, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11,
                 $12, $13, $14, $15, $16)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING *`,
      dispatchValues(dispatch),
    );
    if (result.rows.length > 0) {
      return { dispatch: dispatchFromRow(result.rows[0]!), inserted: true };
    }
    const existing = await this.one<Record<string, unknown>>(
      dispatchSelect("d.dedupe_key = $1"),
      [dispatch.dedupeKey],
      "dispatch",
    );
    return { dispatch: dispatchFromRow(existing), inserted: false };
  }

  async saveDispatch(dispatch: DispatchIntent): Promise<void> {
    await this.client.query(
      `UPDATE shipyard_dispatches SET
         dedupe_key = $2, job_id = $3, repository = $4, item_id = $5,
         brief_revision = $6, phase = $7, relevant_revision = $8,
         status = $9, assignment = $10::jsonb, worker_id = $11,
         claimed_at = $12, claim_expires_at = $13, error = $14,
         created_at = $15, updated_at = $16
       WHERE id = $1`,
      dispatchValues(dispatch),
    );
  }

  async findEffect(jobId: string, kind: string, marker: string) {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_effects WHERE job_id = $1 AND kind = $2 AND marker = $3",
      [jobId, kind, marker],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : effectFromRow(value);
  }

  async insertEffectIfAbsent(effect: EffectIntent) {
    const result = await this.client.query<Record<string, unknown>>(
      `INSERT INTO shipyard_effects (
         id, job_id, kind, marker, payload, status, external_ref, worker_id,
         fencing_token, claimed_at, claim_expires_at, error, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, $10,
                 $11, $12, $13, $14)
       ON CONFLICT (job_id, kind, marker) DO NOTHING
       RETURNING *`,
      effectValues(effect),
    );
    if (result.rows.length > 0) {
      return { effect: effectFromRow(result.rows[0]!), inserted: true };
    }
    const existing = await this.one<Record<string, unknown>>(
      "SELECT * FROM shipyard_effects WHERE job_id = $1 AND kind = $2 AND marker = $3",
      [effect.jobId, effect.kind, effect.marker],
      "effect",
    );
    return { effect: effectFromRow(existing), inserted: false };
  }

  async saveEffect(effect: EffectIntent): Promise<void> {
    await this.client.query(
      `UPDATE shipyard_effects SET
         job_id = $2, kind = $3, marker = $4, payload = $5::jsonb,
         status = $6, external_ref = $7::jsonb, worker_id = $8,
         fencing_token = $9, claimed_at = $10, claim_expires_at = $11,
         error = $12, created_at = $13, updated_at = $14
       WHERE id = $1`,
      effectValues(effect),
    );
  }

  async getLease(repository: string, branch: string) {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_branch_leases WHERE repository = $1 AND branch = $2 FOR UPDATE",
      [repository, branch],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : leaseFromRow(value);
  }

  async lockLeaseResource(repository: string, branch: string): Promise<void> {
    await this.client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${repository}\u0000${branch}`],
    );
  }

  async saveLease(lease: BranchLease): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_branch_leases (
         resource_key, lease_id, repository, branch, job_id, worker_id,
         fencing_token, acquired_at, heartbeat_at, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (resource_key) DO UPDATE SET
         lease_id = EXCLUDED.lease_id, job_id = EXCLUDED.job_id,
         worker_id = EXCLUDED.worker_id, fencing_token = EXCLUDED.fencing_token,
         acquired_at = EXCLUDED.acquired_at, heartbeat_at = EXCLUDED.heartbeat_at,
         expires_at = EXCLUDED.expires_at`,
      [
        lease.resourceKey,
        lease.leaseId,
        lease.repository,
        lease.branch,
        lease.jobId,
        lease.workerId,
        lease.fencingToken,
        lease.acquiredAt,
        lease.heartbeatAt,
        lease.expiresAt,
      ],
    );
  }

  async findLeasesForJob(jobId: string) {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_branch_leases WHERE job_id = $1",
      [jobId],
    );
    return result.rows.map(leaseFromRow);
  }

  async findLeasesForRepository(repository: string) {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_branch_leases WHERE repository = $1",
      [repository],
    );
    return result.rows.map(leaseFromRow);
  }

  async getRepositoryControl(repository: string) {
    const result = await this.client.query<Record<string, unknown>>(
      "SELECT * FROM shipyard_repository_controls WHERE repository = $1",
      [repository],
    );
    const value = optionalRow(result);
    return value === undefined ? undefined : controlFromRow(value);
  }

  async saveRepositoryControl(control: RepositoryControl): Promise<void> {
    await this.client.query(
      `INSERT INTO shipyard_repository_controls (repository, stopped, reason, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (repository) DO UPDATE SET
         stopped = EXCLUDED.stopped, reason = EXCLUDED.reason,
         updated_at = EXCLUDED.updated_at`,
      [
        control.repository,
        control.stopped,
        control.reason ?? null,
        control.updatedAt,
      ],
    );
  }
}

const jobValues = (job: WorkflowJob): readonly unknown[] => [
  job.id,
  job.key.repository,
  job.key.itemId,
  job.brief.identity.kind,
  job.key.briefRevision,
  job.key.phase,
  job.key.relevantRevision,
  json(job.brief),
  json(job.policy),
  job.state,
  job.control,
  json(job.phaseAttempts),
  job.repairBatches,
  job.followUps,
  job.infrastructureRetries,
  job.infrastructureRetryLimit,
  json(job.assignments),
  json(job.phaseResults),
  job.activeAssignmentId ?? null,
  job.latestObservedAt,
  job.createdAt,
  job.updatedAt,
  job.version,
];

const dispatchValues = (dispatch: DispatchIntent): readonly unknown[] => [
  dispatch.id,
  dispatch.dedupeKey,
  dispatch.jobId,
  dispatch.key.repository,
  dispatch.key.itemId,
  dispatch.key.briefRevision,
  dispatch.key.phase,
  dispatch.key.relevantRevision,
  dispatch.status,
  dispatch.assignment === undefined ? null : json(dispatch.assignment),
  dispatch.workerId ?? null,
  dispatch.claimedAt ?? null,
  dispatch.claimExpiresAt ?? null,
  dispatch.error ?? null,
  dispatch.createdAt,
  dispatch.updatedAt,
];

const effectValues = (effect: EffectIntent): readonly unknown[] => [
  effect.id,
  effect.jobId,
  effect.kind,
  effect.marker,
  effect.payload === undefined ? null : json(effect.payload),
  effect.status,
  effect.externalRef === undefined ? null : json(effect.externalRef),
  effect.workerId ?? null,
  effect.fencingToken ?? null,
  effect.claimedAt ?? null,
  effect.claimExpiresAt ?? null,
  effect.error ?? null,
  effect.createdAt,
  effect.updatedAt,
];

const dispatchSelect = (predicate: string): string =>
  `SELECT d.*, j.repository, j.item_id, j.brief_revision, j.phase,
          j.relevant_revision
     FROM shipyard_dispatches d
     JOIN shipyard_jobs j ON j.id = d.job_id
    WHERE ${predicate}`;

/** PostgreSQL-backed implementation; schema installation remains an operator concern. */
export class PostgresCoordinatorStorage implements CoordinatorStorage {
  private readonly client: PostgresCoordinatorStorageOptions["client"];

  constructor(options: PostgresCoordinatorStorageOptions) {
    this.client = options.client;
  }

  async transaction<T>(
    operation: (transaction: CoordinatorStorageTransaction) => Promise<T>,
  ): Promise<T> {
    const connection: PostgresConnection = this.client.connect
      ? await this.client.connect()
      : this.client;
    let began = false;
    try {
      await connection.query("BEGIN");
      began = true;
      const result = await operation(new PostgresTransaction(connection));
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      if (began) {
        try {
          await connection.query("ROLLBACK");
        } catch {
          // Preserve the operation error; the connection is still released below.
        }
      }
      throw error;
    } finally {
      connection.release?.();
    }
  }
}
