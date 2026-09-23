import { createHash } from "node:crypto";
import type { DeliveryFailureEvidence } from "../../workflow/coordinator/index.js";
import { formatPlanningSpecCompletionComment } from "../../workflow/handoff/index.js";
import { sameRevision } from "../../workflow/shared.js";
import { GITHUB_PUBLICATION_METADATA_VERSION } from "./types.js";
import type {
  GitHubBranchPublicationInput,
  GitHubBranchSnapshot,
  GitHubBlockedDeliveryPublicationInput,
  GitHubBlockedDeliveryPublicationResult,
  GitHubBriefPublicationInput,
  GitHubCheckPublicationInput,
  GitHubCheckSnapshot,
  GitHubCommentPublicationInput,
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubLabelSnapshot,
  GitHubIssueClosurePublicationInput,
  GitHubPublicationOptions,
  GitHubPublicationResult,
  GitHubPullRequestDraftPublicationInput,
  GitHubPullRequestHandoffPublicationInput,
  GitHubPullRequestPublicationInput,
  GitHubPullRequestSnapshot,
  GitHubResumeBlockedDeliveryInput,
  GitHubResumeBlockedDeliveryResult,
  GitHubPublicationMetadata,
  GitHubPlanningSpecClosurePublicationInput,
  GitHubPlanningSpecClosurePublicationResult,
  GitHubRepairIssuePublicationInput,
  GitHubRepairLinkPublicationInput,
} from "./types.js";
import {
  READY_FOR_HUMAN_LABEL,
  SHIPYARD_BLOCKED_LABEL,
  SHIPYARD_BLOCKED_LABEL_COLOR,
  SHIPYARD_BLOCKED_LABEL_DESCRIPTION,
  SHIPYARD_LABEL,
} from "./types.js";

const markerText = (marker: string): string => `<!-- shipyard:${marker} -->`;

// Markers are embedded in HTML comments and later used for reconciliation.
// Encode caller-controlled components so a branch/key/name containing `-->`
// cannot terminate the comment or manufacture a second marker.
const markerPart = (value: string | number): string =>
  encodeURIComponent(String(value));

const markerHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const safeDiagnostic = (value: string, limit = 600): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/gi, "[REDACTED]")
    .replace(
      /\b(?:authorization|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

export const formatBlockedDeliveryComment = (
  evidence: DeliveryFailureEvidence,
): string =>
  [
    "Shipyard blocked this delivery after automatic recovery was exhausted.",
    "",
    `- Failed phase: \`${safeDiagnostic(evidence.phase, 80)}\``,
    `- Error: ${safeDiagnostic(evidence.error)}`,
    `- Attempts: ${evidence.attempts}`,
    `- Last successful step: ${safeDiagnostic(evidence.lastSuccessfulStep ?? "not recorded", 160)}`,
    ...(evidence.branch
      ? [`- Branch: \`${safeDiagnostic(evidence.branch, 160)}\``]
      : []),
    ...(evidence.commit
      ? [`- Commit: \`${safeDiagnostic(evidence.commit, 160)}\``]
      : []),
    ...(evidence.pullRequest
      ? [`- Pull request: ${safeDiagnostic(evidence.pullRequest, 240)}`]
      : []),
    `- Recovery: ${safeDiagnostic(evidence.recovery, 300)}`,
  ].join("\n");

export const projectBlockedLabels = (
  labels: readonly string[],
): readonly string[] => [
  ...new Set(
    labels.filter(
      (label) =>
        label !== SHIPYARD_LABEL &&
        label !== READY_FOR_HUMAN_LABEL &&
        label !== SHIPYARD_BLOCKED_LABEL,
    ),
  ),
  SHIPYARD_BLOCKED_LABEL,
];

export const projectActiveLabels = (
  labels: readonly string[],
): readonly string[] =>
  labels.filter(
    (label) =>
      label !== SHIPYARD_BLOCKED_LABEL &&
      label !== READY_FOR_HUMAN_LABEL &&
      label !== SHIPYARD_LABEL,
  );

export const projectResumedLabels = (
  labels: readonly string[],
): readonly string[] => [...projectActiveLabels(labels), SHIPYARD_LABEL];

const sameLabels = (
  actual: readonly string[],
  expected: readonly string[],
): boolean =>
  actual.length === expected.length &&
  expected.every((label) => actual.includes(label));

const metadataLine = (metadata: GitHubPublicationMetadata): string =>
  `<!-- shipyard:metadata ${JSON.stringify(metadata)} -->`;

const nonEmptyMetadataString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

/** Read the stable candidate identity embedded in a coordinator-owned PR body. */
export const parseGitHubPublicationMetadata = (
  body: string,
): GitHubPublicationMetadata | undefined => {
  const match = /<!-- shipyard:metadata ([\s\S]*?) -->/.exec(body);
  if (match?.[1] === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const candidate = value as Record<string, unknown>;
    if (
      candidate.version !== GITHUB_PUBLICATION_METADATA_VERSION ||
      (candidate.deliveryVersion !== undefined &&
        (typeof candidate.deliveryVersion !== "number" ||
          !Number.isInteger(candidate.deliveryVersion) ||
          candidate.deliveryVersion < 1)) ||
      !nonEmptyMetadataString(candidate.repository) ||
      !nonEmptyMetadataString(candidate.itemId) ||
      !["planning-spec", "executable-issue", "pr-repair"].includes(
        candidate.kind as string,
      ) ||
      typeof candidate.briefRevision !== "number" ||
      !Number.isInteger(candidate.briefRevision) ||
      candidate.briefRevision < 1 ||
      !nonEmptyMetadataString(candidate.briefHash) ||
      !nonEmptyMetadataString(candidate.baseBranch) ||
      !nonEmptyMetadataString(candidate.baseSha) ||
      !nonEmptyMetadataString(candidate.branch) ||
      !nonEmptyMetadataString(candidate.headSha)
    ) {
      return undefined;
    }
    return candidate as unknown as GitHubPublicationMetadata;
  } catch {
    return undefined;
  }
};

export const serializeGitHubPublicationMetadata = (
  metadata: GitHubPublicationMetadata,
): string => metadataLine(metadata);

const result = <T>(
  marker: string,
  execution: {
    readonly disposition: GitHubPublicationResult<T>["disposition"];
    readonly effect: GitHubPublicationResult<T>["effect"];
    readonly externalRef?: T;
  },
): GitHubPublicationResult<T> => ({
  marker,
  remote: execution.externalRef,
  disposition: execution.disposition,
  effect: execution.effect,
});

/** Coordinator-owned GitHub effects with stable markers and remote reconciliation. */
export class GitHubPublication {
  private readonly options: GitHubPublicationOptions;

  constructor(options: GitHubPublicationOptions) {
    this.options = options;
  }

  async publishComment(
    input: GitHubCommentPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubCommentSnapshot>> {
    const marker = `comment:${markerPart(input.jobId)}:${markerPart(input.key ?? "default")}`;
    const body = `${markerText(marker)}\n${input.body}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.issueNumber),
      kind: "github-comment",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.issueNumber,
      },
      reconcile: () =>
        this.options.transport.findCommentByMarker({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          marker: markerText(marker),
        }),
      publish: () =>
        this.options.transport.createComment({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          body,
        }),
    });
    return result(marker, execution);
  }

  async publishBrief(
    input: GitHubBriefPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubCommentSnapshot>> {
    const marker = `brief:${markerPart(input.jobId)}:${markerPart(input.brief.revision)}`;
    const body = [
      markerText(marker),
      "## Shipyard executable brief",
      `- Revision: ${input.brief.revision}`,
      `- Brief hash: \`${input.brief.hash}\``,
      `- Risk: ${input.brief.risk}`,
      "",
      input.brief.problem,
      "",
      "### Acceptance criteria",
      ...input.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      "",
      "### Unresolved questions",
      ...input.brief.unresolvedQuestions.map((question) => `- ${question}`),
    ].join("\n");
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.issueNumber),
      kind: "github-brief",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.issueNumber,
      },
      reconcile: () =>
        this.options.transport.findCommentByMarker({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          marker: markerText(marker),
        }),
      publish: () =>
        this.options.transport.createComment({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          body,
        }),
    });
    return result(marker, execution);
  }

  async publishBranch(
    input: GitHubBranchPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubBranchSnapshot>> {
    const marker = `branch:${markerPart(input.jobId)}:${markerPart(input.branch)}`;
    const effectMarker = `${marker}:candidate:${markerPart(input.headSha)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-branch",
      marker: effectMarker,
      payload: {
        repository: input.lease.repository,
        branch: input.branch,
        candidate: input.headSha,
      },
      reconcile: async () => {
        const branch = await this.options.transport.findBranchByName({
          repository: input.lease.repository,
          branch: input.branch,
        });
        return branch !== undefined && branch.headSha === input.headSha
          ? branch
          : undefined;
      },
      publish: async () => {
        const branch = await this.options.transport.findBranchByName({
          repository: input.lease.repository,
          branch: input.branch,
        });
        if (branch !== undefined) {
          if (branch.headSha === input.headSha) return branch;
          if (this.options.transport.updateBranch === undefined) {
            throw new Error(
              "GitHub transport cannot update an existing branch candidate",
            );
          }
          return this.options.transport.updateBranch({
            repository: input.lease.repository,
            branch: input.branch,
            headSha: input.headSha,
            marker: markerText(marker),
          });
        }
        return this.options.transport.createBranch({
          repository: input.lease.repository,
          branch: input.branch,
          headSha: input.headSha,
          marker: markerText(marker),
        });
      },
    });
    return result(marker, execution);
  }

  async publishPullRequest(
    input: GitHubPullRequestPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubPullRequestSnapshot>> {
    const job = await this.options.coordinator.getJob(input.jobId);
    const itemId = input.metadata?.itemId ?? job?.key.itemId;
    const marker =
      itemId === undefined
        ? `pull-request:${markerPart(input.jobId)}:${markerPart(input.branch)}`
        : `pull-request:${markerPart(input.lease.repository)}:${markerPart(itemId)}:${markerPart(input.branch)}`;
    const effectMarker = `${marker}:candidate:${markerPart(input.headSha)}`;
    const body = [
      markerText(marker),
      ...(input.metadata === undefined ? [] : [metadataLine(input.metadata)]),
      input.body,
    ].join("\n");
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-pull-request",
      marker: effectMarker,
      payload: {
        repository: input.lease.repository,
        branch: input.branch,
        candidate: input.headSha,
        workflowItem: itemId,
      },
      reconcile: async () => {
        const existing = await this.options.transport.findPullRequestByMarker({
          repository: input.lease.repository,
          marker: markerText(marker),
        });
        if (existing === undefined) return undefined;
        if (
          existing.state !== "open" ||
          existing.branch !== input.branch ||
          existing.baseBranch !== input.baseBranch ||
          existing.headSha !== input.headSha
        ) {
          throw new Error(
            "Existing pull request does not match the current delivery candidate",
          );
        }
        if (
          existing.title === input.title &&
          existing.body === body &&
          existing.draft === (input.draft ?? true)
        ) {
          return existing;
        }
        if (this.options.transport.updatePullRequest === undefined) {
          throw new Error(
            "GitHub transport cannot update an existing pull request candidate",
          );
        }
        return this.options.transport.updatePullRequest({
          repository: input.lease.repository,
          pullRequestNumber: existing.number,
          title: input.title,
          body,
          draft: input.draft ?? true,
          marker: markerText(marker),
        });
      },
      publish: () =>
        this.options.transport.createPullRequest({
          repository: input.lease.repository,
          title: input.title,
          body,
          branch: input.branch,
          baseBranch: input.baseBranch,
          draft: input.draft ?? true,
          marker: markerText(marker),
        }),
    });
    const publication = result(marker, execution);
    if (
      publication.remote !== undefined &&
      publication.remote.branch === input.branch &&
      publication.remote.baseBranch === input.baseBranch &&
      publication.remote.headSha === input.headSha
    ) {
      if (job !== undefined) {
        await this.options.trackingStore.saveTrackedPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: publication.remote.number,
          jobId: input.jobId,
          itemId: job.key.itemId,
          branch: input.branch,
          headSha: input.headSha,
          marker: markerText(marker),
          brief: job.brief,
          policy: job.policy,
          createdAt: this.options.now?.() ?? new Date().toISOString(),
        });
      }
    }
    return publication;
  }

  async publishPullRequestHandoff(
    input: GitHubPullRequestHandoffPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubPullRequestSnapshot>> {
    const job = await this.options.coordinator.getJob(input.jobId);
    if (job === undefined) {
      throw new Error(`Workflow job ${input.jobId} does not exist`);
    }
    const marker = `pull-request-ready:${markerPart(input.lease.repository)}:${markerPart(input.pullRequestNumber)}:${markerPart(input.headSha)}`;
    const matchesCandidateIdentity = (
      pullRequest: GitHubPullRequestSnapshot,
    ): boolean => {
      const metadata = parseGitHubPublicationMetadata(pullRequest.body);
      return (
        pullRequest.number === input.pullRequestNumber &&
        pullRequest.branch === input.branch &&
        pullRequest.baseBranch === input.baseBranch &&
        pullRequest.headSha === input.headSha &&
        metadata !== undefined &&
        metadata.repository === input.lease.repository &&
        metadata.itemId === job.brief.identity.itemId &&
        metadata.kind === job.brief.identity.kind &&
        metadata.briefRevision === job.brief.revision &&
        metadata.briefHash === input.briefHash &&
        metadata.baseBranch === input.baseBranch &&
        metadata.baseSha === job.brief.base.sha &&
        metadata.branch === input.branch &&
        metadata.headSha === input.headSha
      );
    };
    const matchesCandidate = (
      pullRequest: GitHubPullRequestSnapshot,
    ): boolean =>
      pullRequest.state === "open" &&
      !pullRequest.draft &&
      matchesCandidateIdentity(pullRequest) &&
      (pullRequest.labels ?? []).includes("ready-for-human") &&
      !(pullRequest.labels ?? []).includes("shipyard-blocked");
    const isCurrentCandidate = async (): Promise<boolean> => {
      if (typeof input.readCurrent !== "function") return false;
      try {
        const current = await input.readCurrent();
        return (
          sameRevision(current.base, job.brief.base) &&
          sameRevision(current.head, {
            branch: input.branch,
            sha: input.headSha,
          }) &&
          current.briefHash === input.briefHash
        );
      } catch {
        return false;
      }
    };
    const withdrawStaleReadiness = async (
      pullRequest: GitHubPullRequestSnapshot,
    ): Promise<void> => {
      if (
        pullRequest.state !== "open" ||
        (pullRequest.draft &&
          !(pullRequest.labels ?? []).includes("ready-for-human"))
      ) {
        return;
      }
      const withdrawalMarker = `${marker}:stale-candidate:${markerPart(pullRequest.headSha)}:${markerPart(pullRequest.updatedAt)}`;
      const withdrawn = (current: GitHubPullRequestSnapshot): boolean =>
        current.state === "open" &&
        current.draft &&
        !(current.labels ?? []).includes("ready-for-human");
      const execution = await this.options.coordinator.publishEffect({
        jobId: input.jobId,
        lease: input.lease,
        branch: input.branch,
        headSha: input.headSha,
        kind: "github-pull-request-stale-handoff",
        marker: withdrawalMarker,
        payload: {
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
          headSha: input.headSha,
        },
        reconcile: async () => {
          const current = await this.options.transport.fetchPullRequest({
            repository: input.lease.repository,
            pullRequestNumber: input.pullRequestNumber,
          });
          return current !== undefined && withdrawn(current)
            ? current
            : undefined;
        },
        publish: async () => {
          const current = await this.options.transport.fetchPullRequest({
            repository: input.lease.repository,
            pullRequestNumber: input.pullRequestNumber,
          });
          if (current === undefined || current.state !== "open") {
            throw new Error("Tracked pull request is no longer open");
          }
          if (withdrawn(current)) return current;
          if (this.options.transport.updatePullRequest === undefined) {
            throw new Error(
              "GitHub transport cannot withdraw stale pull-request readiness",
            );
          }
          const labels = new Set(current.labels ?? []);
          labels.delete("ready-for-human");
          return this.options.transport.updatePullRequest({
            repository: input.lease.repository,
            pullRequestNumber: input.pullRequestNumber,
            draft: true,
            labels: [...labels],
            marker: markerText(withdrawalMarker),
          });
        },
      });
      if (
        execution.externalRef === undefined ||
        !withdrawn(execution.externalRef)
      ) {
        throw new Error("Could not withdraw stale pull-request readiness");
      }
    };
    const preflightPullRequest = await this.options.transport.fetchPullRequest({
      repository: input.lease.repository,
      pullRequestNumber: input.pullRequestNumber,
    });
    if (preflightPullRequest === undefined) {
      throw new Error("Tracked pull request is not published");
    }
    const preflightCandidateMatches = await isCurrentCandidate();
    if (
      preflightPullRequest.state !== "open" ||
      !matchesCandidateIdentity(preflightPullRequest) ||
      !preflightCandidateMatches
    ) {
      await withdrawStaleReadiness(preflightPullRequest);
      throw new Error(
        typeof input.readCurrent !== "function"
          ? "A provider current-state reader is required before human handoff"
          : "Pull request candidate changed before human handoff",
      );
    }
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-pull-request-handoff",
      marker,
      payload: {
        repository: input.lease.repository,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        briefHash: input.briefHash,
      },
      reconcile: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
        });
        return pullRequest !== undefined &&
          matchesCandidate(pullRequest) &&
          (await isCurrentCandidate())
          ? pullRequest
          : undefined;
      },
      publish: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
        });
        if (pullRequest === undefined) {
          throw new Error("Tracked pull request is not published");
        }
        const currentCandidateMatches = await isCurrentCandidate();
        if (
          pullRequest.state !== "open" ||
          !matchesCandidateIdentity(pullRequest) ||
          !currentCandidateMatches
        ) {
          await withdrawStaleReadiness(pullRequest);
          throw new Error(
            typeof input.readCurrent !== "function"
              ? "A provider current-state reader is required before human handoff"
              : "Pull request candidate changed before human handoff",
          );
        }
        if (this.options.transport.updatePullRequest === undefined) {
          throw new Error("GitHub transport cannot mark a pull request ready");
        }
        const labels = new Set(pullRequest.labels ?? []);
        labels.delete("shipyard-blocked");
        labels.add("ready-for-human");
        return this.options.transport.updatePullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
          draft: false,
          labels: [...labels],
          marker: markerText(marker),
        });
      },
    });
    return result(marker, execution);
  }

  /** Return a tracked PR to active draft work when its candidate changes. */
  async invalidatePullRequestHandoff(
    input: GitHubPullRequestDraftPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubPullRequestSnapshot>> {
    const marker = `pull-request-draft:${markerPart(input.lease.repository)}:${markerPart(input.pullRequestNumber)}:${markerPart(input.headSha)}`;
    const matchesCandidate = (
      pullRequest: GitHubPullRequestSnapshot,
    ): boolean =>
      pullRequest.state === "open" &&
      pullRequest.draft &&
      pullRequest.branch === input.branch &&
      pullRequest.baseBranch === input.baseBranch &&
      pullRequest.headSha === input.headSha &&
      !(pullRequest.labels ?? []).includes("ready-for-human") &&
      !(pullRequest.labels ?? []).includes("shipyard-blocked");
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-pull-request-draft",
      marker,
      payload: {
        repository: input.lease.repository,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
        reason: input.reason,
      },
      reconcile: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
        });
        return pullRequest !== undefined && matchesCandidate(pullRequest)
          ? pullRequest
          : undefined;
      },
      publish: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
        });
        if (pullRequest === undefined) {
          throw new Error("Tracked pull request is not published");
        }
        if (
          pullRequest.state !== "open" ||
          pullRequest.branch !== input.branch ||
          pullRequest.baseBranch !== input.baseBranch ||
          pullRequest.headSha !== input.headSha
        ) {
          throw new Error(
            "Pull request candidate changed before draft invalidation",
          );
        }
        if (this.options.transport.updatePullRequest === undefined) {
          throw new Error(
            "GitHub transport cannot return a pull request to draft",
          );
        }
        const labels = new Set(pullRequest.labels ?? []);
        labels.delete("ready-for-human");
        labels.delete("shipyard-blocked");
        return this.options.transport.updatePullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.pullRequestNumber,
          draft: true,
          labels: [...labels],
          marker: markerText(marker),
        });
      },
    });
    return result(marker, execution);
  }

  private async publishIssueLabels(input: {
    readonly jobId: string;
    readonly lease: GitHubBlockedDeliveryPublicationInput["lease"];
    readonly issueNumber: number;
    readonly labels: readonly string[];
    readonly key: string;
  }): Promise<GitHubPublicationResult<GitHubIssueSnapshot>> {
    const marker = `issue-labels:${markerPart(input.lease.repository)}:${markerPart(input.issueNumber)}:${markerPart(input.key)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.issueNumber),
      kind: "github-issue-labels",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.issueNumber,
        labels: input.labels,
      },
      reconcile: async () => {
        const issue = await this.options.transport.fetchIssue({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
        });
        return issue !== undefined && sameLabels(issue.labels, input.labels)
          ? issue
          : undefined;
      },
      publish: async () => {
        if (this.options.transport.updateIssue === undefined) {
          throw new Error("GitHub transport cannot project issue labels");
        }
        const issue = await this.options.transport.fetchIssue({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
        });
        if (issue === undefined)
          throw new Error("Source issue is not published");
        return this.options.transport.updateIssue({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          labels: input.labels,
          marker: markerText(marker),
        });
      },
    });
    return result(marker, execution);
  }

  /** Ensure the red blocked label contract before projecting blocked work. */
  async ensureShipyardBlockedLabel(
    repository: string,
  ): Promise<GitHubLabelSnapshot> {
    if (this.options.transport.ensureLabel === undefined) {
      throw new Error("GitHub transport cannot ensure repository labels");
    }
    return this.options.transport.ensureLabel({
      repository,
      name: SHIPYARD_BLOCKED_LABEL,
      color: SHIPYARD_BLOCKED_LABEL_COLOR,
      description: SHIPYARD_BLOCKED_LABEL_DESCRIPTION,
    });
  }

  async publishBlockedDelivery(
    input: GitHubBlockedDeliveryPublicationInput,
  ): Promise<GitHubBlockedDeliveryPublicationResult> {
    const label = await this.ensureShipyardBlockedLabel(input.lease.repository);
    const issue = await this.options.transport.fetchIssue({
      repository: input.lease.repository,
      issueNumber: input.issueNumber,
    });
    if (issue === undefined)
      throw new Error("Blocked source issue is not published");
    const issuePublication = await this.publishIssueLabels({
      jobId: input.jobId,
      lease: input.lease,
      issueNumber: input.issueNumber,
      labels: projectBlockedLabels(issue.labels),
      key: `blocked:${input.evidence.attempts}`,
    });
    const comment = await this.publishComment({
      jobId: input.jobId,
      lease: input.lease,
      issueNumber: input.issueNumber,
      key: `blocked:${input.evidence.attempts}:${input.evidence.phase}`,
      body: formatBlockedDeliveryComment(input.evidence),
    });
    let pullRequest:
      | GitHubPublicationResult<GitHubPullRequestSnapshot>
      | undefined;
    if (input.pullRequest !== undefined) {
      const pullRequestInput = input.pullRequest;
      pullRequest = await this.publishBlockedPullRequest({
        jobId: input.jobId,
        lease: input.lease,
        ...pullRequestInput,
      });
    }
    let parentComment:
      | GitHubPublicationResult<GitHubCommentSnapshot>
      | undefined;
    if (input.parentIssueNumber !== undefined) {
      const job = await this.options.coordinator.getJob(input.jobId);
      if (job === undefined)
        throw new Error("Blocked workflow job does not exist");
      const marker = `parent-blocked:${markerPart(input.lease.repository)}:${markerPart(input.parentIssueNumber)}:${markerPart(input.issueNumber)}:${markerPart(input.evidence.attempts)}`;
      const body = [
        `Shipyard blocked child issue #${input.issueNumber}.`,
        input.blockerUrl === undefined
          ? "Re-add the shipyard label to the child issue to resume the existing delivery."
          : `Blocker: ${input.blockerUrl}`,
      ].join("\n");
      const execution = await this.options.coordinator.publishEffect({
        jobId: input.jobId,
        lease: input.lease,
        deliveryKey: job.deliveryKey,
        kind: "github-parent-blocked-link",
        marker,
        payload: {
          repository: input.lease.repository,
          issueNumber: input.parentIssueNumber,
        },
        reconcile: () =>
          this.options.transport.findCommentByMarker({
            repository: input.lease.repository,
            issueNumber: input.parentIssueNumber!,
            marker: markerText(marker),
          }),
        publish: () =>
          this.options.transport.createComment({
            repository: input.lease.repository,
            issueNumber: input.parentIssueNumber!,
            body: `${markerText(marker)}\n${body}`,
          }),
      });
      parentComment = result(marker, execution);
    }
    return {
      label,
      issue: issuePublication,
      comment,
      pullRequest,
      parentComment,
    };
  }

  async publishBlockedPullRequest(input: {
    readonly jobId: string;
    readonly lease: GitHubBlockedDeliveryPublicationInput["lease"];
    readonly number: number;
    readonly branch: string;
    readonly baseBranch: string;
    readonly headSha: string;
  }): Promise<GitHubPublicationResult<GitHubPullRequestSnapshot>> {
    const marker = `pull-request-blocked:${markerPart(input.lease.repository)}:${markerPart(input.number)}:${markerPart(input.headSha)}`;
    const matches = (pullRequest: GitHubPullRequestSnapshot): boolean =>
      pullRequest.state === "open" &&
      pullRequest.draft &&
      pullRequest.branch === input.branch &&
      pullRequest.baseBranch === input.baseBranch &&
      pullRequest.headSha === input.headSha &&
      (pullRequest.labels ?? []).includes(SHIPYARD_BLOCKED_LABEL) &&
      !(pullRequest.labels ?? []).includes(READY_FOR_HUMAN_LABEL) &&
      !(pullRequest.labels ?? []).includes(SHIPYARD_LABEL);
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-pull-request-blocked",
      marker,
      payload: { repository: input.lease.repository, number: input.number },
      reconcile: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.number,
        });
        return pullRequest !== undefined && matches(pullRequest)
          ? pullRequest
          : undefined;
      },
      publish: async () => {
        const pullRequest = await this.options.transport.fetchPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.number,
        });
        if (pullRequest === undefined)
          throw new Error("Tracked pull request is not published");
        if (
          pullRequest.state !== "open" ||
          pullRequest.branch !== input.branch ||
          pullRequest.baseBranch !== input.baseBranch ||
          pullRequest.headSha !== input.headSha
        ) {
          throw new Error(
            "Pull request candidate changed before blocked projection",
          );
        }
        if (this.options.transport.updatePullRequest === undefined) {
          throw new Error("GitHub transport cannot project pull request state");
        }
        return this.options.transport.updatePullRequest({
          repository: input.lease.repository,
          pullRequestNumber: input.number,
          draft: true,
          labels: projectBlockedLabels(pullRequest.labels ?? []),
          marker: markerText(marker),
        });
      },
    });
    return result(marker, execution);
  }

  async resumeBlockedDelivery(
    input: GitHubResumeBlockedDeliveryInput,
  ): Promise<GitHubResumeBlockedDeliveryResult> {
    const reclaimed = await this.options.coordinator.reclaimBlockedJob(
      input.jobId,
    );
    if (
      reclaimed.status !== "reclaimed" &&
      reclaimed.status !== "already-reclaimed"
    ) {
      return {
        status: "not-reclaimed",
        reason: reclaimed.reason ?? "Blocked delivery was not reclaimed",
      };
    }
    const issue = await this.options.transport.fetchIssue({
      repository: input.lease.repository,
      issueNumber: input.issueNumber,
    });
    if (issue === undefined)
      throw new Error("Resumed source issue is not published");
    const issuePublication = await this.publishIssueLabels({
      jobId: input.jobId,
      lease: input.lease,
      issueNumber: input.issueNumber,
      labels: projectResumedLabels(issue.labels),
      key: "resumed",
    });
    let pullRequest:
      | GitHubPublicationResult<GitHubPullRequestSnapshot>
      | undefined;
    if (input.pullRequest !== undefined) {
      const pullRequestInput = input.pullRequest;
      const marker = `pull-request-resumed:${markerPart(input.lease.repository)}:${markerPart(pullRequestInput.number)}`;
      const execution = await this.options.coordinator.publishEffect({
        jobId: input.jobId,
        lease: input.lease,
        branch: pullRequestInput.branch,
        kind: "github-pull-request-resumed",
        marker,
        payload: {
          repository: input.lease.repository,
          number: pullRequestInput.number,
        },
        reconcile: async () => {
          const current = await this.options.transport.fetchPullRequest({
            repository: input.lease.repository,
            pullRequestNumber: pullRequestInput.number,
          });
          return current !== undefined &&
            current.state === "open" &&
            current.draft &&
            current.branch === pullRequestInput.branch &&
            current.baseBranch === pullRequestInput.baseBranch &&
            current.headSha === pullRequestInput.headSha &&
            !(current.labels ?? []).includes(SHIPYARD_BLOCKED_LABEL) &&
            !(current.labels ?? []).includes(READY_FOR_HUMAN_LABEL)
            ? current
            : undefined;
        },
        publish: async () => {
          const current = await this.options.transport.fetchPullRequest({
            repository: input.lease.repository,
            pullRequestNumber: pullRequestInput.number,
          });
          if (current === undefined)
            throw new Error("Tracked pull request is not published");
          if (
            current.state !== "open" ||
            current.branch !== pullRequestInput.branch ||
            current.baseBranch !== pullRequestInput.baseBranch ||
            current.headSha !== pullRequestInput.headSha
          ) {
            throw new Error(
              "Pull request candidate changed before resume projection",
            );
          }
          if (this.options.transport.updatePullRequest === undefined) {
            throw new Error(
              "GitHub transport cannot project pull request state",
            );
          }
          return this.options.transport.updatePullRequest({
            repository: input.lease.repository,
            pullRequestNumber: pullRequestInput.number,
            draft: true,
            labels: projectResumedLabels(current.labels ?? []),
            marker: markerText(marker),
          });
        },
      });
      pullRequest = result(marker, execution);
    }
    return {
      status: reclaimed.status,
      issue: issuePublication,
      pullRequest,
    };
  }

  async publishStandaloneIssueClosure(
    input: GitHubIssueClosurePublicationInput,
  ): Promise<{
    readonly comment: GitHubPublicationResult<GitHubCommentSnapshot>;
    readonly issue: GitHubPublicationResult<GitHubIssueSnapshot>;
  }> {
    if (!input.cleanupCompleted) {
      throw new Error(
        "Cannot close an issue before cleanup/self-check completes",
      );
    }
    if (input.commitSha.trim().length === 0) {
      throw new Error("Cannot close an issue without a published commit");
    }
    const job = await this.options.coordinator.getJob(input.jobId);
    if (job === undefined)
      throw new Error(`Workflow job ${input.jobId} does not exist`);
    const requiredChecks = job.policy.checks
      .filter((check) => check.required)
      .map((check) => check.name);
    for (const name of requiredChecks) {
      const check = input.checks.find(
        (candidate) =>
          candidate.name === name &&
          candidate.status === "passed" &&
          candidate.baseSha === job.brief.base.sha &&
          candidate.headSha === input.commitSha &&
          candidate.briefHash === job.brief.hash,
      );
      if (check === undefined) {
        throw new Error(
          `Cannot close an issue before check ${name} passes for the current candidate`,
        );
      }
    }
    const pullRequest = await this.options.transport.fetchPullRequest({
      repository: input.lease.repository,
      pullRequestNumber: input.pullRequestNumber,
    });
    if (
      pullRequest === undefined ||
      pullRequest.branch !== input.branch ||
      pullRequest.headSha !== input.commitSha
    ) {
      throw new Error(
        "Cannot close an issue before its candidate is published",
      );
    }

    const comment = await this.publishComment({
      jobId: input.jobId,
      lease: input.lease,
      issueNumber: input.issueNumber,
      key: `closure:${input.commitSha}:${input.pullRequestNumber}`,
      body: [
        "Shipyard completed the standalone implementation.",
        `- Commit: \`${input.commitSha}\``,
        `- Pull request: #${input.pullRequestNumber}`,
        `- Branch: \`${input.branch}\``,
        "- Focused checks passed and cleanup/self-check completed.",
      ].join("\n"),
    });
    const marker = `issue-close:${markerPart(input.lease.repository)}:${markerPart(input.issueNumber)}:${markerPart(input.commitSha)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.issueNumber),
      kind: "github-issue-close",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.issueNumber,
        pullRequestNumber: input.pullRequestNumber,
        commitSha: input.commitSha,
      },
      reconcile: async () => {
        const issue = await this.options.transport.fetchIssue({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
        });
        return issue?.state === "closed" ? issue : undefined;
      },
      publish: async () => {
        if (this.options.transport.closeIssue === undefined) {
          throw new Error("GitHub transport cannot close source issues");
        }
        return this.options.transport.closeIssue({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
        });
      },
    });
    return { comment, issue: result(marker, execution) };
  }

  /** Publish one aggregate evidence comment, then close the parent idempotently. */
  async publishPlanningSpecClosure(
    input: GitHubPlanningSpecClosurePublicationInput,
  ): Promise<GitHubPlanningSpecClosurePublicationResult> {
    if (input.mergedSha.trim().length === 0) {
      throw new Error("Cannot close a planning spec without a merged revision");
    }
    const job = await this.options.coordinator.getJob(input.jobId);
    if (job === undefined) {
      throw new Error(`Workflow job ${input.jobId} does not exist`);
    }
    if (
      job.brief.identity.kind !== "planning-spec" ||
      job.brief.identity.itemId !== String(input.parentIssueNumber)
    ) {
      throw new Error("Planning-spec closure is not bound to the parent job");
    }
    const comment = await this.publishComment({
      jobId: input.jobId,
      lease: input.lease,
      issueNumber: input.parentIssueNumber,
      key: `planning-spec-closure:${input.pullRequestNumber}:${input.mergedSha}`,
      body: formatPlanningSpecCompletionComment({
        pullRequestNumber: input.pullRequestNumber,
        pullRequestUrl: input.pullRequestUrl,
        mergedSha: input.mergedSha,
        originalChildren: input.originalChildren,
        repairChildren: input.repairChildren,
      }),
    });
    if (comment.remote === undefined) {
      return { comment };
    }

    const marker = `planning-spec-close:${markerPart(input.lease.repository)}:${markerPart(input.parentIssueNumber)}:${markerPart(input.pullRequestNumber)}:${markerPart(input.mergedSha)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.parentIssueNumber),
      deliveryKey: job.deliveryKey,
      kind: "github-planning-spec-close",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.parentIssueNumber,
        pullRequestNumber: input.pullRequestNumber,
        mergedSha: input.mergedSha,
      },
      reconcile: async () => {
        const issue = await this.options.transport.fetchIssue({
          repository: input.lease.repository,
          issueNumber: input.parentIssueNumber,
        });
        return issue?.state === "closed" ? issue : undefined;
      },
      publish: async () => {
        if (this.options.transport.closeIssue === undefined) {
          throw new Error("GitHub transport cannot close planning specs");
        }
        return this.options.transport.closeIssue({
          repository: input.lease.repository,
          issueNumber: input.parentIssueNumber,
        });
      },
    });
    return { comment, issue: result(marker, execution) };
  }

  async publishCheck(
    input: GitHubCheckPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubCheckSnapshot>> {
    const marker = `check:${markerPart(input.jobId)}:${markerPart(input.key ?? input.name)}:${markerPart(input.headSha)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-check",
      marker,
      payload: { repository: input.lease.repository, name: input.name },
      reconcile: () =>
        this.options.transport.findCheckByMarker({
          repository: input.lease.repository,
          marker: markerText(marker),
          headSha: input.headSha,
        }),
      publish: () =>
        this.options.transport.createCheck({
          repository: input.lease.repository,
          name: input.name,
          headSha: input.headSha,
          marker: markerText(marker),
          status: input.status,
          conclusion: input.conclusion,
          summary: input.summary,
        }),
    });
    return result(marker, execution);
  }

  async publishRepairIssue(
    input: GitHubRepairIssuePublicationInput,
  ): Promise<GitHubPublicationResult<GitHubIssueSnapshot>> {
    const marker = `repair-issue:${markerPart(input.jobId)}:${markerHash(input.title)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      kind: "github-repair-issue",
      marker,
      payload: { repository: input.lease.repository },
      reconcile: () =>
        this.options.transport.findIssueByMarker({
          repository: input.lease.repository,
          marker: markerText(marker),
        }),
      publish: () =>
        this.options.transport.createRepairIssue({
          repository: input.lease.repository,
          title: input.title,
          body: `${markerText(marker)}\n${input.body}`,
          marker: markerText(marker),
          labels: input.labels ?? ["shipyard:pr-repair"],
        }),
    });
    return result(marker, execution);
  }

  async publishRepairLink(
    input: GitHubRepairLinkPublicationInput,
  ): Promise<GitHubPublicationResult<GitHubCommentSnapshot>> {
    const marker = `repair-link:${markerPart(input.jobId)}:${markerHash(input.repairIssueUrl)}`;
    const body = `${markerText(marker)}\nLinked repair issue: ${input.repairIssueUrl}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      itemId: String(input.issueNumber),
      kind: "github-repair-link",
      marker,
      payload: {
        repository: input.lease.repository,
        issueNumber: input.issueNumber,
      },
      reconcile: () =>
        this.options.transport.findCommentByMarker({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          marker: markerText(marker),
        }),
      publish: () =>
        this.options.transport.createComment({
          repository: input.lease.repository,
          issueNumber: input.issueNumber,
          body,
        }),
    });
    return result(marker, execution);
  }
}
