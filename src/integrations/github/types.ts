import type {
  Authorization,
  CheckEvidence,
  RepositoryPolicy,
  RevisionReference,
  RiskLevel,
  WorkBrief,
  WorkItemKind,
  WorkflowPhase,
} from "../../workflow/contracts/index.js";
import type {
  BranchLease,
  DeliveryFailureEvidence,
  DeliveryKey,
  EffectExecution,
  EffectIntent,
  IngestResult,
  InfrastructureFailureInput,
  InfrastructureRetryResult,
  WorkflowCoordinator,
  WorkflowEventInput,
} from "../../workflow/coordinator/index.js";

export const SHIPYARD_LABEL = "shipyard" as const;
export const SHIPYARD_BLOCKED_LABEL = "shipyard-blocked" as const;
export const SHIPYARD_BLOCKED_LABEL_COLOR = "d73a4a" as const;
export const SHIPYARD_BLOCKED_LABEL_DESCRIPTION =
  "Shipyard delivery is blocked after automatic recovery was exhausted; re-add shipyard to retry the existing delivery." as const;
export const READY_FOR_HUMAN_LABEL = "ready-for-human" as const;
import type {
  TriageInvestigator,
  TriageStore,
} from "../../workflow/triage/index.js";
import type {
  HandoffCandidate,
  HumanReviewRoundTripResult,
  PlanningSpecBlocker,
  PlanningSpecCompletionResult,
  PlanningSpecIssueReference,
} from "../../workflow/handoff/index.js";

export type GitHubEventName =
  | "issues"
  | "issue_comment"
  | "pull_request"
  | "pull_request_review"
  | "pull_request_review_comment"
  | "check_run"
  | "check_suite";

export type GitHubActorType = "User" | "Bot" | "Organization" | string;

export interface GitHubActor {
  readonly login: string;
  readonly type?: GitHubActorType;
}

export interface GitHubIssueSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly updatedAt: string;
  readonly htmlUrl?: string;
  readonly authorLogin?: string;
  readonly labels: readonly string[];
  readonly pullRequestNumber?: number;
}

