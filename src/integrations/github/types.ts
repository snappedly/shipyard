import type {
  Authorization,
  RepositoryPolicy,
  RevisionReference,
  RiskLevel,
  WorkBrief,
  WorkflowPhase,
} from "../../workflow/contracts/index.js";
import type {
  BranchLease,
  EffectExecution,
  EffectIntent,
  IngestResult,
  WorkflowCoordinator,
  WorkflowEventInput,
} from "../../workflow/coordinator/index.js";
import type {
  TriageInvestigator,
  TriageStore,
} from "../../workflow/triage/index.js";
import type {
  HandoffCandidate,
  HumanReviewRoundTripResult,
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
  /** Review events fail closed unless the caller wires candidate-bound handoff handling. */
  readonly reviewHandler?: GitHubPullRequestReviewHandler;
  readonly briefDefaults?: GitHubBriefDefaults;
  readonly briefFactory?: GitHubBriefFactory;
  /** Optional automatic investigation adapter; absent means intake remains raw triage. */
  readonly triage?: {
    readonly store: TriageStore;
    readonly investigator?: TriageInvestigator;
  };
  readonly now?: () => string;
}

export interface GitHubWebhookReceipt {
  readonly status: "accepted" | "duplicate" | "ignored" | "rejected";
  readonly deliveryId: string;
  readonly reason?: string;
  readonly event?: GitHubNormalizedEvent;
  readonly ingest?: IngestResult;
  readonly review?: HumanReviewRoundTripResult;
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
}

export interface GitHubWriteTransport {
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
}

export interface GitHubPublicationOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly transport: GitHubReadTransport & GitHubWriteTransport;
  readonly trackingStore: GitHubTrackingStore;
  readonly now?: () => string;
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
