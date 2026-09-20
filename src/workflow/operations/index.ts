import type {
  CheckEvidence,
  PhaseResult,
  WorkflowPhase,
} from "../contracts/index.js";
import type {
  RepositoryControl,
  WorkflowCoordinator,
  WorkflowJob,
} from "../coordinator/index.js";

export interface CostMeasurement {
  readonly currency?: string;
  readonly amount?: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly provider?: string;
  readonly model?: string;
}

export interface OperatorStatusOptions {
  readonly cost?: CostMeasurement;
  readonly now?: string;
}

export interface OperatorCheckStatus {
  readonly name: string;
  readonly command: string;
  readonly status: CheckEvidence["status"];
  readonly summary: string;
  readonly artifactRefs?: readonly string[];
}

export interface OperatorStatus {
  readonly jobId: string;
  readonly repository: string;
  readonly itemId: string;
  readonly kind: string;
  readonly state: WorkflowJob["state"];
  readonly control: WorkflowJob["control"];
  readonly phase: WorkflowPhase;
  readonly waitingReason?: string;
  readonly queueAgeSeconds: number;
  readonly attempts: Readonly<Record<WorkflowPhase, number>>;
  readonly activeAssignmentId?: string;
  readonly latestObservedAt: string;
  readonly checks: readonly OperatorCheckStatus[];
  readonly artifacts: readonly string[];
  readonly cost:
    | { readonly status: "unknown" }
    | ({ readonly status: "measured" } & CostMeasurement);
  readonly interventions: readonly OperatorIntervention[];
  readonly repositoryControl?: RepositoryControl;
}

export interface OperatorIntervention {
  readonly action:
    | "pause"
    | "cancel"
    | "resume"
    | "stop-repository"
    | "resume-repository";
  readonly reason?: string;
  readonly at: string;
}

export interface WorkflowOperatorOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly now?: () => string;
}

const defaultNow = (): string => new Date().toISOString();

const redact = (value: string): string =>
  value
    .replace(
      /(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]");

const redactedCheck = (check: CheckEvidence): OperatorCheckStatus => ({
  name: redact(check.name),
  command: redact(check.command),
  status: check.status,
  summary: redact(check.summary),
  artifactRefs: check.artifactRefs?.map(redact),
});

const latestChecks = (
  results: readonly PhaseResult[],
): OperatorCheckStatus[] => {
  const byName = new Map<string, OperatorCheckStatus>();
  for (const result of results) {
    for (const check of result.checks)
      byName.set(check.name, redactedCheck(check));
  }
  return [...byName.values()];
};

const waitingReason = (
  job: WorkflowJob,
  stopped: boolean,
): string | undefined => {
  if (stopped) return "repository-stopped";
  if (job.control === "paused") return "operator-paused";
  if (job.control === "cancelled") return "job-cancelled";
  if (job.control === "superseded") return "superseded-by-newer-revision";
  if (job.brief.authorization.status === "pending")
    return "authorization-pending";
  if (job.brief.authorization.status === "withdrawn")
    return "authorization-withdrawn";
  if (job.state === "waiting-info") {
    return job.brief.unresolvedQuestions[0] === undefined
      ? "clarification-required"
      : redact(job.brief.unresolvedQuestions[0]);
  }
  if (job.state === "blocked") return "workflow-blocked";
  if (job.state === "failed") return "phase-failed";
  return undefined;
};

const queueAge = (createdAt: string, now: string): number => {
  const created = Date.parse(createdAt);
  const current = Date.parse(now);
  if (!Number.isFinite(created) || !Number.isFinite(current)) return 0;
  return Math.max(0, Math.floor((current - created) / 1000));
};

const cost = (
  measurement: CostMeasurement | undefined,
): OperatorStatus["cost"] =>
  measurement === undefined
    ? { status: "unknown" }
    : { status: "measured", ...measurement };

export class WorkflowOperator {
  private readonly coordinator: WorkflowCoordinator;
  private readonly now: () => string;
  private readonly interventions = new Map<string, OperatorIntervention[]>();

  constructor(options: WorkflowOperatorOptions) {
    this.coordinator = options.coordinator;
    this.now = options.now ?? defaultNow;
  }

  async status(
    jobId: string,
    options: OperatorStatusOptions = {},
  ): Promise<OperatorStatus> {
    const job = await this.coordinator.getJob(jobId);
    if (job === undefined)
      throw new Error(`Workflow job ${jobId} does not exist`);
    const repositoryControl = await this.coordinator.getRepositoryControl(
      job.key.repository,
    );
    const results = job.phaseResults;
    return {
      jobId: job.id,
      repository: job.key.repository,
      itemId: job.key.itemId,
      kind: job.brief.identity.kind,
      state: job.state,
      control: job.control,
      phase: job.activeAssignmentId
        ? (job.assignments.find(
            (assignment) => assignment.id === job.activeAssignmentId,
          )?.phase ?? job.key.phase)
        : job.key.phase,
      waitingReason: waitingReason(job, repositoryControl?.stopped === true),
      queueAgeSeconds: queueAge(job.createdAt, options.now ?? this.now()),
      attempts: job.phaseAttempts,
      activeAssignmentId: job.activeAssignmentId,
      latestObservedAt: job.latestObservedAt,
      checks: latestChecks(results),
      artifacts: results.flatMap((result) => result.artifacts.map(redact)),
      cost: cost(options.cost),
      interventions: [...(this.interventions.get(jobId) ?? [])],
      repositoryControl,
    };
  }

  async pause(jobId: string, reason?: string): Promise<WorkflowJob> {
    const job = await this.coordinator.pauseJob(jobId, reason);
    this.record(jobId, "pause", reason);
    return job;
  }

  async cancel(jobId: string, reason?: string): Promise<WorkflowJob> {
    const job = await this.coordinator.cancelJob(jobId, reason);
    this.record(jobId, "cancel", reason);
    return job;
  }

  async resume(jobId: string): Promise<WorkflowJob> {
    const job = await this.coordinator.resumeJob(jobId);
    this.record(jobId, "resume");
    return job;
  }

  async stopRepository(
    repository: string,
    reason?: string,
  ): Promise<RepositoryControl> {
    const control = await this.coordinator.setRepositoryStop({
      repository,
      stopped: true,
      reason,
    });
    this.record(`repository:${repository}`, "stop-repository", reason);
    return control;
  }

  async resumeRepository(repository: string): Promise<RepositoryControl> {
    const control = await this.coordinator.setRepositoryStop({
      repository,
      stopped: false,
    });
    this.record(`repository:${repository}`, "resume-repository");
    return control;
  }

  private record(
    key: string,
    action: OperatorIntervention["action"],
    reason?: string,
  ): void {
    const list = this.interventions.get(key) ?? [];
    list.push({
      action,
      reason: reason === undefined ? undefined : redact(reason),
      at: this.now(),
    });
    this.interventions.set(key, list);
  }
}

export { redact as redactOperatorText };