/** Provider reads for native sub-issues, with issue fetches for body fallback. */
export interface GitHubIssueRelationshipReader {
  fetchIssue(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<GitHubIssueSnapshot | undefined>;
  fetchParentIssue?(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<GitHubIssueSnapshot | undefined>;
  fetchSubIssues?(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<readonly GitHubIssueSnapshot[]>;
  fetchBlockedBy?(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<readonly GitHubIssueSnapshot[]>;
}

export interface GitHubCommentSnapshot {
  readonly id: string;
  readonly body: string;
  readonly updatedAt: string;
  readonly htmlUrl?: string;
  readonly authorLogin?: string;
}

export interface GitHubPullRequestSnapshot {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly updatedAt: string;
  readonly htmlUrl?: string;
  readonly authorLogin?: string;
  readonly labels?: readonly string[];
  /** Provider-reported merge state; absent means the adapter did not expose it. */
  readonly merged?: boolean;
  /** Provider-reported merge commit, distinct from the source head SHA. */
  readonly mergedSha?: string;
  readonly mergedAt?: string;
}

/** Stable identity written to every coordinator-owned pull request. */
export const GITHUB_PUBLICATION_METADATA_VERSION = 1 as const;

export interface GitHubPublicationMetadata {
  readonly version: typeof GITHUB_PUBLICATION_METADATA_VERSION;
  readonly repository: string;
  readonly itemId: string;
  readonly kind: WorkItemKind;
  readonly briefRevision: number;
  readonly briefHash: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly branch: string;
  readonly headSha: string;
}

export type GitHubPullRequestReviewState =
  | "approved"
  | "changes-requested"
  | "commented"
  | "dismissed"
  | "pending";

export interface GitHubPullRequestReviewSnapshot {
  readonly id: string;
  readonly state: GitHubPullRequestReviewState;
  readonly headSha: string;
  readonly submittedAt: string;
  readonly authorLogin?: string;
}

export interface GitHubBranchSnapshot {
  readonly name: string;
  readonly headSha: string;
  readonly htmlUrl?: string;
}

export interface GitHubCheckSnapshot {
  readonly id: string;
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
  readonly htmlUrl?: string;
}

export interface GitHubWebhookRequest {
  readonly body: string | Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface GitHubWebhookEnvelope {
  readonly eventName: string;
  readonly deliveryId: string;
  readonly payload: unknown;
  readonly receivedAt: string;
}

export interface GitHubAuthorizationPolicy {
  /** Exact repository names allowed to produce workflow input. */
  readonly allowedRepositories: readonly string[];
  /** Exact GitHub logins allowed to submit workflow input. */
  readonly allowedSenders: readonly string[];
  /** Exact GitHub logins allowed to approve or request changes on tracked pull requests. */
  readonly allowedReviewers: readonly string[];
  /** Additional service logins treated as bot-originated. */
  readonly botLogins?: readonly string[];
}

export interface GitHubBriefDefaults {
  readonly risk?: RiskLevel;
  readonly acceptanceCriteria?: readonly string[];
  readonly exclusions?: readonly string[];
  readonly unresolvedQuestions?: readonly string[];
  readonly verificationArtifacts?: readonly string[];
}

export type GitHubIssueEventKind =
  | "issue-created"
  | "issue-edited"
  | "issue-replied";

export type GitHubTrackedPullRequestEventKind = "tracked-pr-updated";

export type GitHubNormalizedEventKind =
  | GitHubIssueEventKind
  | GitHubTrackedPullRequestEventKind;

export type GitHubEventIgnoreReason =
  | "unsupported-event"
  | "unsupported-action"
  | "bot-originated"
  | "unrelated-pull-request";

export interface GitHubNormalizedEvent {
  readonly kind: GitHubNormalizedEventKind;
  readonly eventName: GitHubEventName;
  readonly action: string;
  readonly deliveryId: string;
  readonly repository: string;
  readonly sender: GitHubActor;
  readonly issueNumber: number;
  readonly pullRequestNumber?: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly relevantRevision: string;
  readonly observedAt: string;
  readonly sourceState: "open" | "closed";
  readonly resumeRequested?: boolean;
  readonly reply?: GitHubCommentSnapshot;
  readonly review?: GitHubPullRequestReviewSnapshot;
  readonly trackedPullRequest?: GitHubTrackedPullRequest;
  readonly workflowEvent: WorkflowEventInput;
}

export interface GitHubIgnoredEvent {
  readonly disposition: "ignored";
  readonly reason: GitHubEventIgnoreReason;
  readonly eventName: string;
  readonly action?: string;
  readonly deliveryId: string;
  readonly repository: string;
  readonly sender: GitHubActor;
}

export type GitHubNormalizationResult =
  | { readonly disposition: "accepted"; readonly event: GitHubNormalizedEvent }
  | GitHubIgnoredEvent;

export type GitHubDeliveryStatus =
  | "received"
  | "accepted"
  | "ignored"
  | "rejected";

export interface GitHubDeliveryRecord {
  readonly deliveryId: string;
  readonly eventName: string;
  readonly repository: string;
  readonly senderLogin: string;
  readonly receivedAt: string;
  readonly payloadHash: string;
  readonly payload: unknown;
  readonly status: GitHubDeliveryStatus;
  readonly eventKind?: GitHubNormalizedEventKind;
  readonly reason?: string;
  readonly jobId?: string;
}

export interface GitHubDeliveryStore {
  recordDeliveryIfAbsent(delivery: GitHubDeliveryRecord): Promise<{
    readonly delivery: GitHubDeliveryRecord;
    readonly inserted: boolean;
  }>;
  getDelivery(deliveryId: string): Promise<GitHubDeliveryRecord | undefined>;
  updateDelivery(delivery: GitHubDeliveryRecord): Promise<void>;
}

export interface GitHubTrackedPullRequest {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly jobId: string;
  readonly itemId: string;
  readonly branch: string;
  readonly headSha: string;
  readonly marker: string;
  readonly brief: WorkBrief;
  readonly policy: RepositoryPolicy;
  readonly createdAt: string;
}

export interface GitHubPullRequestReviewHandler {
  readCurrent(input: {
    readonly candidate: HandoffCandidate;
    readonly trackedPullRequest: GitHubTrackedPullRequest;
  }): Promise<HandoffCandidate>;
  requestRepair(input: {
    readonly candidate: HandoffCandidate;
    readonly pullRequestNumber: number;
    readonly reason: string;
  }): Promise<void>;
}

export interface GitHubTrackingStore {
  findTrackedPullRequest(
    repository: string,
    pullRequestNumber: number,
  ): Promise<GitHubTrackedPullRequest | undefined>;
  saveTrackedPullRequest(pullRequest: GitHubTrackedPullRequest): Promise<void>;
  findTrackedPullRequestByJob?(
    jobId: string,
  ): Promise<GitHubTrackedPullRequest | undefined>;
}

export interface GitHubBriefFactoryInput {
  readonly event: Omit<GitHubNormalizedEvent, "workflowEvent">;
  readonly itemKind: "planning-spec" | "executable-issue" | "pr-repair";
  readonly policy: RepositoryPolicy;
  readonly base: RevisionReference;
  readonly authorization: Authorization;
  readonly revision: number;
  readonly defaults?: GitHubBriefDefaults;
}

export type GitHubBriefFactory = (input: GitHubBriefFactoryInput) => WorkBrief;

export interface GitHubIntegrationOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly policy: RepositoryPolicy;
  readonly base: RevisionReference;
  readonly authorization: GitHubAuthorizationPolicy;
  readonly deliveryStore: GitHubDeliveryStore;
  readonly webhookSecret: string | Uint8Array;
  readonly trackingStore?: GitHubTrackingStore;
  readonly publication?: import("./publication.js").GitHubPublication;
  readonly relationships?: GitHubIssueRelationshipReader;
  /** Review events fail closed unless the caller wires candidate-bound handoff handling. */
  readonly reviewHandler?: GitHubPullRequestReviewHandler;
  /** Optional current-provider aggregate reconciliation for planning-spec PRs. */
  readonly planningSpecCompletion?: GitHubPlanningSpecCompletionHandler;
  readonly briefDefaults?: GitHubBriefDefaults;
  readonly briefFactory?: GitHubBriefFactory;
  /** Optional automatic investigation adapter; absent means intake remains raw triage. */
  readonly triage?: {
    readonly store: TriageStore;
    readonly investigator?: TriageInvestigator;
  };
  readonly now?: () => string;
}

export interface GitHubInfrastructureFailureInput extends InfrastructureFailureInput {
  /** Reuse the current worker lease when it still owns the candidate branch. */
  readonly lease?: BranchLease;
}

export interface GitHubInfrastructureFailureResult extends InfrastructureRetryResult {
  readonly blockedProjected?: boolean;
}

export interface GitHubWebhookReceipt {
  readonly status: "accepted" | "duplicate" | "ignored" | "rejected";
  readonly deliveryId: string;
  readonly reason?: string;
  readonly event?: GitHubNormalizedEvent;
  readonly ingest?: IngestResult;
  readonly review?: HumanReviewRoundTripResult;
  readonly planningSpecCompletion?: PlanningSpecCompletionResult;
}

export interface GitHubReconciliationInput {
  readonly repository: string;
  readonly issueNumber?: number;
  readonly pullRequestNumber?: number;
  readonly transport: GitHubReadTransport;
}

export interface GitHubReconciliationResult {
  readonly status: "accepted" | "duplicate" | "ignored" | "not-found";
  readonly deliveryId: string;
  readonly reason?: string;
  readonly event?: GitHubNormalizedEvent;
  readonly ingest?: IngestResult;
  readonly planningSpecCompletion?: PlanningSpecCompletionResult;
}

export interface GitHubPlanningSpecScope {
  readonly originalChildren: readonly PlanningSpecIssueReference[];
  readonly repairChildren: readonly PlanningSpecIssueReference[];
  readonly blockers?: readonly PlanningSpecBlocker[];
}

export interface GitHubPlanningSpecCompletionInput {
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly trackedPullRequest: GitHubTrackedPullRequest;
  readonly transport: GitHubReadTransport;
}

export interface GitHubPlanningSpecCompletionHandler {
  reconcile(
    input: GitHubPlanningSpecCompletionInput,
  ): Promise<PlanningSpecCompletionResult>;
}

export interface GitHubReadTransport {
  fetchIssue(input: {
    readonly repository: string;
    readonly issueNumber: number;
  }): Promise<GitHubIssueSnapshot | undefined>;
  fetchPullRequest(input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
  }): Promise<GitHubPullRequestSnapshot | undefined>;
  findCommentByMarker(input: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly marker: string;
  }): Promise<GitHubCommentSnapshot | undefined>;
  findBranchByName(input: {
    readonly repository: string;
    readonly branch: string;
  }): Promise<GitHubBranchSnapshot | undefined>;
  findPullRequestByMarker(input: {
    readonly repository: string;
    readonly marker: string;
  }): Promise<GitHubPullRequestSnapshot | undefined>;
  findCheckByMarker(input: {
    readonly repository: string;
    readonly marker: string;
    readonly headSha: string;
  }): Promise<GitHubCheckSnapshot | undefined>;
  findIssueByMarker(input: {
    readonly repository: string;
    readonly marker: string;
  }): Promise<GitHubIssueSnapshot | undefined>;
  /** Read checks for the exact merged candidate revision. */
  readonly fetchChecks?: (input: {
    readonly repository: string;
    readonly headSha: string;
  }) => Promise<readonly GitHubCheckSnapshot[]>;
}

export interface GitHubWriteTransport {
  /** Ensure a repository label exists with the coordinator-owned contract. */
  readonly ensureLabel?: (input: {
    readonly repository: string;
    readonly name: string;
    readonly color: string;
    readonly description: string;
  }) => Promise<GitHubLabelSnapshot>;
  /** Replace only the labels projected by Shipyard on an issue. */
  readonly updateIssue?: (input: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly marker: string;
  }) => Promise<GitHubIssueSnapshot>;
  createComment(input: {
    readonly repository: string;
    readonly issueNumber: number;
    readonly body: string;
  }): Promise<GitHubCommentSnapshot>;
  createBranch(input: {
    readonly repository: string;
    readonly branch: string;
    readonly headSha: string;
    readonly marker: string;
  }): Promise<GitHubBranchSnapshot>;
  createPullRequest(input: {
    readonly repository: string;
    readonly title: string;
    readonly body: string;
    readonly branch: string;
    readonly baseBranch: string;
    readonly draft: boolean;
    readonly marker: string;
  }): Promise<GitHubPullRequestSnapshot>;
  /** Update an existing PR's candidate projection, draft state, and labels. */
  readonly updatePullRequest?: (input: {
    readonly repository: string;
    readonly pullRequestNumber: number;
    readonly title?: string;
    readonly body?: string;
    readonly draft?: boolean;
    readonly labels?: readonly string[];
    readonly marker: string;
  }) => Promise<GitHubPullRequestSnapshot>;
  /** Move an existing remote branch to a newly published candidate. */
  readonly updateBranch?: (input: {
    readonly repository: string;
    readonly branch: string;
    readonly headSha: string;
    readonly marker: string;
  }) => Promise<GitHubBranchSnapshot>;
  createCheck(input: {
    readonly repository: string;
    readonly name: string;
    readonly headSha: string;
    readonly marker: string;
    readonly status: GitHubCheckSnapshot["status"];
    readonly conclusion?: GitHubCheckSnapshot["conclusion"];
    readonly summary: string;
  }): Promise<GitHubCheckSnapshot>;
  createRepairIssue(input: {
    readonly repository: string;
    readonly title: string;
    readonly body: string;
    readonly marker: string;
    readonly labels: readonly string[];
  }): Promise<GitHubIssueSnapshot>;
  /** Close a source issue only after the coordinator has recorded its evidence. */
  readonly closeIssue?: (input: {
    readonly repository: string;
    readonly issueNumber: number;
  }) => Promise<GitHubIssueSnapshot>;
}

export interface GitHubPublicationOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly transport: GitHubReadTransport & GitHubWriteTransport;
  readonly trackingStore: GitHubTrackingStore;
  readonly now?: () => string;
}

