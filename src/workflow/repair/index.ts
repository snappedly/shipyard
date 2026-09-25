import {
  isAuthorizationAllowed,
  parseRepositoryPolicy,
  parseWorkBrief,
  type Assignment,
  type Finding,
  type PhaseResult,
  type RepositoryPolicy,
  type RevisionReference,
  type WorkBrief,
} from "../contracts/index.js";
import type {
  BranchLease,
  DispatchIntent,
  DispatchResult,
  WorkflowCoordinator,
  WorkflowJob,
} from "../coordinator/index.js";
import type { PostgresQueryClient } from "../coordinator/postgres-storage.js";
import { PostgresWorkflowPhaseRecordStore } from "../phase-storage.js";
import { parseRepairBatchResult } from "./persistence.js";
import {
  executePhase,
  type ExecutePhaseOptions,
  type PhaseExecutionResult,
} from "../execution/index.js";
import type {
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubPublication,
  GitHubPublicationResult,
  GitHubPullRequestSnapshot,
} from "../../integrations/github/index.js";
import { isBlockingFinding, sameRevision } from "../shared.js";

export interface RepairCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly briefHash: string;
}

export interface RepairBatch {
  readonly id: string;
  readonly jobId: string;
  readonly sourceIssueNumber?: number;
  readonly pullRequestNumber?: number;
  readonly candidate: RepairCandidate;
  readonly brief: WorkBrief;
  readonly findings: readonly Finding[];
  readonly followUp: boolean;
  readonly createdAt: string;
}

export interface RepairBatchStore {
  get(
    key: string,
  ): RepairBatchResult | undefined | Promise<RepairBatchResult | undefined>;
  save(
    key: string,
    result: RepairBatchResult,
    updatedAt?: string,
  ): void | Promise<void>;
}

export class InMemoryRepairBatchStore implements RepairBatchStore {
  private readonly results = new Map<string, RepairBatchResult>();

  get(key: string): RepairBatchResult | undefined {
    const result = this.results.get(key);
    return result === undefined ? undefined : clone(result);
  }

  save(key: string, result: RepairBatchResult): void {
    this.results.set(key, clone(result));
  }
}

export interface PostgresRepairBatchStoreOptions {
  readonly client: PostgresQueryClient;
}

/** Durable bounded-repair records backed by the coordinator's PostgreSQL database. */
export class PostgresRepairBatchStore implements RepairBatchStore {
  private readonly records: PostgresWorkflowPhaseRecordStore;

  constructor(options: PostgresRepairBatchStoreOptions) {
    this.records = new PostgresWorkflowPhaseRecordStore(options);
  }

  async get(key: string): Promise<RepairBatchResult | undefined> {
    const result = await this.records.get("repair-batch", key);
    return result === undefined ? undefined : parseRepairBatchResult(result);
  }

  save(
    key: string,
    result: RepairBatchResult,
    updatedAt = new Date().toISOString(),
  ): Promise<void> {
    // Coordinator jobs and leases are canonical there and may expire on reload.
    const durableResult = {
      outcome: result.outcome,
      reason: result.reason,
      batch: result.batch,
      repairIssue: result.repairIssue,
      issuePublication: result.issuePublication,
      linkPublication: result.linkPublication,
    };
    return this.records.save("repair-batch", key, durableResult, updatedAt);
  }
}

export interface CurrentRepairCandidate {
  readonly base: RevisionReference;
  readonly head: RevisionReference;
  readonly briefHash: string;
  readonly pullRequest?: GitHubPullRequestSnapshot;
}

export interface ScheduleRepairOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly publication: GitHubPublication;
  readonly store: RepairBatchStore;
  readonly jobId: string;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly candidate: RepairCandidate;
  readonly workerId: string;
  readonly sourceIssueNumber?: number;
  readonly pullRequestNumber?: number;
  readonly followUp?: boolean;
  readonly pullRequestState?: "open" | "closed";
  readonly readCurrent?: () => Promise<CurrentRepairCandidate>;
  readonly now?: () => string;
  readonly leaseTtlMs?: number;
}

