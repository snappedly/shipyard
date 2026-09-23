import { createHash } from "node:crypto";
import type {
  DeliveryEffectExecution,
  DeliveryKey,
  DeliveryLease,
  WorkflowCoordinator,
} from "../../workflow/coordinator/index.js";
import type {
  CheckEvidence,
  RevisionReference,
  WorkIdentity,
} from "../../workflow/contracts/index.js";
import { sameRevision } from "../../workflow/shared.js";
import type {
  CompleteSpecChildInput,
  EnsureSpecPullRequestInput,
  IntegrateSpecChildInput,
  PublishSpecCandidateInput,
  ReconcileSpecDeliveryInput,
  SpecCandidate,
  SpecChildLifecycle,
  SpecIntegrationAdapter,
  SpecPullRequest,
  SpecRemoteDeliveryState,
} from "../../workflow/spec/index.js";
import {
  parseGitHubPublicationMetadata,
  projectActiveLabels,
  projectBlockedLabels,
  serializeGitHubPublicationMetadata,
} from "./publication.js";
import {
  GITHUB_PUBLICATION_METADATA_VERSION,
  READY_FOR_HUMAN_LABEL,
  SHIPYARD_LABEL,
  SHIPYARD_BLOCKED_LABEL,
  SHIPYARD_BLOCKED_LABEL_COLOR,
  SHIPYARD_BLOCKED_LABEL_DESCRIPTION,
} from "./types.js";
import type {
  GitHubCheckSnapshot,
  GitHubPullRequestSnapshot,
  GitHubReadTransport,
  GitHubWriteTransport,
} from "./types.js";

const markerPart = (value: string | number): string =>
  encodeURIComponent(String(value));

const markerText = (marker: string): string => `<!-- shipyard:${marker} -->`;

const markerHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

const issueNumber = (identity: WorkIdentity): number => {
  if (!/^[1-9]\d*$/.test(identity.itemId)) {
    throw new Error(`GitHub issue number is invalid: ${identity.itemId}`);
  }
  return Number(identity.itemId);
};

const asSpecPullRequest = (
  pullRequest: GitHubPullRequestSnapshot,
): SpecPullRequest => ({
  id: String(pullRequest.number),
  baseBranch: pullRequest.baseBranch,
  headBranch: pullRequest.branch,
  draft: pullRequest.draft,
});

const candidateMarker = (input: {
  readonly key: DeliveryKey;
  readonly branch: string;
}): string =>
  `pull-request:${markerPart(input.key.repository)}:${markerPart(input.key.itemId)}:${markerPart(input.branch)}`;

const branchMarker = (input: {
  readonly delivery: { readonly key: DeliveryKey; readonly version: number };
  readonly head: RevisionReference;
}): string =>
  `spec-branch:${markerPart(input.delivery.key.repository)}:${markerPart(input.delivery.key.itemId)}:${markerPart(input.delivery.version)}:${markerPart(input.head.sha)}`;

export interface GitHubSpecDeliveryGitAdapter {
  /** Read the pending child integration from the current remote branch. */
  reconcile(
    input: ReconcileSpecDeliveryInput,
  ): Promise<Pick<SpecRemoteDeliveryState, "integratedChild">>;
  /** Build one serial child commit in a disposable host worktree. */
  integrateChild(input: IntegrateSpecChildInput): Promise<RevisionReference>;
}

export interface PublishGitHubSpecCheckInput {
  readonly delivery: ReconcileSpecDeliveryInput["delivery"];
  readonly candidate: SpecCandidate;
  readonly check: CheckEvidence;
  readonly key: string;
  readonly lease: DeliveryLease;
  readonly signal: AbortSignal;
}

export interface PublishGitHubSpecBlockedInput {
  readonly delivery: ReconcileSpecDeliveryInput["delivery"];
  readonly lease: DeliveryLease;
  readonly reason: string;
  readonly candidate?: SpecCandidate;
  readonly signal?: AbortSignal;
}

export interface GitHubSpecDeliveryHost {
  readonly integration: SpecIntegrationAdapter;
  readonly childLifecycle: SpecChildLifecycle;
  publishCheck(
    input: PublishGitHubSpecCheckInput,
  ): Promise<GitHubCheckSnapshot>;
  publishBlocked(input: PublishGitHubSpecBlockedInput): Promise<void>;
}

export interface GitHubSpecDeliveryHostOptions {
  readonly coordinator: WorkflowCoordinator;
  readonly transport: GitHubReadTransport & GitHubWriteTransport;
  readonly git: GitHubSpecDeliveryGitAdapter;
}