export interface GitHubLabelSnapshot {
  readonly name: string;
  readonly color: string;
  readonly description?: string;
}

export interface GitHubPublicationResult<T> {
  readonly marker: string;
  readonly remote: T | undefined;
  readonly disposition: EffectExecution<T>["disposition"];
  readonly effect: EffectIntent;
}

export interface GitHubCommentPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly body: string;
  readonly key?: string;
}

export interface GitHubBriefPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly brief: WorkBrief;
}

export interface GitHubBranchPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly branch: string;
  readonly headSha: string;
}

export interface GitHubPullRequestPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly title: string;
  readonly body: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly draft?: boolean;
  readonly metadata?: GitHubPublicationMetadata;
}

export interface GitHubPullRequestHandoffPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly baseBranch: string;
  readonly headSha: string;
  readonly briefHash: string;
}

export interface GitHubPullRequestDraftPublicationInput extends GitHubPullRequestHandoffPublicationInput {
  readonly reason?: string;
}

export interface GitHubIssueClosurePublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly pullRequestNumber: number;
  readonly branch: string;
  readonly commitSha: string;
  readonly checks: readonly CheckEvidence[];
  readonly cleanupCompleted: boolean;
}

export interface GitHubCheckPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  /** Candidate branch used to bind the check to the active lease. */
  readonly branch?: string;
  readonly name: string;
  readonly headSha: string;
  readonly status: GitHubCheckSnapshot["status"];
  readonly conclusion?: GitHubCheckSnapshot["conclusion"];
  readonly summary: string;
  readonly key?: string;
}