export type RepairScheduleOutcome = "scheduled" | "duplicate" | "blocked";

export interface RepairBatchResult {
  readonly outcome: RepairScheduleOutcome;
  readonly reason?: string;
  readonly batch: RepairBatch;
  readonly job?: WorkflowJob;
  readonly dispatch?: DispatchIntent;
  /** Fresh dispatch ID to reclaim when its saved claim has expired. */
  readonly resumeDispatchId?: string;
  readonly lease?: BranchLease;
  readonly repairIssue?: GitHubIssueSnapshot;
  readonly issuePublication?: GitHubPublicationResult<GitHubIssueSnapshot>;
  readonly linkPublication?: GitHubPublicationResult<GitHubCommentSnapshot>;
}

export interface ScheduleRepairInput extends ScheduleRepairOptions {
  readonly findings: readonly Finding[];
}

export interface RepairExecutionTemplate extends Omit<
  ExecutePhaseOptions,
  "assignment" | "branch"
> {
  readonly branch?: string;
}

export interface RunBoundedRepairOptions extends ScheduleRepairInput {
  readonly execution: RepairExecutionTemplate;
}

export interface BoundedRepairExecutionResult {
  readonly outcome: "completed" | "needs-info" | "failed" | "blocked";
  readonly reason?: string;
  readonly repair: RepairBatchResult;
  readonly assignment?: Assignment;
  readonly dispatch?: DispatchResult;
  readonly execution?: PhaseExecutionResult;
  readonly phaseResult?: PhaseResult;
  readonly nextPhase?: "checking" | "review";
  readonly nextDispatch?: DispatchIntent;
}

const defaultNow = (): string => new Date().toISOString();

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const normalizedFindings = (findings: readonly Finding[]): Finding[] => {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    if (!isBlockingFinding(finding)) continue;
    const key = JSON.stringify([
      finding.axis,
      finding.title,
      finding.location ?? "",
      finding.requirement ?? "",
      finding.evidence,
    ]);
    if (!byKey.has(key)) byKey.set(key, finding);
  }
  return [...byKey.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
};

const batchKey = (
  jobId: string,
  candidate: RepairCandidate,
  brief: WorkBrief,
  findings: readonly Finding[],
  followUp: boolean,
): string =>
  JSON.stringify({
    jobId,
    base: candidate.base,
    head: candidate.head,
    briefHash: brief.hash,
    findingIds: findings.map((finding) => finding.id),
    followUp,
  });

const issueBody = (
  batch: RepairBatch,
  pullRequestNumber: number | undefined,
): string =>
  [
    "## Shipyard bounded PR repair",
    "",
    pullRequestNumber === undefined
      ? "Existing PR: not supplied"
      : `Existing PR: #${pullRequestNumber}`,
    batch.sourceIssueNumber === undefined
      ? "Source issue: not supplied"
      : `Source issue: #${batch.sourceIssueNumber}`,
    `Candidate head: \`${batch.candidate.head.sha}\``,
    `Brief hash: \`${batch.brief.hash}\``,
    `Repair batch: ${batch.followUp ? "follow-up" : "normal"}`,
    "",
    "### Findings",
    ...batch.findings.flatMap((finding) => [
      `- [${finding.severity}] ${finding.title} (${finding.axis})`,
      `  - Evidence: ${finding.evidence}`,
      ...(finding.location ? [`  - Location: ${finding.location}`] : []),
      ...(finding.requirement
        ? [`  - Requirement: ${finding.requirement}`]
        : []),
      ...(finding.verification ? [`  - Verify: ${finding.verification}`] : []),
    ]),
    "",
    "This is a bounded repair of the existing PR branch. It is not an ordinary new work item.",
  ].join("\n");