const requireRemote = <T>(
  execution: DeliveryEffectExecution<T>,
  message: string,
): T => {
  if (execution.externalRef === undefined) throw new Error(message);
  return execution.externalRef;
};

/** Compose the GitHub side of spec delivery around durable DeliveryLease effects. */
export const createGitHubSpecDeliveryHost = (
  options: GitHubSpecDeliveryHostOptions,
): GitHubSpecDeliveryHost => {
  const { coordinator, transport } = options;
  const pullRequestMarker = (delivery: { readonly key: DeliveryKey }) =>
    candidateMarker({
      key: delivery.key,
      branch: `shipyard/spec-${delivery.key.itemId}`,
    });

  const deactivateSpecRoot = async (input: {
    readonly delivery: ReconcileSpecDeliveryInput["delivery"];
    readonly lease: DeliveryLease;
    readonly pullRequestNumber: number;
    readonly headSha: string;
  }): Promise<void> => {
    const repository = input.delivery.key.repository;
    const number = issueNumber(input.delivery.root);
    const marker = `spec-human-handoff-deactivate:${markerPart(input.delivery.version)}:${markerPart(input.pullRequestNumber)}:${markerPart(input.headSha)}`;
    const execution = await coordinator.publishDeliveryEffect({
      key: input.delivery.key,
      lease: input.lease,
      expectedDeliveryVersion: input.delivery.version,
      kind: "github-spec-human-handoff-deactivate",
      marker,
      payload: {
        issueNumber: number,
        pullRequestNumber: input.pullRequestNumber,
        headSha: input.headSha,
      },
      reconcile: async () => {
        const current = await transport.fetchIssue({
          repository,
          issueNumber: number,
        });
        return current !== undefined &&
          current.state === "open" &&
          !current.labels.some(
            (label) => label.toLowerCase() === SHIPYARD_LABEL,
          )
          ? current
          : undefined;
      },
      publish: async () => {
        const current = await transport.fetchIssue({
          repository,
          issueNumber: number,
        });
        if (current === undefined || current.state !== "open") {
          throw new Error("Planning spec changed before handoff deactivation");
        }
        const labels = current.labels.filter(
          (label) => label.toLowerCase() !== SHIPYARD_LABEL,
        );
        if (labels.length === current.labels.length) return current;
        if (transport.updateIssue === undefined) {
          throw new Error(
            "GitHub transport cannot deactivate the planning spec",
          );
        }
        return transport.updateIssue({
          repository,
          issueNumber: number,
          labels,
          marker: markerText(marker),
        });
      },
    });
    const issue = requireRemote(
      execution,
      "Spec handoff deactivation has no issue result",
    );
    if (
      issue.state !== "open" ||
      issue.labels.some((label) => label.toLowerCase() === SHIPYARD_LABEL)
    ) {
      throw new Error("Planning spec activation label remains after handoff");
    }
  };

  const ensureRemoteBranch = async (input: {
    readonly delivery: ReconcileSpecDeliveryInput["delivery"];
    readonly head: RevisionReference;
    readonly lease: DeliveryLease;
  }) => {
    const branch = input.head.branch;
    const marker = branchMarker({ delivery: input.delivery, head: input.head });
    const execution = await coordinator.publishDeliveryEffect({
      key: input.delivery.key,
      lease: input.lease,
      expectedDeliveryVersion: input.delivery.version,
      kind: "github-spec-integration-branch",
      marker,
      payload: { branch, headSha: input.head.sha },
      reconcile: async () => {
        const current = await transport.findBranchByName({
          repository: input.delivery.key.repository,
          branch,
        });
        return current?.headSha === input.head.sha ? current : undefined;
      },
      publish: async () => {
        const repository = input.delivery.key.repository;
        const current = await transport.findBranchByName({
          repository,
          branch,
        });
        if (current === undefined) {
          return transport.createBranch({
            repository,
            branch,
            headSha: input.head.sha,
            marker: markerText(marker),
          });
        }
        const trackedPullRequest = await transport.findPullRequestByMarker({
          repository,
          marker: markerText(pullRequestMarker(input.delivery)),
        });
        if (trackedPullRequest === undefined) {
          throw new Error(`Refusing to move untracked spec branch ${branch}`);
        }
        if (transport.updateBranch === undefined) {
          throw new Error("GitHub transport cannot update the spec branch");
        }
        return transport.updateBranch({
          repository,
          branch,
          headSha: input.head.sha,
          marker: markerText(marker),
        });
      },
    });
    const published = requireRemote(
      execution,
      "Spec integration branch publication has no remote result",
    );
    if (published.name !== branch || published.headSha !== input.head.sha) {
      throw new Error("Published spec branch does not match the candidate");
    }
    return published;
  };

  const publishDraftPullRequest = async (input: {
    readonly delivery: ReconcileSpecDeliveryInput["delivery"];
    readonly candidate: RevisionReference;
    readonly base: RevisionReference;
    readonly integrationBranch: string;
    readonly briefRevision: number;
    readonly briefHash: string;
    readonly lease: DeliveryLease;
  }): Promise<GitHubPullRequestSnapshot> => {
    await ensureRemoteBranch({
      delivery: input.delivery,
      head: input.candidate,
      lease: input.lease,
    });
    const repository = input.delivery.key.repository;
    const parent = issueNumber(input.delivery.root);
    const source = await transport.fetchIssue({
      repository,
      issueNumber: parent,
    });
    if (source === undefined || source.state !== "open") {
      throw new Error(`Planning spec #${parent} is not open on GitHub`);
    }
    const marker = pullRequestMarker(input.delivery);
    const effectMarker = `${marker}:candidate:${markerPart(input.delivery.version)}:${markerPart(input.candidate.sha)}`;
    const metadata = {
      version: GITHUB_PUBLICATION_METADATA_VERSION,
      deliveryVersion: input.delivery.version,
      repository,
      itemId: String(parent),
      kind: "planning-spec" as const,
      briefRevision: input.briefRevision,
      briefHash: input.briefHash,
      baseBranch: input.base.branch,
      baseSha: input.base.sha,
      branch: input.integrationBranch,
      headSha: input.candidate.sha,
    };
    const body = [
      markerText(marker),
      serializeGitHubPublicationMetadata(metadata),
      "## Planning spec delivery",
      "",
      `Source issue: #${parent}`,
      `Scoped children: ${input.delivery.graph.children.map((child) => `#${child.itemId}`).join(", ") || "none"}`,
      `Integration candidate: ${input.candidate.sha}`,
      "",
      "Required checks and independent review must pass before human handoff.",
    ].join("\n");
    const title = `[Shipyard] ${source.title}`;
    const execution = await coordinator.publishDeliveryEffect({
      key: input.delivery.key,
      lease: input.lease,
      expectedDeliveryVersion: input.delivery.version,
      kind: "github-spec-pull-request",
      marker: effectMarker,
      payload: {
        repository,
        parent,
        branch: input.integrationBranch,
        head: input.candidate.sha,
      },
      reconcile: async () => {
        const existing = await transport.findPullRequestByMarker({
          repository,
          marker: markerText(marker),
        });
        if (existing === undefined) return undefined;
        if (
          existing.state !== "open" ||
          existing.branch !== input.integrationBranch ||
          existing.baseBranch !== input.base.branch
        ) {
          throw new Error("Existing spec pull request is closed or mismatched");
        }
        if (
          existing.headSha === input.candidate.sha &&
          existing.body === body &&
          existing.title === title &&
          existing.draft &&
          !(existing.labels ?? []).includes(READY_FOR_HUMAN_LABEL) &&
          !(existing.labels ?? []).includes(SHIPYARD_BLOCKED_LABEL)
        ) {
          return existing;
        }
        if (transport.updatePullRequest === undefined) {
          throw new Error(
            "GitHub transport cannot update the spec pull request",
          );
        }
        return transport.updatePullRequest({
          repository,
          pullRequestNumber: existing.number,
          title,
          body,
          draft: true,
          labels: projectActiveLabels(existing.labels ?? []),
          marker: markerText(effectMarker),
        });
      },
      publish: async () => {
        const existing = await transport.findPullRequestByMarker({
          repository,
          marker: markerText(marker),
        });
        if (existing !== undefined) {
          if (transport.updatePullRequest === undefined) {
            throw new Error(
              "GitHub transport cannot update the spec pull request",
            );
          }
          return transport.updatePullRequest({
            repository,
            pullRequestNumber: existing.number,
            title,
            body,
            draft: true,
            labels: projectActiveLabels(existing.labels ?? []),
            marker: markerText(effectMarker),
          });
        }
        return transport.createPullRequest({
          repository,
          title,
          body,
          branch: input.integrationBranch,
          baseBranch: input.base.branch,
          draft: true,
          marker: markerText(marker),
        });
      },
    });
    const pullRequest = requireRemote(
      execution,
      "Spec pull request publication has no remote result",
    );
    if (
      pullRequest.state !== "open" ||
      !pullRequest.draft ||
      pullRequest.branch !== input.integrationBranch ||
      pullRequest.baseBranch !== input.base.branch ||
      pullRequest.headSha !== input.candidate.sha ||
      pullRequest.body !== body
    ) {
      throw new Error(
        "Published pull request does not match the exact spec candidate",
      );
    }
    return pullRequest;
  };

  const integration: SpecIntegrationAdapter = {
    reconcileDelivery: async (input) => {
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
      const repository = input.delivery.key.repository;
      const marker = pullRequestMarker(input.delivery);
      let scopeVersionChanged = false;
      let scopeChangeRetracted = false;
      let pullRequest = await transport.findPullRequestByMarker({
        repository,
        marker: markerText(marker),
      });
      if (pullRequest !== undefined) {
        if (
          pullRequest.state !== "open" ||
          pullRequest.branch !== input.integrationBranch ||
          pullRequest.baseBranch !== input.base.branch
        ) {
          throw new Error(
            "Spec pull request is closed or targets another branch",
          );
        }
        const metadata = parseGitHubPublicationMetadata(pullRequest.body);
        const scopeChanged =
          metadata?.deliveryVersion !== input.delivery.version;
        scopeVersionChanged = scopeChanged;
        const labels = projectActiveLabels(pullRequest.labels ?? []);
        if (
          scopeChanged &&
          (!pullRequest.draft ||
            labels.length !== (pullRequest.labels ?? []).length ||
            labels.some(
              (label) => !(pullRequest?.labels ?? []).includes(label),
            ))
        ) {
          const observed = pullRequest;
          const effectMarker = `spec-resume:${markerPart(input.delivery.version)}:${markerPart(observed.number)}:${markerPart(observed.updatedAt)}`;
          const execution = await coordinator.publishDeliveryEffect({
            key: input.delivery.key,
            lease: input.lease,
            expectedDeliveryVersion: input.delivery.version,
            kind: "github-spec-resume-pr",
            marker: effectMarker,
            payload: { pullRequestNumber: observed.number },
            reconcile: async () => {
              const current = await transport.fetchPullRequest({
                repository,
                pullRequestNumber: observed.number,
              });
              return current !== undefined &&
                current.state === "open" &&
                current.draft &&
                projectActiveLabels(current.labels ?? []).length ===
                  (current.labels ?? []).length
                ? current
                : undefined;
            },
            publish: async () => {
              const current = await transport.fetchPullRequest({
                repository,
                pullRequestNumber: observed.number,
              });
              if (
                current === undefined ||
                current.state !== "open" ||
                current.branch !== input.integrationBranch ||
                current.baseBranch !== input.base.branch
              ) {
                throw new Error(
                  "Spec pull request changed before resume projection",
                );
              }
              if (transport.updatePullRequest === undefined) {
                throw new Error(
                  "GitHub transport cannot retract the spec pull request",
                );
              }
              return transport.updatePullRequest({
                repository,
                pullRequestNumber: current.number,
                draft: true,
                labels,
                marker: markerText(effectMarker),
              });
            },
          });
          pullRequest = requireRemote(
            execution,
            "Spec resume has no pull request result",
          );
          scopeChangeRetracted = !observed.draft && pullRequest.draft;
        }
      }
      const gitState = await options.git.reconcile(input);
      const branch = await transport.findBranchByName({
        repository,
        branch: input.integrationBranch,
      });
      const pendingPublish = input.delivery.specCheckpoint?.children.find(
        (child) =>
          child.status === "publishing" && child.candidate !== undefined,
      );
      const pendingCandidate = pendingPublish?.candidate;
      if (
        branch !== undefined &&
        pendingCandidate !== undefined &&
        branch.headSha === pendingCandidate.head.sha &&
        pullRequest?.draft !== false
      ) {
        const metadata =
          pullRequest === undefined
            ? undefined
            : parseGitHubPublicationMetadata(pullRequest.body);
        const candidateMetadataMatches =
          pullRequest !== undefined &&
          metadata?.deliveryVersion === input.delivery.version &&
          metadata.briefRevision === pendingCandidate.briefRevision &&
          metadata.briefHash === pendingCandidate.briefHash &&
          metadata.baseBranch === pendingCandidate.base.branch &&
          metadata.baseSha === pendingCandidate.base.sha &&
          metadata.branch === pendingCandidate.head.branch &&
          metadata.headSha === pendingCandidate.head.sha &&
          pullRequest.headSha === pendingCandidate.head.sha &&
          pullRequest.number.toString() === pendingCandidate.pullRequest.id;
        if (!candidateMetadataMatches) {
          const briefRevision =
            pendingCandidate.briefRevision ??
            (metadata?.headSha === pendingCandidate.head.sha &&
            metadata.briefHash === pendingCandidate.briefHash
              ? metadata.briefRevision
              : undefined);
          if (briefRevision === undefined) {
            throw new Error(
              "Pending spec candidate has no recoverable brief revision",
            );
          }
          const recovered = await publishDraftPullRequest({
            delivery: input.delivery,
            candidate: pendingCandidate.head,
            base: pendingCandidate.base,
            integrationBranch: input.integrationBranch,
            briefRevision,
            briefHash: pendingCandidate.briefHash,
            lease: input.lease,
          });
          if (recovered.number.toString() !== pendingCandidate.pullRequest.id) {
            throw new Error(
              "Pending spec candidate recovery changed the pull request",
            );
          }
          pullRequest = recovered;
        }
      }
      if (
        pullRequest !== undefined &&
        (branch === undefined ||
          (branch.headSha !== pullRequest.headSha &&
            !deliveryCheckpointExplainsHead(input.delivery, branch.headSha) &&
            gitState.integratedChild?.head.sha !== branch.headSha))
      ) {
        throw new Error(
          "Spec pull request and integration branch heads disagree",
        );
      }
      const currentMetadata =
        pullRequest === undefined
          ? undefined
          : parseGitHubPublicationMetadata(pullRequest.body);
      if (
        pullRequest !== undefined &&
        !scopeVersionChanged &&
        !pullRequest.draft &&
        (pullRequest.labels ?? []).includes(READY_FOR_HUMAN_LABEL) &&
        currentMetadata?.version === GITHUB_PUBLICATION_METADATA_VERSION &&
        currentMetadata.repository === repository &&
        currentMetadata.itemId === input.delivery.key.itemId &&
        currentMetadata.kind === "planning-spec" &&
        currentMetadata.deliveryVersion === input.delivery.version &&
        currentMetadata.briefRevision !== undefined &&
        currentMetadata.briefHash.trim().length > 0 &&
        currentMetadata.baseBranch === input.base.branch &&
        currentMetadata.baseSha === input.base.sha &&
        currentMetadata.branch === input.integrationBranch &&
        currentMetadata.headSha === pullRequest.headSha
      ) {
        await deactivateSpecRoot({
          delivery: input.delivery,
          lease: input.lease,
          pullRequestNumber: pullRequest.number,
          headSha: pullRequest.headSha,
        });
      }
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
      return {
        ...(pullRequest === undefined
          ? {}
          : { pullRequest: asSpecPullRequest(pullRequest) }),
        ...(scopeVersionChanged ? { scopeVersionChanged: true } : {}),
        ...(scopeChangeRetracted ? { scopeChangeRetracted: true } : {}),
        ...(branch === undefined
          ? {}
          : { head: { branch: branch.name, sha: branch.headSha } }),
        ...gitState,
      };
    },
    ensureDraftPullRequest: async (input: EnsureSpecPullRequestInput) => {
      const pullRequest = await publishDraftPullRequest(input);
      return asSpecPullRequest(pullRequest);
    },
    integrateChild: async (input: IntegrateSpecChildInput) => {
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
      const integrated = await options.git.integrateChild(input);
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
      return integrated;
    },
    publishCandidate: async (input: PublishSpecCandidateInput) => {
      const pullRequest = await publishDraftPullRequest({
        delivery: input.delivery,
        candidate: input.candidate.head,
        base: input.candidate.base,
        integrationBranch: input.candidate.head.branch,
        briefRevision: input.candidate.briefRevision ?? 1,
        briefHash: input.candidate.briefHash,
        lease: input.lease,
      });
      if (String(pullRequest.number) !== input.candidate.pullRequest.id) {
        throw new Error("Spec publication updated another pull request");
      }
      if (
        !sameRevision(input.candidate.head, {
          branch: pullRequest.branch,
          sha: pullRequest.headSha,
        })
      ) {
        throw new Error(
          "Published pull request head does not match the candidate",
        );
      }
      return {
        pullRequestId: String(pullRequest.number),
        head: { branch: pullRequest.branch, sha: pullRequest.headSha },
      };
    },
    publishHumanHandoff: async (input: PublishSpecCandidateInput) => {
      const candidate = input.candidate;
      const number = Number(candidate.pullRequest.id);
      const marker = `spec-human-handoff:${markerPart(input.delivery.key.repository)}:${markerPart(input.delivery.key.itemId)}:${markerPart(input.delivery.version)}:${markerPart(candidate.head.sha)}`;
      const current = await transport.fetchPullRequest({
        repository: input.delivery.key.repository,
        pullRequestNumber: number,
      });
      if (
        current === undefined ||
        !matchesSpecCandidate(current, input, true)
      ) {
        throw new Error("Spec pull request changed before human handoff");
      }
      if (
        !current.draft &&
        (current.labels ?? []).includes(READY_FOR_HUMAN_LABEL)
      ) {
        await deactivateSpecRoot({
          delivery: input.delivery,
          lease: input.lease,
          pullRequestNumber: number,
          headSha: candidate.head.sha,
        });
        return;
      }
      const execution = await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-human-handoff",
        marker,
        payload: { pullRequestNumber: number, headSha: candidate.head.sha },
        reconcile: async () => {
          const latest = await transport.fetchPullRequest({
            repository: input.delivery.key.repository,
            pullRequestNumber: number,
          });
          return latest !== undefined &&
            matchesSpecCandidate(latest, input, false) &&
            (latest.labels ?? []).includes(READY_FOR_HUMAN_LABEL)
            ? latest
            : undefined;
        },
        publish: async () => {
          const latest = await transport.fetchPullRequest({
            repository: input.delivery.key.repository,
            pullRequestNumber: number,
          });
          if (
            latest === undefined ||
            !matchesSpecCandidate(latest, input, true)
          ) {
            throw new Error(
              "Spec candidate changed before handoff publication",
            );
          }
          if (transport.updatePullRequest === undefined) {
            throw new Error("GitHub transport cannot publish a human handoff");
          }
          return transport.updatePullRequest({
            repository: input.delivery.key.repository,
            pullRequestNumber: number,
            draft: false,
            labels: [
              ...new Set([...(latest.labels ?? []), READY_FOR_HUMAN_LABEL]),
            ],
            marker: markerText(marker),
          });
        },
      });
      const published = requireRemote(
        execution,
        "Spec handoff has no pull request result",
      );
      if (
        !matchesSpecCandidate(published, input, false) ||
        !(published.labels ?? []).includes(READY_FOR_HUMAN_LABEL)
      ) {
        throw new Error(
          "Human handoff does not match the exact reviewed candidate",
        );
      }
      await deactivateSpecRoot({
        delivery: input.delivery,
        lease: input.lease,
        pullRequestNumber: number,
        headSha: candidate.head.sha,
      });
    },
  };

  const childLifecycle: SpecChildLifecycle = {
    reconcileChild: async ({ delivery, child, lease }) => {
      await coordinator.assertDeliveryLeaseOwnership(lease, delivery.version);
      assertChildInScope(delivery.graph.children, child);
      const issue = await transport.fetchIssue({
        repository: child.repository,
        issueNumber: issueNumber(child),
      });
      if (issue === undefined)
        throw new Error(`Child issue #${child.itemId} is missing`);
      return issue.state;
    },
    closeChild: async (input: CompleteSpecChildInput) => {
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
      assertChildInScope(input.delivery.graph.children, input.child);
      const repository = input.delivery.key.repository;
      const number = issueNumber(input.child);
      const childMarker = `spec-child-completion:${markerPart(repository)}:${markerPart(input.delivery.key.itemId)}:${markerPart(number)}:${markerPart(input.sourceCommit.sha)}:${markerPart(input.candidate.head.sha)}`;
      const body = [
        markerText(childMarker),
        `Integrated into ${input.candidate.pullRequest.headBranch} at ${input.candidate.head.sha}.`,
        `Source commit: ${input.sourceCommit.sha}`,
        `Focused verification: ${input.verification.checks.map((check) => `${check.name} ${check.status}`).join(", ") || "passed"}.`,
        `Cleanup: ${input.verification.cleanup.summary}`,
        ...input.verification.evidence.map((evidence) => `- ${evidence}`),
      ].join("\n");
      const comment = await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-child-completion-comment",
        marker: childMarker,
        payload: { issueNumber: number, headSha: input.candidate.head.sha },
        reconcile: () =>
          transport.findCommentByMarker({
            repository,
            issueNumber: number,
            marker: markerText(childMarker),
          }),
        publish: () =>
          transport.createComment({
            repository,
            issueNumber: number,
            body,
          }),
      });
      if (comment.externalRef === undefined) {
        throw new Error("Child completion comment is not reconciled on GitHub");
      }
      const closeMarker = `${childMarker}:close`;
      const closed = await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-child-close",
        marker: closeMarker,
        payload: { issueNumber: number, headSha: input.candidate.head.sha },
        reconcile: async () => {
          const issue = await transport.fetchIssue({
            repository,
            issueNumber: number,
          });
          return issue?.state === "closed" ? issue : undefined;
        },
        publish: async () => {
          const issue = await transport.fetchIssue({
            repository,
            issueNumber: number,
          });
          if (issue === undefined || issue.state !== "open") {
            throw new Error(`Child issue #${number} changed before closure`);
          }
          if (transport.closeIssue === undefined) {
            throw new Error("GitHub transport cannot close child issues");
          }
          return transport.closeIssue({ repository, issueNumber: number });
        },
      });
      if (closed.externalRef?.state !== "closed") {
        throw new Error(`Child issue #${number} is not closed on GitHub`);
      }
      await coordinator.assertDeliveryLeaseOwnership(
        input.lease,
        input.delivery.version,
      );
    },
  };

  return {
    integration,
    childLifecycle,
    publishCheck: async (input) => {
      const repository = input.delivery.key.repository;
      const number = Number(input.delivery.key.itemId);
      const marker = `spec-check:${markerPart(repository)}:${markerPart(number)}:${markerPart(input.key)}:${markerPart(input.check.name)}:${markerPart(input.candidate.head.sha)}`;
      const status: GitHubCheckSnapshot["status"] = "completed";
      const conclusion: GitHubCheckSnapshot["conclusion"] =
        input.check.status === "passed"
          ? "success"
          : input.check.status === "failed"
            ? "failure"
            : input.check.status === "blocked"
              ? "action_required"
              : input.check.status === "incomplete"
                ? "stale"
                : "neutral";
      const execution = await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-check",
        marker,
        payload: { name: input.check.name, headSha: input.candidate.head.sha },
        reconcile: () =>
          transport.findCheckByMarker({
            repository,
            marker: markerText(marker),
            headSha: input.candidate.head.sha,
          }),
        publish: () =>
          transport.createCheck({
            repository,
            name: input.check.name,
            headSha: input.candidate.head.sha,
            marker: markerText(marker),
            status,
            conclusion,
            summary: input.check.summary,
          }),
      });
      const remote = requireRemote(
        execution,
        "Spec check publication has no remote result",
      );
      if (remote.headSha !== input.candidate.head.sha) {
        throw new Error("Published check is not bound to the exact candidate");
      }
      return remote;
    },
    publishBlocked: async (input) => {
      const repository = input.delivery.key.repository;
      const number = issueNumber(input.delivery.root);
      const issue = await transport.fetchIssue({
        repository,
        issueNumber: number,
      });
      if (issue === undefined)
        throw new Error(`Planning spec #${number} is missing`);
      if (transport.ensureLabel !== undefined) {
        const labelMarker = `spec-blocked-label:${markerPart(repository)}:${markerPart(input.delivery.key.itemId)}`;
        await coordinator.publishDeliveryEffect({
          key: input.delivery.key,
          lease: input.lease,
          expectedDeliveryVersion: input.delivery.version,
          kind: "github-spec-blocked-label",
          marker: labelMarker,
          publish: () =>
            transport.ensureLabel!({
              repository,
              name: SHIPYARD_BLOCKED_LABEL,
              color: SHIPYARD_BLOCKED_LABEL_COLOR,
              description: SHIPYARD_BLOCKED_LABEL_DESCRIPTION,
            }),
          reconcile: () =>
            transport.ensureLabel!({
              repository,
              name: SHIPYARD_BLOCKED_LABEL,
              color: SHIPYARD_BLOCKED_LABEL_COLOR,
              description: SHIPYARD_BLOCKED_LABEL_DESCRIPTION,
            }),
        });
      }
      if (transport.updateIssue === undefined) {
        throw new Error("GitHub transport cannot mark blocked spec issues");
      }
      const issueMarker = `spec-blocked:${markerPart(repository)}:${markerPart(number)}:${markerPart(input.delivery.version)}`;
      await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-blocked-issue",
        marker: issueMarker,
        payload: { issueNumber: number },
        reconcile: async () => {
          const current = await transport.fetchIssue({
            repository,
            issueNumber: number,
          });
          return current !== undefined &&
            current.labels.includes(SHIPYARD_BLOCKED_LABEL)
            ? current
            : undefined;
        },
        publish: async () => {
          const current = await transport.fetchIssue({
            repository,
            issueNumber: number,
          });
          if (current === undefined || current.state !== "open") {
            throw new Error(
              "Planning spec changed before blocked-state projection",
            );
          }
          return transport.updateIssue!({
            repository,
            issueNumber: number,
            labels: projectBlockedLabels(current.labels),
            marker: markerText(issueMarker),
          });
        },
      });
      const commentMarker = `spec-blocked-comment:${issueMarker}:${markerHash(input.reason)}`;
      await coordinator.publishDeliveryEffect({
        key: input.delivery.key,
        lease: input.lease,
        expectedDeliveryVersion: input.delivery.version,
        kind: "github-spec-blocked-comment",
        marker: commentMarker,
        payload: { issueNumber: number },
        reconcile: () =>
          transport.findCommentByMarker({
            repository,
            issueNumber: number,
            marker: markerText(commentMarker),
          }),
        publish: () =>
          transport.createComment({
            repository,
            issueNumber: number,
            body: `${markerText(commentMarker)}\nShipyard blocked this planning spec.\n\n${input.reason}\n\nRe-add the shipyard label after resolving the blocker to resume the existing delivery.`,
          }),
      });
      if (input.candidate !== undefined) {
        const prNumber = Number(input.candidate.pullRequest.id);
        const current = await transport.fetchPullRequest({
          repository,
          pullRequestNumber: prNumber,
        });
        if (
          current === undefined ||
          !matchesSpecCandidate(current, {
            delivery: input.delivery,
            candidate: input.candidate,
          })
        ) {
          throw new Error(
            "Spec pull request changed before blocked-state projection",
          );
        }
        if (transport.updatePullRequest === undefined) {
          throw new Error(
            "GitHub transport cannot mark blocked spec pull requests",
          );
        }
        const prMarker = `spec-blocked-pr:${issueMarker}:${prNumber}:${markerPart(input.candidate.head.sha)}`;
        await coordinator.publishDeliveryEffect({
          key: input.delivery.key,
          lease: input.lease,
          expectedDeliveryVersion: input.delivery.version,
          kind: "github-spec-blocked-pr",
          marker: prMarker,
          payload: {
            pullRequestNumber: prNumber,
            headSha: input.candidate.head.sha,
          },
          reconcile: async () => {
            const latest = await transport.fetchPullRequest({
              repository,
              pullRequestNumber: prNumber,
            });
            return latest !== undefined &&
              matchesSpecCandidate(latest, {
                delivery: input.delivery,
                candidate: input.candidate!,
              }) &&
              latest.draft &&
              (latest.labels ?? []).includes(SHIPYARD_BLOCKED_LABEL)
              ? latest
              : undefined;
          },
          publish: async () => {
            const latest = await transport.fetchPullRequest({
              repository,
              pullRequestNumber: prNumber,
            });
            if (
              latest === undefined ||
              !matchesSpecCandidate(latest, {
                delivery: input.delivery,
                candidate: input.candidate!,
              })
            ) {
              throw new Error(
                "Spec candidate changed before blocked PR projection",
              );
            }
            return transport.updatePullRequest!({
              repository,
              pullRequestNumber: prNumber,
              draft: true,
              labels: projectBlockedLabels(latest.labels ?? []),
              marker: markerText(prMarker),
            });
          },
        });
      }
    },
  };
};

