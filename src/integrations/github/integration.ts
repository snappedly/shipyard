import { createHash } from "node:crypto";
import {
  createWorkBrief,
  parseRepositoryPolicy,
  parseWorkBrief,
  type CheckEvidence,
  type WorkIdentity,
  type WorkItemKind,
  type WorkBrief,
} from "../../workflow/contracts/index.js";
import { runTriage, type TriageSource } from "../../workflow/triage/index.js";
import {
  completePlanningSpec,
  processHumanReviewDecision,
  type HumanReviewDecisionInput,
  type PlanningSpecCandidateMetadata,
  type PlanningSpecCompletionInput,
  type PlanningSpecCompletionResult,
} from "../../workflow/handoff/index.js";
import type { WorkflowCoordinator } from "../../workflow/coordinator/index.js";
import {
  LeaseBusyError,
  resolveDeliveryGroup,
  type DeliveryGroup,
  type DeliveryWorkflowState,
} from "../../workflow/coordinator/index.js";
import {
  GitHubPublication,
  parseGitHubPublicationMetadata,
} from "./publication.js";
import { verifyGitHubWebhookSignature } from "./signature.js";
import { InMemoryGitHubStore } from "./store.js";
import type {
  GitHubActor,
  GitHubAuthorizationPolicy,
  GitHubBriefFactoryInput,
  GitHubCommentSnapshot,
  GitHubDeliveryRecord,
  GitHubEventName,
  GitHubIgnoredEvent,
  GitHubIntegrationOptions,
  GitHubIssueSnapshot,
  GitHubInfrastructureFailureInput,
  GitHubInfrastructureFailureResult,
  GitHubNormalizationResult,
  GitHubNormalizedEvent,
  GitHubPullRequestReviewSnapshot,
  GitHubPullRequestReviewHandler,
  GitHubPlanningSpecCompletionHandler,
  GitHubReadTransport,
  GitHubPlanningSpecScope,
  GitHubReconciliationInput,
  GitHubReconciliationResult,
  GitHubTrackedPullRequest,
  GitHubWebhookEnvelope,
  GitHubWebhookReceipt,
  GitHubWebhookRequest,
} from "./types.js";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const record = (value: unknown): JsonRecord | undefined =>
  isRecord(value) ? value : undefined;

const stringValue = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const requiredStringValue = (value: unknown): string | undefined => {
  const result = stringValue(value).trim();
  return result.length === 0 ? undefined : result;
};

const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;

const header = (
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === wanted,
  );
  return key === undefined ? undefined : headers[key];
};

const bodyBytes = (body: string | Uint8Array): Uint8Array =>
  typeof body === "string" ? new TextEncoder().encode(body) : body;

const bodyText = (body: string | Uint8Array): string =>
  typeof body === "string" ? body : new TextDecoder().decode(body);

const payloadHash = (body: string | Uint8Array): string =>
  createHash("sha256").update(bodyBytes(body)).digest("hex");

const MAX_WEBHOOK_BODY_BYTES = 10 * 1024 * 1024;

const parseBody = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

const actor = (value: unknown): GitHubActor => {
  const candidate = record(value);
  return {
    login: stringValue(candidate?.login, "unknown"),
    type: stringValue(candidate?.type) || undefined,
  };
};

const repositoryName = (payload: JsonRecord): string | undefined =>
  requiredStringValue(record(payload.repository)?.full_name);

const sender = (payload: JsonRecord): GitHubActor =>
  actor(payload.sender ?? record(payload.comment)?.user ?? undefined);

const labels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "string" ? entry : stringValue(record(entry)?.name),
    )
    .filter((entry) => entry.length > 0);
};

const addedLabel = (payload: JsonRecord): string | undefined =>
  requiredStringValue(record(payload.label)?.name);

const state = (value: unknown): "open" | "closed" =>
  value === "closed" ? "closed" : "open";

const allowedEventNames = new Set<GitHubEventName>([
  "issues",
  "issue_comment",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "check_run",
  "check_suite",
]);

const supportedActions: Readonly<Record<GitHubEventName, readonly string[]>> = {
  issues: ["opened", "edited", "reopened", "closed", "labeled", "unlabeled"],
  issue_comment: ["created", "edited"],
  pull_request: [
    "opened",
    "edited",
    "reopened",
    "closed",
    "synchronize",
    "ready_for_review",
    "converted_to_draft",
  ],
  pull_request_review: ["submitted", "edited", "dismissed"],
  pull_request_review_comment: ["created", "edited", "deleted"],
  check_run: ["created", "rerequested", "completed"],
  check_suite: ["completed", "requested", "rerequested"],
};

const ignored = (input: {
  readonly reason: GitHubIgnoredEvent["reason"];
  readonly eventName: string;
  readonly action?: string;
  readonly deliveryId: string;
  readonly repository: string;
  readonly sender: GitHubActor;
}): GitHubIgnoredEvent => ({ disposition: "ignored", ...input });

const issueSnapshot = (
  payload: JsonRecord,
): GitHubIssueSnapshot | undefined => {
  const value = record(payload.issue);
  const number = numberValue(value?.number);
  if (value === undefined || number === undefined) return undefined;
  return {
    number,
    title: stringValue(value.title, "Untitled issue"),
    body: stringValue(value.body),
    state: state(value.state),
    updatedAt: stringValue(value.updated_at),
    htmlUrl: requiredStringValue(value.html_url),
    authorLogin: requiredStringValue(record(value.user)?.login),
    labels: labels(value.labels),
    pullRequestNumber: numberValue(record(value.pull_request)?.number),
  };
};

const commentSnapshot = (
  payload: JsonRecord,
): GitHubCommentSnapshot | undefined => {
  const value = record(payload.comment);
  const id = requiredStringValue(value?.id);
  if (value === undefined || id === undefined) return undefined;
  return {
    id,
    body: stringValue(value.body),
    updatedAt: stringValue(value.updated_at),
    htmlUrl: requiredStringValue(value.html_url),
    authorLogin: requiredStringValue(record(value.user)?.login),
  };
};

const reviewState = (
  value: unknown,
): GitHubPullRequestReviewSnapshot["state"] | undefined => {
  const normalized = requiredStringValue(value)
    ?.toLowerCase()
    .replaceAll("_", "-");
  switch (normalized) {
    case "approved":
    case "changes-requested":
    case "commented":
    case "dismissed":
    case "pending":
      return normalized;
    default:
      return undefined;
  }
};

