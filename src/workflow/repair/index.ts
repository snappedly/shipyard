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
import {
  executePhase,
  type ExecutePhaseOptions,
  type PhaseExecutionResult,
} from "../execution/index.js";
import type {
  GitHubIssueSnapshot,
  GitHubPublication,
  GitHubPublicationResult,
  GitHubPullRequestSnapshot,
} from "../../integrations/github/index.js";
import { sameRevision } from "../shared.js";

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
  get(key: string): RepairBatchResult | undefined;
  save(key: string, result: RepairBatchResult): void;
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
  /** A merged delivery cannot be mutated; callers must start a follow-up. */
  readonly deliveryState?: "active" | "merged";
  /** Return the existing PR to draft before a repair changes its candidate. */
  readonly invalidateHandoff?: boolean;
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
  readonly lease?: BranchLease;
  readonly repairIssue?: GitHubIssueSnapshot;
  readonly issuePublication?: GitHubPublicationResult<GitHubIssueSnapshot>;
  readonly linkPublication?: GitHubPublicationResult<unknown>;
  readonly handoffInvalidation?: GitHubPublicationResult<GitHubPullRequestSnapshot>;
  readonly followUpRequired?: boolean;
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

const actionable = (finding: Finding): boolean =>
  finding.severity !== "info" &&
  (finding.disposition === "open" || finding.disposition === "deferred");

const normalizedFindings = (findings: readonly Finding[]): Finding[] => {
  const byKey = new Map<string, Finding>();
  for (const finding of findings) {
    if (!actionable(finding)) continue;
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

const publicationComplete = (result: RepairBatchResult): boolean =>
  result.issuePublication?.remote !== undefined &&
  (result.batch.sourceIssueNumber === undefined ||
    result.linkPublication?.remote !== undefined);

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
  const existing = input.store.get(key);
  if (existing !== undefined && publicationComplete(existing)) {
    return { ...existing, outcome: "duplicate" };
  }
  const batch = existing?.batch ?? requestedBatch;
  if (input.deliveryState === "merged") {
    return blocked(batch, "Post-merge repair requires a follow-up delivery", {
      followUpRequired: true,
    });
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
    const current = await input.readCurrent();
    if (
      !sameRevision(current.base, input.candidate.base) ||
      !sameRevision(current.head, input.candidate.head) ||
      current.briefHash !== brief.hash
    ) {
      return blocked(batch, "Repair candidate became stale before scheduling", {
        job,
      });
    }
    if (current.pullRequest?.state === "closed") {
      return blocked(batch, "The current pull request is closed or abandoned", {
        job,
      });
    }
  }

  // Persist the intent before spending coordinator budget or touching GitHub.
  // A retry can safely resume this intent because coordinator scheduling and
  // GitHub publication both use stable dedupe markers.
  input.store.save(key, { outcome: "scheduled", batch });
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
  const handoffInvalidation =
    input.invalidateHandoff === true && input.pullRequestNumber !== undefined
      ? await input.publication.invalidatePullRequestHandoff({
          jobId: input.jobId,
          lease,
          pullRequestNumber: input.pullRequestNumber,
          branch: input.candidate.head.branch,
          baseBranch: policy.baseBranch,
          headSha: input.candidate.head.sha,
          briefHash: brief.hash,
          reason:
            "Pre-merge repair or scope expansion invalidated the candidate",
        })
      : undefined;
  const scheduledResult: RepairBatchResult = {
    outcome: "scheduled",
    batch,
    job: scheduled.job,
    dispatch: scheduled.dispatch,
    lease,
    handoffInvalidation,
  };
  input.store.save(key, scheduledResult);
  const issuePublication = await input.publication.publishRepairIssue({
    jobId: input.jobId,
    lease,
    title: `[Shipyard] Repair PR #${input.pullRequestNumber ?? brief.identity.itemId}`,
    body: issueBody(batch, input.pullRequestNumber),
    labels: ["shipyard:pr-repair"],
  });
  const linkPublication =
    issuePublication.remote?.htmlUrl !== undefined &&
    input.sourceIssueNumber !== undefined
      ? await input.publication.publishRepairLink({
          jobId: input.jobId,
          lease,
          issueNumber: input.sourceIssueNumber,
          repairIssueUrl: issuePublication.remote.htmlUrl,
        })
      : undefined;
  const incompleteResult: RepairBatchResult = {
    ...scheduledResult,
    issuePublication,
    linkPublication,
  };
  input.store.save(key, incompleteResult);
  if (
    issuePublication.remote === undefined ||
    (input.sourceIssueNumber !== undefined &&
      linkPublication?.remote === undefined)
  ) {
    return blocked(batch, "Repair issue publication is still in flight", {
      job: scheduled.job,
      dispatch: scheduled.dispatch,
      lease,
      issuePublication,
      linkPublication,
      handoffInvalidation,
    });
  }
  const result: RepairBatchResult = {
    ...scheduledResult,
    repairIssue: issuePublication.remote,
    issuePublication,
    linkPublication,
  };
  input.store.save(key, result);
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
  const job = repair.job;
  if (job === undefined) {
    return {
      outcome: "blocked",
      reason: "Repair workflow job is missing",
      repair,
    };
  }
  const existing = [...job.phaseResults]
    .reverse()
    .find((result) => result.phase === "repair");
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
    dispatchId: repair.dispatch?.id,
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