const deliveryCheckpointExplainsHead = (
  delivery: ReconcileSpecDeliveryInput["delivery"],
  headSha: string,
): boolean =>
  delivery.specCheckpoint?.children.some(
    (child) =>
      child.status === "publishing" && child.candidate?.head.sha === headSha,
  ) ?? false;

const assertChildInScope = (
  children: readonly WorkIdentity[],
  child: WorkIdentity,
): void => {
  if (
    !children.some(
      (candidate) =>
        candidate.itemId === child.itemId &&
        candidate.repository === child.repository &&
        candidate.kind === child.kind,
    )
  ) {
    throw new Error(`Child #${child.itemId} is outside the current spec scope`);
  }
};

const matchesSpecCandidate = (
  pullRequest: GitHubPullRequestSnapshot,
  input: {
    readonly delivery: ReconcileSpecDeliveryInput["delivery"];
    readonly candidate: SpecCandidate;
  },
  draft?: boolean,
): boolean => {
  const { candidate, delivery } = input;
  const metadata = parseGitHubPublicationMetadata(pullRequest.body);
  return (
    pullRequest.state === "open" &&
    (draft === undefined || pullRequest.draft === draft) &&
    pullRequest.number.toString() === candidate.pullRequest.id &&
    pullRequest.branch === candidate.head.branch &&
    pullRequest.baseBranch === candidate.base.branch &&
    pullRequest.headSha === candidate.head.sha &&
    candidate.deliveryId === delivery.id &&
    candidate.briefRevision !== undefined &&
    metadata?.repository === delivery.key.repository &&
    metadata.itemId === delivery.key.itemId &&
    metadata.kind === "planning-spec" &&
    metadata.deliveryVersion === delivery.version &&
    metadata.briefRevision === candidate.briefRevision &&
    metadata.briefHash === candidate.briefHash &&
    metadata.baseBranch === candidate.base.branch &&
    metadata.baseSha === candidate.base.sha &&
    metadata.branch === candidate.head.branch &&
    metadata.headSha === candidate.head.sha
  );
};