export interface GitHubRepairIssuePublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
}

export interface GitHubRepairLinkPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly repairIssueUrl: string;
}

export interface GitHubBlockedDeliveryPublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly evidence: DeliveryFailureEvidence;
  readonly parentIssueNumber?: number;
  readonly pullRequest?: {
    readonly number: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly headSha: string;
  };
  readonly blockerUrl?: string;
}

export interface GitHubBlockedDeliveryPublicationResult {
  readonly label?: GitHubLabelSnapshot;
  readonly issue?: GitHubPublicationResult<GitHubIssueSnapshot>;
  readonly comment: GitHubPublicationResult<GitHubCommentSnapshot>;
  readonly pullRequest?: GitHubPublicationResult<GitHubPullRequestSnapshot>;
  readonly parentComment?: GitHubPublicationResult<GitHubCommentSnapshot>;
}

export interface GitHubResumeBlockedDeliveryInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly issueNumber: number;
  readonly workerId?: string;
  readonly pullRequest?: {
    readonly number: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly headSha: string;
  };
}

export interface GitHubResumeBlockedDeliveryResult {
  readonly status: "reclaimed" | "already-reclaimed" | "not-reclaimed";
  readonly reason?: string;
  readonly issue?: GitHubPublicationResult<GitHubIssueSnapshot>;
  readonly pullRequest?: GitHubPublicationResult<GitHubPullRequestSnapshot>;
}

export interface GitHubPlanningSpecClosurePublicationInput {
  readonly jobId: string;
  readonly lease: BranchLease;
  readonly parentIssueNumber: number;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl?: string;
  readonly mergedSha: string;
  readonly originalChildren: readonly PlanningSpecIssueReference[];
  readonly repairChildren: readonly PlanningSpecIssueReference[];
}

export interface GitHubPlanningSpecClosurePublicationResult {
  readonly comment: GitHubPublicationResult<GitHubCommentSnapshot>;
  readonly issue?: GitHubPublicationResult<GitHubIssueSnapshot>;
}
