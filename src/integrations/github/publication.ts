import { createHash } from "node:crypto";
import { GITHUB_PUBLICATION_METADATA_VERSION } from "./types.js";
import type {
  GitHubBranchPublicationInput,
  GitHubBranchSnapshot,
  GitHubBriefPublicationInput,
  GitHubCheckPublicationInput,
  GitHubCheckSnapshot,
  GitHubCommentPublicationInput,
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubIssueClosurePublicationInput,
  GitHubPublicationOptions,
  GitHubPublicationResult,
  GitHubPullRequestDraftPublicationInput,
  GitHubPullRequestHandoffPublicationInput,
  GitHubPullRequestPublicationInput,
  GitHubPullRequestSnapshot,
  GitHubPublicationMetadata,
  GitHubRepairIssuePublicationInput,
  GitHubRepairLinkPublicationInput,
} from "./types.js";

const markerText = (marker: string): string => `<!-- shipyard:${marker} -->`;

// Markers are embedded in HTML comments and later used for reconciliation.
// Encode caller-controlled components so a branch/key/name containing `-->`
// cannot terminate the comment or manufacture a second marker.
const markerPart = (value: string | number): string =>
  encodeURIComponent(String(value));

const markerHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

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
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-branch",
      marker,
      payload: { repository: input.lease.repository, branch: input.branch },
      reconcile: () =>
        this.options.transport.findBranchByName({
          repository: input.lease.repository,
          branch: input.branch,
        }),
      publish: () =>
        this.options.transport.createBranch({
          repository: input.lease.repository,
          branch: input.branch,
          headSha: input.headSha,
          marker: markerText(marker),
        }),
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
      reconcile: () =>
        this.options.transport.findPullRequestByMarker({
          repository: input.lease.repository,
          marker: markerText(marker),
        }),
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
    const marker = `pull-request-ready:${markerPart(input.lease.repository)}:${markerPart(input.pullRequestNumber)}:${markerPart(input.headSha)}`;
    const matchesCandidate = (
      pullRequest: GitHubPullRequestSnapshot,
    ): boolean =>
      pullRequest.state === "open" &&
      !pullRequest.draft &&
      pullRequest.branch === input.branch &&
      pullRequest.baseBranch === input.baseBranch &&
      pullRequest.headSha === input.headSha &&
      (pullRequest.labels ?? []).includes("ready-for-human") &&
      !(pullRequest.labels ?? []).includes("shipyard-blocked");
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
            "Pull request candidate changed before human handoff",
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
