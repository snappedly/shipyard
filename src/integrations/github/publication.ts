import { createHash } from "node:crypto";
import type {
  GitHubBranchPublicationInput,
  GitHubBranchSnapshot,
  GitHubBriefPublicationInput,
  GitHubCheckPublicationInput,
  GitHubCheckSnapshot,
  GitHubCommentPublicationInput,
  GitHubCommentSnapshot,
  GitHubIssueSnapshot,
  GitHubPublicationOptions,
  GitHubPublicationResult,
  GitHubPullRequestPublicationInput,
  GitHubPullRequestSnapshot,
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
    const marker = `pull-request:${markerPart(input.jobId)}:${markerPart(input.branch)}`;
    const execution = await this.options.coordinator.publishEffect({
      jobId: input.jobId,
      lease: input.lease,
      branch: input.branch,
      headSha: input.headSha,
      kind: "github-pull-request",
      marker,
      payload: { repository: input.lease.repository, branch: input.branch },
      reconcile: () =>
        this.options.transport.findPullRequestByMarker({
          repository: input.lease.repository,
          marker: markerText(marker),
        }),
      publish: () =>
        this.options.transport.createPullRequest({
          repository: input.lease.repository,
          title: input.title,
          body: `${markerText(marker)}\n${input.body}`,
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
      const job = await this.options.coordinator.getJob(input.jobId);
      if (job !== undefined) {
        await this.options.trackingStore.saveTrackedPullRequest({
          repository: input.lease.repository,
          pullRequestNumber: publication.remote.number,
          jobId: input.jobId,
          itemId: job.key.itemId,
          branch: input.branch,
          headSha: input.headSha,
          marker,
          brief: job.brief,
          policy: job.policy,
          createdAt: this.options.now?.() ?? new Date().toISOString(),
        });
      }
    }
    return publication;
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