const reviewSnapshot = (
  payload: JsonRecord,
): GitHubPullRequestReviewSnapshot | undefined => {
  const value = record(payload.review);
  if (value === undefined) return undefined;
  const rawId = value.id;
  const id =
    typeof rawId === "number" && Number.isInteger(rawId) && rawId > 0
      ? String(rawId)
      : requiredStringValue(rawId);
  const state = reviewState(value.state);
  const pullRequest = record(payload.pull_request);
  const headSha =
    requiredStringValue(value.commit_id) ??
    requiredStringValue(record(pullRequest?.head)?.sha);
  const submittedAt =
    requiredStringValue(value.submitted_at) ??
    requiredStringValue(value.updated_at) ??
    requiredStringValue(value.created_at);
  if (
    id === undefined ||
    state === undefined ||
    headSha === undefined ||
    submittedAt === undefined
  ) {
    return undefined;
  }
  return {
    id,
    state,
    headSha,
    submittedAt,
    authorLogin: requiredStringValue(record(value.user)?.login),
  };
};

export const reviewDecisionFor = (
  review: GitHubPullRequestReviewSnapshot,
): HumanReviewDecisionInput | undefined => {
  switch (review.state) {
    case "approved":
      return { decision: "approved" };
    case "changes-requested":
      return { decision: "changes-requested" };
    case "dismissed":
      return { decision: "rejected", reason: "GitHub review was dismissed" };
    case "commented":
    case "pending":
      return undefined;
  }
};

const pullRequestNumber = (payload: JsonRecord): number | undefined => {
  const direct = numberValue(record(payload.pull_request)?.number);
  if (direct !== undefined) return direct;
  const issue = numberValue(record(payload.issue)?.number);
  if (
    issue !== undefined &&
    record(payload.issue)?.pull_request !== undefined
  ) {
    return issue;
  }
  const check = record(payload.check_run) ?? record(payload.check_suite);
  const pullRequests = check?.pull_requests;
  if (Array.isArray(pullRequests)) {
    return numberValue(record(pullRequests[0])?.number);
  }
  return undefined;
};

const pullRequestHead = (payload: JsonRecord, fallback: string): string =>
  requiredStringValue(record(record(payload.pull_request)?.head)?.sha) ??
  requiredStringValue(record(payload.check_run)?.head_sha) ??
  requiredStringValue(record(payload.check_suite)?.head_sha) ??
  fallback;

const issueKind = (issue: GitHubIssueSnapshot): WorkItemKind => {
  const normalized = new Set(issue.labels.map((label) => label.toLowerCase()));
  if (
    normalized.has("planning-spec") ||
    normalized.has("planning") ||
    /^\s*(?:\*\*)?work item type:(?:\*\*)?\s*planning spec\b/im.test(issue.body)
  ) {
    return "planning-spec";
  }
  if (normalized.has("pr-repair") || normalized.has("repair")) {
    return "pr-repair";
  }
  return "executable-issue";
};