const blocked = (
  batch: RepairBatch,
  reason: string,
  extra: Omit<RepairBatchResult, "outcome" | "reason" | "batch"> = {},
): RepairBatchResult => ({
  ...extra,
  outcome: "blocked",
  reason,
  batch,
});

const publicationSucceeded = <T>(
  publication: GitHubPublicationResult<T> | undefined,
): publication is GitHubPublicationResult<T> & { readonly remote: T } =>
  publication !== undefined &&
  publication.remote !== undefined &&
  publication.disposition !== "in-flight" &&
  publication.effect.status === "succeeded" &&
  publication.effect.marker === publication.marker;

const publicationComplete = (result: RepairBatchResult): boolean => {
  if (!publicationSucceeded(result.issuePublication)) return false;
  if (result.batch.sourceIssueNumber === undefined) return true;
  const link = result.linkPublication;
  return (
    publicationSucceeded(link) &&
    link.remote.body.startsWith(`<!-- shipyard:${link.marker} -->\n`)
  );
};

const currentRepairStateError = async (
  input: ScheduleRepairInput,
  batch: RepairBatch,
  required: boolean,
): Promise<string | undefined> => {
  if (input.pullRequestState === "closed") {
    return "The existing pull request is closed or abandoned";
  }
  if (input.readCurrent === undefined) {
    return required
      ? "Current repair state is required to resume a saved repair"
      : undefined;
  }
  let current: CurrentRepairCandidate;
  try {
    current = await input.readCurrent();
  } catch (error) {
    return `Current repair state could not be verified: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (
    !sameRevision(current.base, input.candidate.base) ||
    !sameRevision(current.head, input.candidate.head) ||
    current.briefHash !== input.brief.hash
  ) {
    return "Repair candidate became stale before scheduling";
  }
  if (current.pullRequest?.state === "closed") {
    return "The current pull request is closed or abandoned";
  }
  const pullRequestNumber = input.pullRequestNumber ?? batch.pullRequestNumber;
  if (
    pullRequestNumber !== undefined &&
    current.pullRequest?.number !== pullRequestNumber
  ) {
    return "The current pull request could not be verified";
  }
  if (
    current.pullRequest !== undefined &&
    (current.pullRequest.branch !== input.candidate.head.branch ||
      current.pullRequest.headSha !== input.candidate.head.sha ||
      current.pullRequest.baseBranch !== input.candidate.base.branch)
  ) {
    return "Repair candidate no longer matches the current pull request";
  }
  return undefined;
};

const repairResultWithIssue = (
  result: RepairBatchResult,
): RepairBatchResult => {
  const repairIssue = result.repairIssue ?? result.issuePublication?.remote;
  return repairIssue === undefined ? result : { ...result, repairIssue };
};

const withoutCoordinatorState = (
  result: RepairBatchResult,
): RepairBatchResult => ({
  outcome: result.outcome,
  reason: result.reason,
  batch: result.batch,
  repairIssue: result.repairIssue,
  issuePublication: result.issuePublication,
  linkPublication: result.linkPublication,
});

const duplicateWithoutDispatch = (
  result: RepairBatchResult,
  reason: string,
): RepairBatchResult => ({
  outcome: "duplicate",
  reason,
  batch: result.batch,
  ...(result.repairIssue === undefined
    ? {}
    : { repairIssue: result.repairIssue }),
  ...(result.issuePublication === undefined
    ? {}
    : { issuePublication: result.issuePublication }),
  ...(result.linkPublication === undefined
    ? {}
    : { linkPublication: result.linkPublication }),
});

export const scheduleBoundedRepair = async (
  input: ScheduleRepairInput,
): Promise<RepairBatchResult> => {
  const brief = parseWorkBrief(input.brief);
  const policy = parseRepositoryPolicy(input.policy);
  const findings = normalizedFindings(input.findings);
  const now = input.now ?? defaultNow;
  const requestedBatch: RepairBatch = {
    id: `repair:${input.jobId}:${input.candidate.head.sha}:${input.followUp === true ? "follow-up" : "normal"}`,
    jobId: input.jobId,
    sourceIssueNumber: input.sourceIssueNumber,
    pullRequestNumber: input.pullRequestNumber,
    candidate: input.candidate,
    brief,
    findings,
    followUp: input.followUp === true,
    createdAt: now(),
  };
  const key = batchKey(
    input.jobId,
    input.candidate,
    brief,
    findings,
    requestedBatch.followUp,
  );
  const existing = await input.store.get(key);
  if (
    existing !== undefined &&
    ((input.pullRequestNumber !== undefined &&
      input.pullRequestNumber !== existing.batch.pullRequestNumber) ||
      (input.sourceIssueNumber !== undefined &&
        input.sourceIssueNumber !== existing.batch.sourceIssueNumber))
  ) {
    return blocked(
      existing.batch,
      "Saved repair batch is bound to a different source issue or pull request",
    );
  }
  if (existing !== undefined && publicationComplete(existing)) {
    if (input.candidate.briefHash !== brief.hash) {
      return blocked(
        existing.batch,
        "Repair candidate is bound to a different brief hash",
      );
    }
    const recovered = withoutCoordinatorState(repairResultWithIssue(existing));
    const stateError = await currentRepairStateError(
      input,
      recovered.batch,
      true,
    );
    if (stateError !== undefined) {
      if (
        input.readCurrent === undefined &&
        input.pullRequestState !== "closed" &&
        existing.job !== undefined &&
        existing.dispatch !== undefined
      ) {
        return duplicateWithoutDispatch(recovered, stateError);
      }
      return blocked(existing.batch, stateError);
    }
    const scheduled = await input.coordinator.scheduleRepair({
      jobId: input.jobId,
      brief,
      policy,
      followUp: existing.batch.followUp,
      relevantRevision: input.candidate.head.sha,
    });
    if (scheduled.status !== "scheduled" || scheduled.dispatch === undefined) {
      return blocked(
        existing.batch,
        scheduled.reason ?? "Repair workflow is no longer schedulable",
        { job: scheduled.job },
      );
    }
    const dispatch = scheduled.dispatch;
    if (dispatch.status === "cancelled" || dispatch.status === "failed") {
      return blocked(
        existing.batch,
        `Saved repair dispatch is ${dispatch.status}`,
        { job: scheduled.job },
      );
    }
    if (dispatch.status === "completed") {
      return {
        ...recovered,
        outcome: "duplicate",
        job: scheduled.job,
        dispatch,
      };
    }
    if (scheduled.dispatchClaimExpired === true) {
      // The coordinator will reclaim an expired claim on the next dispatch
      // attempt; do not expose its expired snapshot as a current assignment.
      return {
        ...recovered,
        outcome: "duplicate",
        job: scheduled.job,
        resumeDispatchId: dispatch.id,
      };
    }
    return {
      ...recovered,
      outcome: "duplicate",
      job: scheduled.job,
      dispatch,
    };
  }
  const batch = existing?.batch ?? requestedBatch;
  if (existing !== undefined) {
    const stateError = await currentRepairStateError(input, batch, true);
    if (stateError !== undefined) return blocked(batch, stateError);
  }
  if (findings.length === 0) {
    return blocked(batch, "No actionable blocking findings remain");
  }
  if (input.pullRequestState === "closed") {
    return blocked(batch, "The existing pull request is closed or abandoned");
  }
  const job = await input.coordinator.getJob(input.jobId);
  if (job === undefined) return blocked(batch, "Workflow job does not exist");
  if (job.control !== "active") {
    return blocked(batch, `Workflow job is ${job.control}`);
  }
  if (job.brief.hash !== brief.hash) {
    return blocked(batch, "Repair brief is stale for the workflow job", {
      job,
    });
  }
  if (
    !isAuthorizationAllowed(job.brief, job.policy) ||
    !isAuthorizationAllowed(brief, policy)
  ) {
    return blocked(batch, "Authorization was withdrawn or is not approved", {
      job,
    });
  }
  if (input.candidate.briefHash !== brief.hash) {
    return blocked(
      batch,
      "Repair candidate is bound to a different brief hash",
      { job },
    );
  }
  if (input.readCurrent !== undefined) {
    const stateError = await currentRepairStateError(input, batch, false);
    if (stateError !== undefined) {
      return blocked(batch, stateError, { job });
    }
  }

  // Persist the intent before spending coordinator budget or touching GitHub.
  // A retry can safely resume this intent because coordinator scheduling and
  // GitHub publication both use stable dedupe markers.
  await input.store.save(key, { outcome: "scheduled", batch }, now());
  const scheduled = await input.coordinator.scheduleRepair({
    jobId: input.jobId,
    brief,
    policy,
    followUp: batch.followUp,
    relevantRevision: input.candidate.head.sha,
  });
  if (scheduled.status !== "scheduled" || scheduled.dispatch === undefined) {
    return blocked(
      batch,
      scheduled.reason ??
        "Repair budget or coordinator state blocked scheduling",
      {
        job: scheduled.job,
      },
    );
  }

  const lease = await input.coordinator.acquireBranchLease({
    repository: brief.identity.repository,
    branch: input.candidate.head.branch,
    jobId: input.jobId,
    workerId: input.workerId,
    ttlMs: input.leaseTtlMs ?? 60_000,
  });
  const scheduledResult: RepairBatchResult = {
    outcome: "scheduled",
    batch,
    job: scheduled.job,
    dispatch: scheduled.dispatch,
    lease,
  };
  await input.store.save(key, scheduledResult, now());
  const issuePublication = await input.publication.publishRepairIssue({
    jobId: input.jobId,
    lease,
    title: `[Shipyard] Repair PR #${batch.pullRequestNumber ?? brief.identity.itemId}`,
    body: issueBody(batch, batch.pullRequestNumber),
    labels: ["shipyard:pr-repair"],
  });
  const linkPublication =
    issuePublication.remote?.htmlUrl !== undefined &&
    batch.sourceIssueNumber !== undefined
      ? await input.publication.publishRepairLink({
          jobId: input.jobId,
          lease,
          issueNumber: batch.sourceIssueNumber,
          repairIssueUrl: issuePublication.remote.htmlUrl,
        })
      : undefined;
  const incompleteResult: RepairBatchResult = {
    ...scheduledResult,
    ...(issuePublication.remote === undefined
      ? {}
      : { repairIssue: issuePublication.remote }),
    issuePublication,
    linkPublication,
  };
  await input.store.save(key, incompleteResult, now());
  if (
    issuePublication.remote === undefined ||
    (batch.sourceIssueNumber !== undefined &&
      linkPublication?.remote === undefined)
  ) {
    return blocked(batch, "Repair issue publication is still in flight", {
      job: scheduled.job,
      dispatch: scheduled.dispatch,
      lease,
      issuePublication,
      linkPublication,
    });
  }
  const result: RepairBatchResult = {
    ...scheduledResult,
    repairIssue: issuePublication.remote,
    issuePublication,
    linkPublication,
  };
  await input.store.save(key, result, now());
  return result;
};