const issueReferences = (body: string, field: string): number[] => {
  const line = body
    .split(/\r?\n/)
    .find((entry) =>
      entry.toLowerCase().startsWith(`shipyard-${field.toLowerCase()}:`),
    );
  if (line === undefined) return [];
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!/^(?:#\d+)(?:[\s,]+#\d+)*$/.test(value)) {
    throw new Error(`Invalid Shipyard-${field} issue references`);
  }
  return [
    ...new Set([...value.matchAll(/#(\d+)/g)].map((match) => Number(match[1]))),
  ];
};

const sameIssueContent = (
  brief: WorkBrief,
  issue: GitHubIssueSnapshot,
): boolean =>
  (brief.problem ===
    `${issue.title}\n\n${issue.body || "(empty issue body)"}` ||
    brief.problem === issue.title) &&
  brief.source.originalBody === (issue.body || "(empty issue body)");

export const createGitHubIssueBrief = (
  input: GitHubBriefFactoryInput,
): WorkBrief => {
  const issue = input.event;
  return createWorkBrief({
    id: `${issue.repository}:${issue.kind}:${issue.issueNumber}`,
    revision: input.revision,
    identity: {
      repository: issue.repository,
      itemId: String(issue.issueNumber),
      kind: input.itemKind,
    },
    source: {
      provider: "github",
      repository: issue.repository,
      itemId: String(issue.issueNumber),
      url: issue.reply?.htmlUrl ?? issue.trackedPullRequest?.brief.source.url,
      originalBody: issue.body || "(empty issue body)",
      author: issue.reply?.authorLogin,
    },
    problem: issue.title + "\n\n" + (issue.body || "(empty issue body)"),
    evidence: ["Submitted through authenticated GitHub intake."],
    acceptanceCriteria: input.defaults?.acceptanceCriteria ?? [],
    exclusions: input.defaults?.exclusions ?? [],
    risk: input.defaults?.risk ?? "medium",
    verification: {
      checks: input.policy.checks.map((check) => check.command),
      artifacts: input.defaults?.verificationArtifacts ?? [],
    },
    unresolvedQuestions: input.defaults?.unresolvedQuestions ?? [
      "A maintainer must confirm acceptance criteria and execution authorization.",
    ],
    authorization: { status: "pending" },
    base: input.base,
    policyRevision: input.policy.revision,
    skillRevision: input.policy.worker.skillRevision,
    createdAt: issue.observedAt,
  });
};

export interface GitHubPlanningSpecScopeReader {
  read(input: {
    readonly repository: string;
    readonly parentIssueNumber: number;
    readonly trackedPullRequest: GitHubTrackedPullRequest;
    readonly delivery: DeliveryWorkflowState;
    readonly transport: GitHubReadTransport;
  }): Promise<GitHubPlanningSpecScope>;
}

export interface CreateGitHubPlanningSpecCompletionHandlerOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly publication: GitHubPublication;
  readonly scope: GitHubPlanningSpecScopeReader;
  readonly workerId?:
    | string
    | ((input: {
        readonly repository: string;
        readonly pullRequestNumber: number;
      }) => string);
  readonly leaseTtlMs?: number;
}

const expectedPlanningSpecMetadata = (
  tracked: GitHubTrackedPullRequest,
): PlanningSpecCandidateMetadata => ({
  repository: tracked.brief.identity.repository,
  itemId: tracked.brief.identity.itemId,
  kind: "planning-spec",
  briefRevision: tracked.brief.revision,
  briefHash: tracked.brief.hash,
  baseBranch: tracked.policy.baseBranch,
  baseSha: tracked.brief.base.sha,
  branch: tracked.branch,
  headSha: tracked.headSha,
});

const matchesPlanningSpecMetadata = (
  actual: PlanningSpecCandidateMetadata | undefined,
  expected: PlanningSpecCandidateMetadata,
): boolean =>
  actual !== undefined &&
  actual.repository === expected.repository &&
  actual.itemId === expected.itemId &&
  actual.kind === expected.kind &&
  actual.briefRevision === expected.briefRevision &&
  actual.briefHash === expected.briefHash &&
  actual.baseBranch === expected.baseBranch &&
  actual.baseSha === expected.baseSha &&
  actual.branch === expected.branch &&
  actual.headSha === expected.headSha;

const providerCheckEvidence = (
  checks: readonly {
    readonly name: string;
    readonly headSha: string;
    readonly status: "queued" | "in_progress" | "completed";
    readonly conclusion?:
      | "success"
      | "failure"
      | "neutral"
      | "cancelled"
      | "timed_out"
      | "action_required"
      | "stale"
      | "skipped";
  }[],
  expected: PlanningSpecCandidateMetadata,
): readonly CheckEvidence[] =>
  checks.map((check) => ({
    name: check.name,
    command: check.name,
    status:
      check.status !== "completed"
        ? "incomplete"
        : check.conclusion === "success"
          ? "passed"
          : "failed",
    summary:
      check.status === "completed"
        ? `Provider conclusion: ${check.conclusion ?? "unknown"}`
        : `Provider status: ${check.status}`,
    baseSha: expected.baseSha,
    headSha: check.headSha,
    briefHash: expected.briefHash,
  }));

const coordinatorBlockers = (
  delivery: DeliveryWorkflowState,
): readonly {
  readonly id: string;
  readonly active: boolean;
  readonly reason?: string;
}[] =>
  delivery.jobs
    .filter(
      (job) =>
        job.brief.identity.kind !== "planning-spec" &&
        (job.control !== "active" ||
          job.state === "blocked" ||
          job.state === "failed" ||
          job.state === "cancelled"),
    )
    .map((job) => ({
      id: `coordinator:${job.brief.identity.itemId}`,
      active: true,
      reason: job.lastInfrastructureFailure?.error ?? `Job is ${job.state}`,
    }));

const missingPlanningSpecPullRequest = (
  expected: PlanningSpecCandidateMetadata,
  pullRequestNumber: number,
): PlanningSpecCompletionResult => ({
  outcome: "open",
  reason: "Integration pull request is not currently published",
  candidate: {
    metadata: { ...expected, headSha: "missing" },
    pullRequestNumber,
    state: "open",
    draft: true,
    merged: false,
    branch: expected.branch,
    baseBranch: expected.baseBranch,
    headSha: "missing",
  },
  originalChildren: [],
  repairChildren: [],
  blockers: [],
});

/** Build the provider-backed aggregate reconciler used by GitHub intake. */
export const createGitHubPlanningSpecCompletionHandler = (
  options: CreateGitHubPlanningSpecCompletionHandlerOptions,
): GitHubPlanningSpecCompletionHandler => ({
  reconcile: async ({
    repository,
    pullRequestNumber,
    trackedPullRequest,
    transport,
  }) => {
    const expected = expectedPlanningSpecMetadata(trackedPullRequest);
    const pullRequest = await transport.fetchPullRequest({
      repository,
      pullRequestNumber,
    });
    if (pullRequest === undefined) {
      return missingPlanningSpecPullRequest(expected, pullRequestNumber);
    }
    const parsedMetadata = parseGitHubPublicationMetadata(pullRequest.body);
    const metadata =
      parsedMetadata?.kind === "planning-spec"
        ? { ...parsedMetadata, kind: "planning-spec" as const }
        : undefined;
    const delivery = await options.coordinator.getDeliveryWorkflowState({
      repository,
      itemId: trackedPullRequest.brief.identity.itemId,
    });
    if (delivery === undefined) {
      return {
        outcome: "open",
        reason: "Planning-spec delivery record is missing",
        candidate: {
          metadata: metadata ?? { ...expected, headSha: "metadata-missing" },
          pullRequestNumber: pullRequest.number,
          pullRequestUrl: pullRequest.htmlUrl,
          state: pullRequest.state,
          draft: pullRequest.draft,
          merged: pullRequest.merged === true,
          mergedSha: pullRequest.mergedSha,
          branch: pullRequest.branch,
          baseBranch: pullRequest.baseBranch,
          headSha: pullRequest.headSha,
        },
        originalChildren: [],
        repairChildren: [],
        blockers: [],
      };
    }
    if (
      pullRequest.state === "closed" &&
      pullRequest.merged === true &&
      pullRequest.mergedSha !== undefined &&
      pullRequest.mergedSha.length > 0 &&
      pullRequest.branch === expected.branch &&
      pullRequest.baseBranch === expected.baseBranch &&
      pullRequest.headSha === expected.headSha &&
      matchesPlanningSpecMetadata(metadata, expected)
    ) {
      await options.coordinator.markDeliveryMerged(
        delivery.delivery.key,
        pullRequest.mergedSha,
      );
    }
    const scope = await options.scope.read({
      repository,
      parentIssueNumber: Number(trackedPullRequest.brief.identity.itemId),
      trackedPullRequest,
      delivery,
      transport,
    });
    const expectedChildIds = new Set(
      delivery.delivery.graph.children.map((child) => child.itemId),
    );
    const actualChildIds = new Set(
      scope.originalChildren.map((child) => String(child.number)),
    );
    const scopeBlocker =
      expectedChildIds.size !== actualChildIds.size ||
      [...expectedChildIds].some((itemId) => !actualChildIds.has(itemId))
        ? {
            id: "scope:original-children",
            active: true,
            reason:
              "Provider scope does not contain every original delivery child",
          }
        : undefined;
    const providerChecks =
      pullRequest.mergedSha === undefined || transport.fetchChecks === undefined
        ? []
        : providerCheckEvidence(
            await transport.fetchChecks({
              repository,
              headSha: pullRequest.mergedSha,
            }),
            expected,
          );
    const candidate = {
      metadata: metadata ?? { ...expected, headSha: "metadata-missing" },
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.htmlUrl,
      state: pullRequest.state,
      draft: pullRequest.draft,
      merged: pullRequest.merged === true,
      mergedSha: pullRequest.mergedSha,
      branch: pullRequest.branch,
      baseBranch: pullRequest.baseBranch,
      headSha: pullRequest.headSha,
    } as const;
    const completionInput: PlanningSpecCompletionInput = {
      policy: trackedPullRequest.policy,
      parentIssueNumber: Number(trackedPullRequest.brief.identity.itemId),
      expected,
      candidate,
      checks: providerChecks,
      originalChildren: scope.originalChildren,
      repairChildren: scope.repairChildren,
      blockers: [
        ...(scope.blockers ?? []),
        ...(scopeBlocker === undefined ? [] : [scopeBlocker]),
        ...coordinatorBlockers(delivery),
      ],
    };
    const completion = completePlanningSpec(completionInput);
    if (completion.outcome === "open") return completion;

    const workerId =
      typeof options.workerId === "function"
        ? options.workerId({ repository, pullRequestNumber })
        : (options.workerId ??
          `github-planning-spec:${repository}#${pullRequestNumber}`);
    let lease;
    try {
      lease = await options.coordinator.acquireBranchLease({
        repository,
        branch: candidate.branch,
        jobId: trackedPullRequest.jobId,
        workerId,
        ttlMs: options.leaseTtlMs ?? 60_000,
      });
    } catch (error) {
      return {
        ...completion,
        outcome: "open",
        reason:
          error instanceof LeaseBusyError
            ? "Planning-spec completion is already being reconciled"
            : `Could not acquire the reconciliation lease: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    try {
      const publication = await options.publication.publishPlanningSpecClosure({
        jobId: trackedPullRequest.jobId,
        lease,
        parentIssueNumber: completionInput.parentIssueNumber,
        pullRequestNumber: candidate.pullRequestNumber,
        pullRequestUrl: candidate.pullRequestUrl,
        mergedSha: completion.mergedSha ?? "",
        originalChildren: completion.originalChildren,
        repairChildren: completion.repairChildren,
      });
      if (publication.issue === undefined) {
        return {
          ...completion,
          outcome: "open",
          reason: "Planning-spec closure publication is still in flight",
        };
      }
    } catch (error) {
      return {
        ...completion,
        outcome: "open",
        reason: `Could not publish planning-spec completion: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return completion;
  },
});

const eventName = (value: string): GitHubEventName | undefined =>
  allowedEventNames.has(value as GitHubEventName)
    ? (value as GitHubEventName)
    : undefined;

export class GitHubIntegration {
  private readonly options: GitHubIntegrationOptions;
  private readonly now: () => string;

  constructor(options: GitHubIntegrationOptions) {
    this.options = {
      ...options,
      policy: parseRepositoryPolicy(options.policy),
    };
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private async projectionLease(jobId: string, branch: string) {
    const job = await this.options.coordinator.getJob(jobId);
    if (job === undefined) throw new Error("Workflow job does not exist");
    return this.options.coordinator.acquireBranchLease({
      repository: job.key.repository,
      branch,
      jobId,
      workerId: `github-projection:${jobId}`,
      ttlMs: 60_000,
    });
  }

  /** Record bounded failure and project exhausted work to its source issue. */
  async recordInfrastructureFailure(
    input: GitHubInfrastructureFailureInput,
  ): Promise<GitHubInfrastructureFailureResult> {
    if (this.options.publication === undefined) {
      throw new Error("Blocked delivery publication is not configured");
    }
    const result =
      await this.options.coordinator.recordInfrastructureFailure(input);
    if (result.status !== "exhausted") return result;
    await this.projectBlockedJob(result.job.id, input.lease);
    return { ...result, blockedProjected: true };
  }

  /** Retryable projection after a crash between durable blocking and GitHub. */
  async projectBlockedJob(
    jobId: string,
    lease?: GitHubInfrastructureFailureInput["lease"],
  ): Promise<boolean> {
    const publication = this.options.publication;
    if (publication === undefined) {
      throw new Error("Blocked delivery publication is not configured");
    }
    const job = await this.options.coordinator.getJob(jobId);
    if (job?.blocked === undefined) return false;
    const issueNumber = Number(job.key.itemId);
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("GitHub workflow item has no issue number");
    }
    const tracked =
      await this.options.trackingStore?.findTrackedPullRequestByJob?.(jobId);
    const branch =
      tracked?.branch ??
      job.blocked.evidence.branch ??
      `shipyard/issue-${job.key.itemId}`;
    const currentLease = lease ?? (await this.projectionLease(jobId, branch));
    const parentIssueNumber = Number(job.deliveryKey.itemId);
    await publication.publishBlockedDelivery({
      jobId,
      lease: currentLease,
      issueNumber,
      evidence: job.blocked.evidence,
      parentIssueNumber:
        job.deliveryKey.itemId === job.key.itemId ||
        !Number.isSafeInteger(parentIssueNumber)
          ? undefined
          : parentIssueNumber,
      pullRequest:
        tracked === undefined
          ? undefined
          : {
              number: tracked.pullRequestNumber,
              branch: tracked.branch,
              baseBranch: tracked.policy.baseBranch,
              headSha: tracked.headSha,
            },
    });
    return true;
  }

  private async deliveryForIssue(
    repository: string,
    issue: GitHubIssueSnapshot,
    kind: WorkItemKind,
  ): Promise<DeliveryGroup | undefined> {
    const relationships = this.options.relationships;
    const fallbackParent = issueReferences(issue.body, "Parent")[0];
    if (relationships === undefined) {
      if (
        fallbackParent !== undefined ||
        issueReferences(issue.body, "Children").length > 0
      ) {
        throw new Error(
          "Issue relationships require a GitHub relationship reader",
        );
      }
      return undefined;
    }
    const parent =
      kind === "planning-spec"
        ? issue
        : ((await relationships.fetchParentIssue?.({
            repository,
            issueNumber: issue.number,
          })) ??
          (fallbackParent === undefined
            ? undefined
            : await relationships.fetchIssue({
                repository,
                issueNumber: fallbackParent,
              })));
    if (parent === undefined) return undefined;
    if (issueKind(parent) !== "planning-spec") {
      throw new Error(`Parent issue ${parent.number} is not a planning spec`);
    }
    const nativeChildren = await relationships.fetchSubIssues?.({
      repository,
      issueNumber: parent.number,
    });
    const fallbackChildren = nativeChildren?.length
      ? []
      : issueReferences(parent.body, "Children");
    const fetched = await Promise.all(
      fallbackChildren.map((issueNumber) =>
        relationships.fetchIssue({ repository, issueNumber }),
      ),
    );
    if (fetched.some((child) => child === undefined)) {
      throw new Error(
        `Planning spec ${parent.number} has a missing child issue`,
      );
    }
    const children = new Map<number, GitHubIssueSnapshot>();
    for (const child of [...(nativeChildren ?? []), ...fetched]) {
      if (child !== undefined) children.set(child.number, child);
    }
    if (parent.number !== issue.number) children.set(issue.number, issue);
    const dependencies = await Promise.all(
      [...children.values()].map(async (child) => {
        const native = await relationships.fetchBlockedBy?.({
          repository,
          issueNumber: child.number,
        });
        return {
          itemId: String(child.number),
          dependsOn: (native?.length
            ? native.map((dependency) => dependency.number)
            : issueReferences(child.body, "Depends-On")
          ).map(String),
        };
      }),
    );
    return resolveDeliveryGroup({
      issue: {
        repository,
        itemId: String(parent.number),
        kind: "planning-spec",
      },
      children: [...children.values()].map((child) => ({
        repository,
        itemId: String(child.number),
        kind: issueKind(child),
      })),
      dependencies,
    });
  }

  async receiveWebhook(
    request: GitHubWebhookRequest,
  ): Promise<GitHubWebhookReceipt> {
    const deliveryId = header(request.headers, "x-github-delivery");
    const eventHeader = header(request.headers, "x-github-event");
    if (deliveryId === undefined || eventHeader === undefined) {
      return {
        status: "rejected",
        deliveryId: deliveryId ?? "unknown",
        reason: "missing-delivery-or-event-header",
      };
    }
    if (bodyBytes(request.body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
      return { status: "rejected", deliveryId, reason: "body-too-large" };
    }
    const body = bodyText(request.body);
    if (
      !verifyGitHubWebhookSignature({
        body: request.body,
        signature: header(request.headers, "x-hub-signature-256"),
        secret: this.options.webhookSecret,
      })
    ) {
      return { status: "rejected", deliveryId, reason: "invalid-signature" };
    }
    return this.processEnvelope({
      eventName: eventHeader,
      deliveryId,
      payload: parseBody(body),
      receivedAt: this.now(),
      body,
    });
  }

  async normalize(
    envelope: GitHubWebhookEnvelope,
  ): Promise<GitHubNormalizationResult> {
    const payload = record(envelope.payload);
    const name = eventName(envelope.eventName);
    const repository = payload
      ? (repositoryName(payload) ?? "unknown")
      : "unknown";
    const source = payload ? sender(payload) : { login: "unknown" };
    if (name === undefined) {
      return ignored({
        reason: "unsupported-event",
        eventName: envelope.eventName,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }
    const action = stringValue(payload?.action);
    if (!supportedActions[name].includes(action)) {
      return ignored({
        reason: "unsupported-action",
        eventName: name,
        action,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }
    if (payload === undefined) {
      return ignored({
        reason: "unsupported-event",
        eventName: name,
        action,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }

    if (name === "issues" || name === "issue_comment") {
      const issue = issueSnapshot(payload);
      if (issue === undefined) {
        return ignored({
          reason: "unsupported-event",
          eventName: name,
          action,
          deliveryId: envelope.deliveryId,
          repository,
          sender: source,
        });
      }
      const issueIsPullRequest =
        issue.pullRequestNumber !== undefined ||
        record(record(payload.issue)?.pull_request) !== undefined;
      if (issueIsPullRequest) {
        return this.normalizeTrackedPullRequest(
          envelope,
          payload,
          issue.pullRequestNumber ?? issue.number,
          name === "issue_comment" ? commentSnapshot(payload) : undefined,
        );
      }
      const kind = issueKind(issue);
      const draft: Omit<GitHubNormalizedEvent, "workflowEvent"> = {
        kind:
          name === "issue_comment"
            ? "issue-replied"
            : action === "opened" || action === "reopened"
              ? "issue-created"
              : "issue-edited",
        eventName: name,
        action,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        relevantRevision: issue.updatedAt || envelope.receivedAt,
        observedAt: issue.updatedAt || envelope.receivedAt,
        sourceState: issue.state,
        resumeRequested:
          name === "issues" &&
          action === "labeled" &&
          addedLabel(payload)?.toLowerCase() === "shipyard",
        reply: name === "issue_comment" ? commentSnapshot(payload) : undefined,
      };
      const brief = await this.briefForIssue(draft, issue, kind);
      const delivery = await this.deliveryForIssue(repository, issue, kind);
      return {
        disposition: "accepted",
        event: {
          ...draft,
          workflowEvent: {
            deliveryId: envelope.deliveryId,
            brief,
            delivery,
            policy: this.options.policy,
            phase: "triage",
            relevantRevision: draft.relevantRevision,
            observedAt: draft.observedAt,
            sourceState: draft.sourceState,
            resumeRequested: draft.resumeRequested,
            payload: envelope.payload,
          },
        },
      };
    }

    const number = pullRequestNumber(payload);
    if (number === undefined) {
      return ignored({
        reason: "unrelated-pull-request",
        eventName: name,
        action,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }
    const review =
      name === "pull_request_review" ? reviewSnapshot(payload) : undefined;
    if (name === "pull_request_review" && review === undefined) {
      return ignored({
        reason: "unsupported-event",
        eventName: name,
        action,
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }
    return this.normalizeTrackedPullRequest(
      envelope,
      payload,
      number,
      undefined,
      review,
    );
  }

  async reconcile(
    input: GitHubReconciliationInput,
  ): Promise<GitHubReconciliationResult> {
    const hasIssue = input.issueNumber !== undefined;
    const hasPullRequest = input.pullRequestNumber !== undefined;
    if (hasIssue === hasPullRequest) {
      throw new Error(
        "Reconciliation requires exactly one issue or pull request",
      );
    }
    if (hasIssue) {
      const issue = await input.transport.fetchIssue({
        repository: input.repository,
        issueNumber: input.issueNumber!,
      });
      if (issue === undefined) {
        return {
          status: "not-found",
          deliveryId: `reconcile:issue:${input.repository}:${input.issueNumber}`,
        };
      }
      const payload = this.issuePayload(issue, input.repository);
      return this.toReconciliationResult(
        await this.processEnvelope(
          {
            eventName: "issues",
            deliveryId: `reconcile:issue:${input.repository}:${issue.number}:${issue.updatedAt}`,
            payload,
            receivedAt: this.now(),
          },
          true,
          input.transport,
        ),
      );
    }
    const pullRequest = await input.transport.fetchPullRequest({
      repository: input.repository,
      pullRequestNumber: input.pullRequestNumber!,
    });
    if (pullRequest === undefined) {
      return {
        status: "not-found",
        deliveryId: `reconcile:pull-request:${input.repository}:${input.pullRequestNumber}`,
      };
    }
    const receipt = await this.processEnvelope(
      {
        eventName: "pull_request",
        deliveryId: `reconcile:pull-request:${input.repository}:${pullRequest.number}:${pullRequest.headSha}`,
        payload: this.pullRequestPayload(pullRequest, input.repository),
        receivedAt: this.now(),
      },
      true,
      input.transport,
    );
    const baseResult = this.toReconciliationResult(receipt);
    const tracked = this.options.trackingStore
      ? await this.options.trackingStore.findTrackedPullRequest(
          input.repository,
          pullRequest.number,
        )
      : undefined;
    if (
      this.options.planningSpecCompletion === undefined ||
      tracked === undefined ||
      tracked.brief.identity.kind !== "planning-spec"
    ) {
      return baseResult;
    }
    try {
      const planningSpecCompletion =
        await this.options.planningSpecCompletion.reconcile({
          repository: input.repository,
          pullRequestNumber: pullRequest.number,
          trackedPullRequest: tracked,
          transport: input.transport,
        });
      return { ...baseResult, planningSpecCompletion };
    } catch (error) {
      return {
        ...baseResult,
        reason: `planning-spec reconciliation failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  private async processEnvelope(
    envelope: GitHubWebhookEnvelope & { readonly body?: string },
    trustedReconciliation = false,
    readTransport = this.options.readTransport,
  ): Promise<GitHubWebhookReceipt> {
    const payload = record(envelope.payload);
    const repository = payload
      ? (repositoryName(payload) ?? "unknown")
      : "unknown";
    const source = payload ? sender(payload) : { login: "unknown" };
    const body = envelope.body ?? JSON.stringify(envelope.payload);
    const delivery: GitHubDeliveryRecord = {
      deliveryId: envelope.deliveryId,
      eventName: envelope.eventName,
      repository,
      senderLogin: source.login,
      receivedAt: envelope.receivedAt,
      payloadHash: payloadHash(body),
      payload: envelope.payload,
      status: "received",
    };
    const stored =
      await this.options.deliveryStore.recordDeliveryIfAbsent(delivery);
    if (!stored.inserted && stored.delivery.status !== "received") {
      return { status: "duplicate", deliveryId: envelope.deliveryId };
    }
    const effectiveEnvelope = stored.inserted
      ? envelope
      : {
          ...envelope,
          payload: stored.delivery.payload,
          receivedAt: stored.delivery.receivedAt,
          body: JSON.stringify(stored.delivery.payload),
        };
    const effectiveDelivery = stored.inserted ? delivery : stored.delivery;
    if (
      !allowedRepository(
        this.options.authorization,
        effectiveDelivery.repository,
      )
    ) {
      return this.rejectStored(effectiveDelivery, "disallowed-repository");
    }
    const effectivePayload = record(effectiveEnvelope.payload);
    const effectiveSource = effectivePayload
      ? sender(effectivePayload)
      : { login: "unknown" };
    if (
      !trustedReconciliation &&
      isBot(effectiveSource, this.options.authorization)
    ) {
      return this.ignoreStored(effectiveDelivery, "bot-originated");
    }
    if (!trustedReconciliation) {
      const isReview = effectiveEnvelope.eventName === "pull_request_review";
      const authorized = isReview
        ? allowedReviewer(this.options.authorization, effectiveSource)
        : allowedSender(this.options.authorization, effectiveSource);
      if (!authorized) {
        return this.rejectStored(
          effectiveDelivery,
          isReview ? "disallowed-reviewer" : "disallowed-sender",
        );
      }
    }
    const normalized = await this.normalize(effectiveEnvelope);
    if (normalized.disposition === "ignored") {
      return this.ignoreStored(effectiveDelivery, normalized.reason);
    }
    if (normalized.event.review !== undefined) {
      const tracked = normalized.event.trackedPullRequest;
      const handler = this.options.reviewHandler;
      const decision = reviewDecisionFor(normalized.event.review);
      if (handler === undefined) {
        return this.rejectStored(
          effectiveDelivery,
          "review-handler-unconfigured",
        );
      }
      if (tracked === undefined) {
        return this.rejectStored(
          effectiveDelivery,
          "review-missing-tracked-pull-request",
        );
      }
      if (decision === undefined) {
        return this.ignoreStored(effectiveDelivery, "review-without-decision");
      }
      const candidate = {
        base: tracked.brief.base,
        head: {
          branch: tracked.branch,
          sha: normalized.event.review.headSha,
        },
        briefHash: tracked.brief.hash,
      };
      let reviewResult: Awaited<ReturnType<typeof processHumanReviewDecision>>;
      try {
        reviewResult = await processHumanReviewDecision({
          candidate,
          decision,
          pullRequestNumber: tracked.pullRequestNumber,
          readCurrent: () =>
            handler.readCurrent({
              candidate,
              trackedPullRequest: tracked,
            }),
          requestRepair: handler.requestRepair,
        });
      } catch (error) {
        return this.rejectStored(
          effectiveDelivery,
          `review-handler-failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const status =
        reviewResult.outcome === "blocked" ? "ignored" : "accepted";
      await this.options.deliveryStore.updateDelivery({
        ...effectiveDelivery,
        status,
        eventKind: normalized.event.kind,
        jobId: tracked.jobId,
        reason: reviewResult.reason,
      });
      return {
        status,
        deliveryId: envelope.deliveryId,
        event: normalized.event,
        review: reviewResult,
        reason: reviewResult.reason,
      };
    }
    const trackedPlanningSpec = normalized.event.trackedPullRequest;
    if (trackedPlanningSpec !== undefined) {
      const pullRequest = record(
        record(effectiveEnvelope.payload)?.pull_request,
      );
      const mergedSha = requiredStringValue(pullRequest?.merge_commit_sha);
      if (
        pullRequest?.state === "closed" &&
        pullRequest.merged === true &&
        mergedSha !== undefined
      ) {
        await this.options.coordinator.markDeliveryMerged(
          {
            repository: trackedPlanningSpec.repository,
            itemId: trackedPlanningSpec.itemId,
          },
          mergedSha,
        );
      }
    }
    if (
      trackedPlanningSpec !== undefined &&
      trackedPlanningSpec.brief.identity.kind === "planning-spec"
    ) {
      // A planning-spec PR event is provider evidence for the aggregate
      // record, not a new executable phase. Feeding it back through intake
      // would supersede or close the parent based on the PR's own state.
      await this.options.deliveryStore.updateDelivery({
        ...effectiveDelivery,
        status: "accepted",
        eventKind: normalized.event.kind,
        jobId: trackedPlanningSpec.jobId,
      });
      return {
        status: "accepted",
        deliveryId: envelope.deliveryId,
        event: normalized.event,
      };
    }
    const resumeProjection =
      normalized.event.resumeRequested === true &&
      normalized.event.labels.includes("shipyard-blocked");
    if (resumeProjection && this.options.publication === undefined) {
      return this.rejectStored(
        effectiveDelivery,
        "blocked-publication-unconfigured",
      );
    }
    const key = normalized.event.workflowEvent.delivery?.key ?? {
      repository: normalized.event.repository,
      itemId: String(normalized.event.issueNumber),
    };
    const existing =
      await this.options.coordinator.getDeliveryWorkflowState(key);
    if (
      normalized.event.trackedPullRequest === undefined &&
      existing?.delivery.mergedAt === undefined
    ) {
      for (const job of existing?.jobs ?? []) {
        const tracked =
          await this.options.trackingStore?.findTrackedPullRequestByJob?.(
            job.id,
          );
        if (tracked === undefined) continue;
        if (readTransport === undefined) {
          throw new Error(
            "Current pull request state is required for tracked issue intake",
          );
        }
        const current = await readTransport.fetchPullRequest({
          repository: tracked.repository,
          pullRequestNumber: tracked.pullRequestNumber,
        });
        if (current === undefined) {
          throw new Error("Tracked delivery pull request is missing");
        }
        if (current.merged !== true) continue;
        if (
          current.state !== "closed" ||
          requiredStringValue(current.mergedSha) === undefined
        ) {
          throw new Error("Merged delivery has no verified merge revision");
        }
        await this.options.coordinator.markDeliveryMerged(
          key,
          current.mergedSha!,
        );
        break;
      }
    }
    const ingest = await this.options.coordinator.ingest(
      normalized.event.workflowEvent,
    );
    if (
      ingest.job?.blocked !== undefined &&
      this.options.publication !== undefined
    ) {
      await this.projectBlockedJob(ingest.job.id);
    }
    if (
      resumeProjection &&
      ingest.job !== undefined &&
      ingest.job.blocked === undefined &&
      ingest.job.control === "active"
    ) {
      const job = ingest.job;
      const tracked =
        await this.options.trackingStore?.findTrackedPullRequestByJob?.(job.id);
      const branch =
        tracked?.branch ??
        job.lastInfrastructureFailure?.branch ??
        `shipyard/issue-${job.key.itemId}`;
      const lease = await this.projectionLease(job.id, branch);
      const resumed = await this.options.publication!.resumeBlockedDelivery({
        jobId: job.id,
        lease,
        issueNumber: normalized.event.issueNumber,
        pullRequest:
          tracked === undefined
            ? undefined
            : {
                number: tracked.pullRequestNumber,
                branch: tracked.branch,
                baseBranch: tracked.policy.baseBranch,
                headSha: tracked.headSha,
              },
      });
      if (resumed.status === "not-reclaimed") {
        throw new Error(resumed.reason ?? "Blocked delivery was not reclaimed");
      }
    }
    await this.options.deliveryStore.updateDelivery({
      ...effectiveDelivery,
      status: ingest.disposition === "ignored" ? "ignored" : "accepted",
      eventKind: normalized.event.kind,
      jobId: ingest.job?.id,
      reason: ingest.reason,
    });
    return {
      status:
        ingest.disposition === "duplicate"
          ? "duplicate"
          : ingest.disposition === "ignored"
            ? "ignored"
            : "accepted",
      deliveryId: envelope.deliveryId,
      event: normalized.event,
      ingest,
      reason: ingest.reason,
    };
  }

  private async recordRejected(input: {
    readonly deliveryId: string;
    readonly eventName: string;
    readonly payload: unknown;
    readonly body: string | Uint8Array;
    readonly reason: string;
  }): Promise<void> {
    const payloadRecord = record(input.payload);
    const delivery: GitHubDeliveryRecord = {
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      repository: payloadRecord
        ? (repositoryName(payloadRecord) ?? "unknown")
        : "unknown",
      senderLogin: payloadRecord ? sender(payloadRecord).login : "unknown",
      receivedAt: this.now(),
      payloadHash: payloadHash(input.body),
      payload: input.payload,
      status: "rejected",
      reason: input.reason,
    };
    const stored =
      await this.options.deliveryStore.recordDeliveryIfAbsent(delivery);
    if (!stored.inserted) return;
  }

  private async rejectStored(
    delivery: GitHubDeliveryRecord,
    reason: string,
  ): Promise<GitHubWebhookReceipt> {
    await this.options.deliveryStore.updateDelivery({
      ...delivery,
      status: "rejected",
      reason,
    });
    return { status: "rejected", deliveryId: delivery.deliveryId, reason };
  }

  private async ignoreStored(
    delivery: GitHubDeliveryRecord,
    reason: string,
  ): Promise<GitHubWebhookReceipt> {
    await this.options.deliveryStore.updateDelivery({
      ...delivery,
      status: "ignored",
      reason,
    });
    return { status: "ignored", deliveryId: delivery.deliveryId, reason };
  }

  private async briefForIssue(
    draft: Omit<GitHubNormalizedEvent, "workflowEvent">,
    issue: GitHubIssueSnapshot,
    kind: WorkItemKind,
  ): Promise<WorkBrief> {
    const identity: WorkIdentity = {
      repository: draft.repository,
      itemId: String(issue.number),
      kind,
    };
    const current = await this.options.coordinator.getCurrentJob(identity);
    if (
      this.options.triage === undefined &&
      current !== undefined &&
      current.control === "active" &&
      current.state !== "completed" &&
      current.state !== "merged" &&
      sameIssueContent(current.brief, issue)
    ) {
      return current.brief;
    }
    if (this.options.triage !== undefined) {
      const source: TriageSource = {
        provider: "github",
        repository: draft.repository,
        itemId: String(issue.number),
        title: issue.title,
        body: issue.body,
        author: issue.authorLogin ?? draft.sender.login,
        url: issue.htmlUrl,
        updatedAt: issue.updatedAt || draft.observedAt,
        kind,
        labels: issue.labels,
      };
      const triage = await runTriage({
        source,
        policy: this.options.policy,
        base: this.options.base,
        store: this.options.triage.store,
        investigator: this.options.triage.investigator,
        clarificationReply:
          draft.kind === "issue-replied" && draft.reply !== undefined
            ? {
                id: draft.reply.id,
                body: draft.reply.body,
                author: draft.reply.authorLogin,
                updatedAt: draft.reply.updatedAt,
              }
            : undefined,
        now: this.now,
      });
      if (triage.brief !== undefined) {
        if (triage.brief.authorization.status === "approved") {
          return createWorkBrief({
            ...triage.brief,
            authorization: { status: "pending" },
          });
        }
        return triage.brief;
      }
    }
    const event = draft;
    const revision = current === undefined ? 1 : current.brief.revision + 1;
    const factory = this.options.briefFactory ?? createGitHubIssueBrief;
    const candidate = factory({
      event,
      itemKind: kind,
      policy: this.options.policy,
      base: this.options.base,
      authorization: { status: "pending" },
      revision,
      defaults: this.options.briefDefaults,
    });
    const brief = parseWorkBrief(candidate);
    if (brief.authorization.status !== "pending") {
      throw new Error(
        "GitHub intake cannot authorize work from webhook content",
      );
    }
    return brief;
  }

  private async normalizeTrackedPullRequest(
    envelope: GitHubWebhookEnvelope,
    payload: JsonRecord,
    pullRequestNumberValue: number,
    reply?: GitHubCommentSnapshot,
    review?: GitHubPullRequestReviewSnapshot,
  ): Promise<GitHubNormalizationResult> {
    const repository = repositoryName(payload) ?? "unknown";
    const source = sender(payload);
    const trackingStore = this.options.trackingStore;
    const tracked = trackingStore
      ? await trackingStore.findTrackedPullRequest(
          repository,
          pullRequestNumberValue,
        )
      : undefined;
    if (tracked === undefined) {
      return ignored({
        reason: "unrelated-pull-request",
        eventName: envelope.eventName,
        action: stringValue(payload.action),
        deliveryId: envelope.deliveryId,
        repository,
        sender: source,
      });
    }
    const pullRequest = record(payload.pull_request);
    const observedAt =
      requiredStringValue(pullRequest?.updated_at) ??
      requiredStringValue(record(payload.issue)?.updated_at) ??
      reply?.updatedAt ??
      envelope.receivedAt;
    const headSha = pullRequestHead(payload, tracked.headSha);
    // A tracked pull request's closed state is not the source issue's state.
    // Source issue closure is reconciled from issue events/provider reads.
    const sourceState = "open" as const;
    const event: Omit<GitHubNormalizedEvent, "workflowEvent"> = {
      kind: "tracked-pr-updated",
      eventName: eventName(envelope.eventName) ?? "pull_request",
      action: stringValue(payload.action),
      deliveryId: envelope.deliveryId,
      repository,
      sender: source,
      issueNumber: Number(tracked.itemId) || pullRequestNumberValue,
      pullRequestNumber: pullRequestNumberValue,
      title: stringValue(pullRequest?.title, tracked.brief.problem),
      body: stringValue(pullRequest?.body, tracked.brief.source.originalBody),
      labels: labels(pullRequest?.labels),
      relevantRevision: headSha,
      observedAt,
      sourceState,
      reply,
      review,
      trackedPullRequest: tracked,
    };
    return {
      disposition: "accepted",
      event: {
        ...event,
        workflowEvent: {
          deliveryId: envelope.deliveryId,
          brief: tracked.brief,
          policy: tracked.policy,
          phase: "checking",
          relevantRevision: headSha,
          observedAt,
          sourceState,
          payload: envelope.payload,
        },
      },
    };
  }

  private issuePayload(
    issue: GitHubIssueSnapshot,
    repository: string,
  ): JsonRecord {
    return {
      action: issue.state === "closed" ? "closed" : "edited",
      issue: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        updated_at: issue.updatedAt,
        html_url: issue.htmlUrl,
        user: issue.authorLogin ? { login: issue.authorLogin } : undefined,
        labels: issue.labels.map((name) => ({ name })),
        pull_request:
          issue.pullRequestNumber === undefined
            ? undefined
            : { number: issue.pullRequestNumber },
      },
      repository: { full_name: repository },
      sender: {
        login: this.options.authorization.allowedSenders[0] ?? "shipyard",
      },
    };
  }

  private pullRequestPayload(
    pullRequest: {
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly state: "open" | "closed";
      readonly branch: string;
      readonly baseBranch: string;
      readonly headSha: string;
      readonly updatedAt: string;
      readonly htmlUrl?: string;
      readonly authorLogin?: string;
      readonly draft?: boolean;
      readonly merged?: boolean;
      readonly mergedSha?: string;
    },
    repository: string,
  ): JsonRecord {
    return {
      action: "synchronize",
      pull_request: {
        number: pullRequest.number,
        title: pullRequest.title,
        body: pullRequest.body,
        state: pullRequest.state,
        updated_at: pullRequest.updatedAt,
        html_url: pullRequest.htmlUrl,
        draft: pullRequest.draft,
        merged: pullRequest.merged,
        merge_commit_sha: pullRequest.mergedSha,
        user: pullRequest.authorLogin
          ? { login: pullRequest.authorLogin }
          : undefined,
        head: { ref: pullRequest.branch, sha: pullRequest.headSha },
        base: { ref: pullRequest.baseBranch },
      },
      repository: { full_name: repository },
      sender: {
        login: this.options.authorization.allowedSenders[0] ?? "shipyard",
      },
    };
  }

  private toReconciliationResult(
    receipt: GitHubWebhookReceipt,
  ): GitHubReconciliationResult {
    return {
      status: receipt.status === "rejected" ? "ignored" : receipt.status,
      deliveryId: receipt.deliveryId,
      reason: receipt.reason,
      event: receipt.event,
      ingest: receipt.ingest,
    };
  }
}

const allowedRepository = (
  policy: GitHubAuthorizationPolicy,
  repository: string,
): boolean =>
  policy.allowedRepositories.some(
    (candidate) => candidate.toLowerCase() === repository.toLowerCase(),
  );

const allowedSender = (
  policy: GitHubAuthorizationPolicy,
  source: GitHubActor,
): boolean =>
  policy.allowedSenders.some(
    (candidate) => candidate.toLowerCase() === source.login.toLowerCase(),
  );

const allowedReviewer = (
  policy: GitHubAuthorizationPolicy,
  source: GitHubActor,
): boolean =>
  policy.allowedReviewers.some(
    (candidate) => candidate.toLowerCase() === source.login.toLowerCase(),
  );

const isBot = (
  source: GitHubActor,
  policy: GitHubAuthorizationPolicy,
): boolean =>
  source.type === "Bot" ||
  policy.botLogins?.some(
    (candidate) => candidate.toLowerCase() === source.login.toLowerCase(),
  ) === true;

export { InMemoryGitHubStore } from "./store.js";