/** Execute a scheduled repair on the existing leased branch; review remains a separate phase. */
export const runBoundedRepair = async (
  input: RunBoundedRepairOptions,
): Promise<BoundedRepairExecutionResult> => {
  const repair = await scheduleBoundedRepair(input);
  if (repair.outcome === "blocked") {
    return { outcome: "blocked", reason: repair.reason, repair };
  }
  if (repair.outcome === "duplicate" && input.readCurrent === undefined) {
    const reason = "Current repair state is required to resume a saved repair";
    return {
      outcome: "blocked",
      reason,
      repair: { ...repair, outcome: "blocked", reason },
    };
  }
  const job = repair.job;
  if (job === undefined) {
    return {
      outcome: "blocked",
      reason: "Repair workflow job is missing",
      repair,
    };
  }
  const repairAssignmentId = repair.dispatch?.assignment?.id;
  const existing =
    repairAssignmentId === undefined
      ? undefined
      : [...job.phaseResults]
          .reverse()
          .find(
            (result) =>
              result.phase === "repair" &&
              result.assignmentId === repairAssignmentId,
          );
  if (existing !== undefined) {
    return {
      outcome:
        existing.outcome === "completed"
          ? "completed"
          : existing.outcome === "needs-info"
            ? "needs-info"
            : "failed",
      reason: existing.questions[0] ?? existing.summary,
      repair,
      phaseResult: existing,
      nextPhase: existing.outcome === "completed" ? "checking" : undefined,
    };
  }
  const dispatch = await input.coordinator.dispatchNext({
    repository: input.brief.identity.repository,
    workerId: input.workerId,
    jobId: job.id,
    dispatchId: repair.dispatch?.id ?? repair.resumeDispatchId,
  });
  if (dispatch.status !== "dispatched" || dispatch.assignment === undefined) {
    return {
      outcome: "blocked",
      reason: dispatch.reason ?? "Repair is not dispatchable",
      repair,
      dispatch,
    };
  }
  const assignment = dispatch.assignment;
  const lease = await input.coordinator.acquireBranchLease({
    repository: input.brief.identity.repository,
    branch: input.candidate.head.branch,
    jobId: job.id,
    workerId: input.workerId,
    ttlMs: input.leaseTtlMs ?? 60_000,
  });
  const execution = await executePhase({
    ...input.execution,
    assignment,
    branch: input.candidate.head.branch,
  });
  let phaseResult = execution.phaseResult;
  if (phaseResult.head?.branch !== input.candidate.head.branch) {
    phaseResult = {
      ...phaseResult,
      outcome: "failed",
      head: {
        branch: input.candidate.head.branch,
        sha: phaseResult.head?.sha ?? input.candidate.head.sha,
      },
      commits: [],
      summary: "Repair returned a head on a different branch",
    };
  }
  if (input.readCurrent !== undefined && phaseResult.head !== undefined) {
    let current: CurrentRepairCandidate;
    try {
      current = await input.readCurrent();
    } catch (error) {
      return {
        outcome: "blocked",
        reason: `Could not validate the repaired candidate: ${error instanceof Error ? error.message : String(error)}`,
        repair,
        assignment,
        dispatch,
        execution,
        phaseResult,
      };
    }
    if (
      !sameRevision(current.base, input.candidate.base) ||
      !sameRevision(current.head, phaseResult.head) ||
      current.briefHash !== input.brief.hash
    ) {
      return {
        outcome: "blocked",
        reason: "Repair candidate changed while the repair was running",
        repair,
        assignment,
        dispatch,
        execution,
        phaseResult,
      };
    }
  }
  await input.coordinator.recordPhaseResult({
    jobId: job.id,
    result: phaseResult,
    lease,
  });
  let nextDispatch: DispatchIntent | undefined;
  if (phaseResult.outcome === "completed" && phaseResult.head !== undefined) {
    const checking = await input.coordinator.schedulePhase({
      jobId: job.id,
      phase: "checking",
      relevantRevision: phaseResult.head.sha,
      head: phaseResult.head,
    });
    if (checking.status === "blocked") {
      return {
        outcome: "blocked",
        reason: checking.reason ?? "Checking could not be queued after repair",
        repair,
        assignment,
        dispatch,
        execution,
        phaseResult,
      };
    }
    nextDispatch = checking.dispatch;
  }
  return {
    outcome:
      phaseResult.outcome === "completed"
        ? "completed"
        : phaseResult.outcome === "needs-info"
          ? "needs-info"
          : "failed",
    reason: phaseResult.questions[0] ?? phaseResult.summary,
    repair,
    assignment,
    dispatch,
    execution,
    phaseResult,
    nextPhase: phaseResult.outcome === "completed" ? "checking" : undefined,
    nextDispatch,
  };
};
