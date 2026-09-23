// Sequential Reviewer — one coordinator-owned implementation and review per run.
import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

// Generated entrypoint: .shipyard/main.mts
// Run this with: npx shipyard run

const modelEnvAllowlist = ["__WORKER_ENV_ALLOWLIST__"] as const;
const sandboxHooks = {
  sandbox: {
    onSandboxReady: [
      {
        command:
          "npm install && npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
        timeoutMs: 300_000,
      },
    ],
  },
};
const copyToWorktree = ["node_modules"];
const phaseReportSchema = z.object({
  outcome: z.enum(["completed", "needs-info"]).optional(),
  summary: z.string().min(1),
  evidence: z.array(z.string()).min(1),
  checks: z.array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      status: z.enum(["passed", "failed", "incomplete", "blocked", "unknown"]),
      summary: z.string().min(1),
    }),
  ),
  questions: z.array(z.string()).optional(),
});
const reviewSchema = z.object({
  outcome: z.enum([
    "passed",
    "actionable-findings",
    "incomplete",
    "blocked",
    "failed",
  ]),
  axes: z.array(z.enum(["standards", "spec", "interface"])),
  findings: z.array(
    z.object({
      id: z.string().min(1),
      severity: z.enum(["info", "low", "medium", "high", "critical"]),
      axis: z.enum(["standards", "spec", "interface"]),
      title: z.string().min(1),
      evidence: z.string().min(1),
      location: z.string().optional(),
      requirement: z.string().optional(),
      verification: z.string().optional(),
    }),
  ),
  evidence: z.array(z.string()),
});

const exec = promisify(execFile);
const cwd = process.cwd();
const hostEnv = {
  ...process.env,
  ...(await shipyard.loadShipyardEnv(cwd)),
};
const hostCommand = async (
  file: string,
  args: readonly string[],
): Promise<string> =>
  (
    await exec(file, args, {
      encoding: "utf8",
      env: hostEnv,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();

const repository =
  hostEnv.GH_REPO ??
  JSON.parse(
    await hostCommand("gh", ["repo", "view", "--json", "nameWithOwner"]),
  ).nameWithOwner;
if (
  typeof repository !== "string" ||
  !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
) {
  throw new Error(
    "Set GH_REPO to owner/repository or run inside a GitHub checkout",
  );
}

const baseBranch = hostEnv.SHIPYARD_BASE_BRANCH?.trim() || "staging";
const currentBase = async (): Promise<shipyard.RevisionReference> => {
  const output = await hostCommand("git", [
    "ls-remote",
    "origin",
    `refs/heads/${baseBranch}`,
  ]);
  const sha = output.split(/\s+/)[0];
  if (!sha || !/^[a-f0-9]{40,64}$/i.test(sha)) {
    throw new Error(`Could not read the current origin/${baseBranch} head`);
  }
  return { branch: baseBranch, sha };
};

const configuredChecks = z
  .array(
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      required: z.boolean(),
    }),
  )
  .min(1)
  .parse(
    JSON.parse(
      hostEnv.SHIPYARD_CHECKS ??
        '[{"name":"tests","command":"npm test","required":true}]',
    ),
  );
if (!configuredChecks.some((check) => check.required)) {
  throw new Error("SHIPYARD_CHECKS must include at least one required check");
}

const policy = shipyard.createRepositoryPolicy({
  repository,
  revision: "sequential-reviewer-v1",
  baseBranch,
  issueClosure: "merge-and-ci",
  authorization: {
    required: true,
    allowedActors: ["policy"],
    autoStartRisk: ["low", "medium"],
  },
  worker: {
    provider: "__WORKER_PROVIDER__",
    model: "__WORKER_MODEL__",
    sandbox: "isolated-docker",
    skillRevision: "bundled-skills",
  },
  checks: configuredChecks,
  phaseBudgets: {
    triage: { maxAttempts: 1, timeoutSeconds: 60 },
    implementation: { maxAttempts: 1, timeoutSeconds: 1800 },
    checking: { maxAttempts: 1, timeoutSeconds: 900 },
    review: { maxAttempts: 1, timeoutSeconds: 900 },
    repair: { maxAttempts: 1, timeoutSeconds: 1800 },
    handoff: { maxAttempts: 1, timeoutSeconds: 300 },
    merge: { maxAttempts: 1, timeoutSeconds: 600 },
    "release-verification": { maxAttempts: 1, timeoutSeconds: 900 },
  },
  repairBudget: { maxBatches: 0, maxFollowUps: 0 },
});

const transport = shipyard.createGitHubCliTransport({ run: hostCommand });
const relationships = shipyard.createGitHubCliRelationshipReader({
  run: hostCommand,
});
const coordinatorRuntime = await shipyard.openPostgresCoordinator({
  databaseUrl: hostEnv.SHIPYARD_DATABASE_URL ?? "",
});
try {
  const trackingStore = new shipyard.InMemoryGitHubStore();
  const publication = new shipyard.GitHubPublication({
    coordinator: coordinatorRuntime.coordinator,
    transport,
    trackingStore,
  });

  const specGitAdapter: shipyard.GitHubSpecDeliveryGitAdapter = {
    reconcile: async (input) => {
      const pending = input.delivery.specCheckpoint?.children.find(
        (child) => child.status === "integrating",
      );
      if (pending?.sourceCommit === undefined) return {};
      const remote = await transport.findBranchByName({
        repository,
        branch: input.integrationBranch,
      });
      if (remote === undefined) return {};
      await hostCommand("git", ["fetch", "origin", input.integrationBranch]);
      const applied = await hostCommand("git", [
        "cherry",
        `origin/${input.integrationBranch}`,
        pending.sourceCommit.sha,
        `${pending.sourceCommit.sha}^`,
      ]);
      if (!applied.trimStart().startsWith("-")) return {};
      return {
        integratedChild: {
          child: pending.child,
          sourceCommit: pending.sourceCommit,
          head: { branch: input.integrationBranch, sha: remote.headSha },
        },
      };
    },
    integrateChild: async (input) => {
      const integrated = await shipyard.integrateTemplateDelivery({
        repositoryPath: cwd,
        branch: input.integrationBranch,
        baseBranch,
        commits: [input.sourceCommit.sha],
        run: hostCommand,
      });
      return { branch: input.integrationBranch, sha: integrated.headSha };
    },
  };
  const specHost = shipyard.createGitHubSpecDeliveryHost({
    coordinator: coordinatorRuntime.coordinator,
    transport,
    git: specGitAdapter,
  });
  const specPullRequestsFor = async (branch: string) =>
    JSON.parse(
      await hostCommand("gh", [
        "pr",
        "list",
        "--repo",
        repository,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,state,isDraft,headRefOid,baseRefName,headRefName,body,labels,url",
      ]),
    ) as Array<{
      number: number;
      state: string;
      isDraft: boolean;
      headRefOid: string;
      baseRefName: string;
      headRefName: string;
      body: string;
      labels: Array<{ name: string }>;
      url: string;
    }>;
  const runSpecChecks = async (input: {
    delivery: shipyard.DeliveryRecord;
    candidate: shipyard.SpecCandidate;
    lease: shipyard.DeliveryLease;
    signal: AbortSignal;
    key: string;
  }) => {
    const sandbox = await shipyard.createSandbox({
      branch: `shipyard/spec-check-${input.candidate.head.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      baseBranch: input.candidate.head.sha,
      sandbox: docker(),
      cwd,
      copyToWorktree,
      envAllowlist: [],
    });
    try {
      const evidence: shipyard.CheckEvidence[] = [];
      for (const check of configuredChecks) {
        const startedAt = new Date().toISOString();
        const result = await sandbox.exec(check.command, {
          signal: input.signal,
          maxOutputBytes: 4 * 1024 * 1024,
        });
        evidence.push({
          name: check.name,
          command: check.command,
          status: result.exitCode === 0 ? "passed" : "failed",
          summary:
            `${result.stdout}\n${result.stderr}`.trim().slice(-2000) ||
            (result.exitCode === 0 ? "Check passed." : "Check failed."),
          exitCode: result.exitCode,
          baseSha: input.candidate.base.sha,
          headSha: input.candidate.head.sha,
          briefHash: input.candidate.briefHash,
          startedAt,
          completedAt: new Date().toISOString(),
        });
      }
      for (const check of evidence) {
        await specHost.publishCheck({
          delivery: input.delivery,
          candidate: input.candidate,
          check,
          key: input.key,
          lease: input.lease,
          signal: input.signal,
        });
      }
      return evidence;
    } finally {
      await sandbox.close();
    }
  };
  const cleanupSpecCandidate = async (
    candidate: shipyard.SpecCandidate,
  ): Promise<shipyard.SpecCleanupResult> => {
    const sandbox = await shipyard.createSandbox({
      branch: `shipyard/spec-cleanup-${candidate.head.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
      baseBranch: candidate.head.sha,
      sandbox: docker(),
      cwd,
      copyToWorktree,
      envAllowlist: [],
    });
    try {
      const result = await sandbox.exec("git diff --check", {
        maxOutputBytes: 1024 * 1024,
      });
      return {
        status: result.exitCode === 0 ? "passed" : "failed",
        summary: result.stderr || result.stdout || "Integrated cleanup check.",
      };
    } finally {
      await sandbox.close();
    }
  };
  const deliverSpecGroup = async (
    initialRoute: shipyard.ActivatedDeliveryGroup,
  ) => {
    const route = await shipyard.readActivatedDeliveryGroup(
      repository,
      initialRoute.activatedIssue.number,
      relationships,
    );
    if (
      route.mode !== "planning-spec" ||
      route.root.number !== initialRoute.root.number
    ) {
      throw new Error("Activated issue no longer resolves to the same spec");
    }
    const rootIssue = route.root;
    const integrationBranch = `shipyard/spec-${rootIssue.number}`;
    const delivery = shipyard.resolveDeliveryGroup({
      issue: {
        repository,
        itemId: String(rootIssue.number),
        kind: "planning-spec",
      },
      children: route.children.map((child) => ({
        repository,
        itemId: child.id,
        kind: "executable-issue" as const,
      })),
      dependencies: route.children.map((child) => ({
        itemId: child.id,
        dependsOn: child.dependsOn,
      })),
    });
    const record =
      await coordinatorRuntime.coordinator.resolveDelivery(delivery);
    const base = await currentBase();
    const brief = shipyard.createWorkBrief({
      id: `${repository}:planning-spec:${rootIssue.number}`,
      revision: record.version,
      identity: {
        repository,
        itemId: String(rootIssue.number),
        kind: "planning-spec",
      },
      source: {
        provider: "github",
        repository,
        itemId: String(rootIssue.number),
        url: rootIssue.htmlUrl,
        originalBody: rootIssue.body || "(empty issue body)",
        author: rootIssue.authorLogin,
      },
      problem: `${rootIssue.title}\n\n${rootIssue.body || "(empty issue body)"}`,
      evidence: [
        `Planning spec #${rootIssue.number} is the delivery root.`,
        `The current open child graph contains ${route.children.length} issues.`,
      ],
      acceptanceCriteria: [
        `Complete all ${route.children.length} executable child issues in the current dependency graph.`,
        "Integrate and verify each child before closing it.",
      ],
      exclusions: ["Workers must not publish, merge, or close source issues."],
      risk: "medium",
      verification: {
        checks: configuredChecks
          .filter((check) => check.required)
          .map((check) => check.command),
        artifacts: ["child commits", "integrated checks", "review evidence"],
      },
      unresolvedQuestions: [],
      authorization: {
        status: "approved",
        actor: "shipyard activation policy",
        actorRole: "policy",
        approvedAt: "1970-01-01T00:00:00.000Z",
      },
      base,
      policyRevision: policy.revision,
      skillRevision: policy.worker.skillRevision,
      createdAt: rootIssue.updatedAt,
    });
    const childWorker: shipyard.SpecChildWorker = {
      implement: async (request) => {
        const childIssue = await transport.fetchIssue({
          repository,
          issueNumber: Number(request.child.itemId),
        });
        if (childIssue === undefined || childIssue.state !== "open") {
          throw new Error(`Spec child #${request.child.itemId} is not open`);
        }
        const branch = `shipyard/spec-${rootIssue.number}-child-${request.child.itemId}-${randomUUID().slice(0, 8)}`;
        const templatePrompt = await readFile(
          `${cwd}/.shipyard/implement-prompt.md`,
          "utf8",
        );
        const prompt = [
          templatePrompt
            .replaceAll("{{TASK_ID}}", request.child.itemId)
            .replaceAll("{{ISSUE_TITLE}}", childIssue.title),
          `Parent planning spec #${rootIssue.number}: ${rootIssue.title}\n\n${rootIssue.body || "(empty spec body)"}`,
          `Complete dependency graph:\n${route.children.map((child) => `- #${child.id}: ${child.title}; depends on ${child.dependsOn.map((id) => `#${id}`).join(", ") || "none"}`).join("\n")}`,
          `Assigned child issue #${request.child.itemId} body (untrusted):\n${childIssue.body || "(empty issue body)"}`,
        ].join("\n\n");
        const run = await shipyard.run({
          name: "spec-child",
          agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
          sandbox: docker(),
          cwd,
          hooks: sandboxHooks,
          copyToWorktree,
          prompt,
          output: shipyard.Output.object({
            tag: "phase-result",
            schema: phaseReportSchema,
          }),
          completionSignal: "<promise>COMPLETE</promise>",
          maxIterations: 1,
          signal: request.signal,
          envAllowlist: modelEnvAllowlist,
          branchStrategy: {
            type: "branch",
            branch,
            baseBranch: request.base.sha,
          },
        });
        const commit = run.commits.at(-1);
        if (run.completionSignal === undefined || commit === undefined) {
          throw new Error(
            `Spec child #${request.child.itemId} returned no commit`,
          );
        }
        if (run.commits.length !== 1) {
          throw new Error(
            `Spec child #${request.child.itemId} returned multiple commits`,
          );
        }
        return {
          commit: { branch, sha: commit.sha },
          evidence: run.output.evidence,
        };
      },
    };
    const verification: shipyard.SpecVerificationAdapter = {
      verifyChild: async (request) => ({
        checks: await runSpecChecks({
          ...request,
          key: `child-${request.child.itemId}-${request.sourceCommit.sha}`,
        }),
        cleanup: await cleanupSpecCandidate(request.candidate),
        evidence: [
          `Child #${request.child.itemId} integrated at ${request.candidate.head.sha}.`,
        ],
      }),
      verifyIntegrated: async (request) => ({
        checks: await runSpecChecks({ ...request, key: "integrated" }),
        cleanup: await cleanupSpecCandidate(request.candidate),
        evidence: [
          `Integrated candidate ${request.candidate.head.sha} was verified.`,
        ],
      }),
    };
    const review: shipyard.SpecReviewProvider = {
      review: async (request) => {
        const reviewed = await shipyard.run({
          name: "reviewer",
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          sandbox: docker(),
          cwd,
          hooks: sandboxHooks,
          copyToWorktree,
          prompt: [
            `Review planning spec #${rootIssue.number} in ${repository}.`,
            `Inspect exactly base ${request.checkout.base.sha} and head ${request.checkout.candidate.sha}.`,
            `Specification:\n${brief.problem}`,
            `Acceptance criteria:\n${brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
            `Required review axes: ${request.requiredAxes.join(", ")}.`,
            `Use git diff ${request.checkout.base.sha} ${request.checkout.candidate.sha}. Do not edit files, create commits, or run GitHub commands.`,
            "Return the review axes, findings, and evidence in <review-report> JSON.",
          ].join("\n\n"),
          output: shipyard.Output.object({
            tag: "review-report",
            schema: reviewSchema,
          }),
          completionSignal: "<promise>COMPLETE</promise>",
          maxIterations: 1,
          envAllowlist: modelEnvAllowlist,
          branchStrategy: {
            type: "branch",
            branch: `shipyard/spec-review-${rootIssue.number}-${request.checkout.candidate.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`,
            baseBranch: request.checkout.candidate.sha,
          },
        });
        if (
          reviewed.completionSignal === undefined ||
          reviewed.commits.length > 0 ||
          reviewed.preservedWorktreePath !== undefined
        ) {
          throw new Error("Spec review did not complete read-only");
        }
        return {
          ...reviewed.output,
          baseSha: request.checkout.base.sha,
          headSha: request.checkout.candidate.sha,
          briefHash: brief.hash,
        };
      },
    };
    const readCurrent = async (): Promise<shipyard.SpecCurrentCandidate> => {
      const currentRoot = await transport.fetchIssue({
        repository,
        issueNumber: rootIssue.number,
      });
      if (
        currentRoot === undefined ||
        currentRoot.state !== "open" ||
        `${currentRoot.title}\n\n${currentRoot.body || "(empty issue body)"}` !==
          brief.problem
      ) {
        throw new Error("Planning spec changed or closed during delivery");
      }
      const latestBase = await currentBase();
      const remoteBranch = await transport.findBranchByName({
        repository,
        branch: integrationBranch,
      });
      const pullRequests = await specPullRequestsFor(integrationBranch);
      if (remoteBranch === undefined || pullRequests.length !== 1) {
        throw new Error(
          "Planning spec has no exact open integration pull request",
        );
      }
      const pullRequest = pullRequests[0]!;
      const metadata = shipyard.parseGitHubPublicationMetadata(
        pullRequest.body,
      );
      const currentDelivery = await coordinatorRuntime.coordinator.getDelivery(
        delivery.key,
      );
      if (
        currentDelivery === undefined ||
        pullRequest.state !== "OPEN" ||
        pullRequest.headRefOid !== remoteBranch.headSha ||
        pullRequest.baseRefName !== baseBranch ||
        pullRequest.headRefName !== integrationBranch ||
        metadata?.repository !== repository ||
        metadata.itemId !== String(rootIssue.number) ||
        metadata.kind !== "planning-spec" ||
        metadata.deliveryVersion !== currentDelivery.version ||
        metadata.briefRevision !== brief.revision ||
        metadata.briefHash !== brief.hash ||
        metadata.baseBranch !== baseBranch ||
        metadata.baseSha !== latestBase.sha ||
        metadata.branch !== integrationBranch ||
        metadata.headSha !== remoteBranch.headSha
      ) {
        throw new Error(
          "Remote spec pull request does not match the current candidate",
        );
      }
      return {
        base: latestBase,
        head: { branch: integrationBranch, sha: remoteBranch.headSha },
        briefHash: brief.hash,
        pullRequest: {
          id: String(pullRequest.number),
          state: "open",
          draft: pullRequest.isDraft,
          baseBranch: pullRequest.baseRefName,
          headBranch: pullRequest.headRefName,
          baseSha: metadata.baseSha,
          headSha: metadata.headSha,
          briefHash: metadata.briefHash,
          deliveryId: currentDelivery.id,
          readyForHuman: pullRequest.labels.some(
            (label) =>
              label.name.toLowerCase() === shipyard.READY_FOR_HUMAN_LABEL,
          ),
        },
      };
    };
    const result = await shipyard.deliverSpec({
      coordinator: coordinatorRuntime.coordinator,
      delivery,
      brief,
      policy,
      workerId: `sequential-reviewer-spec-${randomUUID()}`,
      base,
      integrationBranch,
      childWorker,
      integration: specHost.integration,
      verification,
      childLifecycle: specHost.childLifecycle,
      review,
      readCurrent,
      maxConcurrency: 2,
      leaseTtlMs: 7_200_000,
    });
    if (result.outcome === "blocked" && result.lease !== undefined) {
      try {
        const current = await coordinatorRuntime.coordinator.getDelivery(
          result.delivery.key,
        );
        if (current !== undefined) {
          await specHost.publishBlocked({
            delivery: current,
            lease: result.lease,
            reason: result.reason ?? "Spec delivery blocked",
            ...(result.blockedChild === undefined
              ? {}
              : { blockedChild: result.blockedChild }),
            ...(result.candidate === undefined
              ? {}
              : { candidate: result.candidate }),
          });
        }
      } catch (error) {
        console.error(
          `Could not publish blocked state for spec #${rootIssue.number}: ${String(error)}`,
        );
      }
    }
    if (result.outcome === "ready-for-human") {
      console.log(
        `Planning spec #${rootIssue.number} ready for human handoff.`,
      );
    } else {
      console.error(
        `Planning spec #${rootIssue.number} blocked: ${result.reason ?? "delivery incomplete"}`,
      );
    }
    return result;
  };
  const listIssues = JSON.parse(
    await hostCommand("gh", [
      "issue",
      "list",
      "--repo",
      repository,
      "--state",
      "open",
      "--label",
      "shipyard",
      "--limit",
      "100",
      "--json",
      "number",
    ]),
  ) as Array<{ number: number }>;
  const deliverStandaloneIssue = async (
    issue: shipyard.ActivatedDeliveryGroup["root"],
  ) => {
    const base = await currentBase();
    const branch = `shipyard/issue-${issue.number}`;
    const identity: shipyard.WorkIdentity = {
      repository,
      itemId: String(issue.number),
      kind: "executable-issue",
    };
    const previous =
      await coordinatorRuntime.coordinator.getCurrentJob(identity);
    const problem = `${issue.title}\n\n${issue.body || "(empty issue body)"}`;
    const issueContentMatches = previous?.brief.problem === problem;
    const brief =
      issueContentMatches && previous.brief.base.sha === base.sha
        ? previous.brief
        : shipyard.createWorkBrief({
            id: `${repository}:executable-issue:${issue.number}`,
            revision: previous === undefined ? 1 : previous.brief.revision + 1,
            identity,
            source: {
              provider: "github",
              repository,
              itemId: String(issue.number),
              url: issue.htmlUrl,
              originalBody: issue.body || "(empty issue body)",
              author: issue.authorLogin,
            },
            problem,
            evidence: [
              "Issue is currently open and carries the shipyard activation label.",
            ],
            acceptanceCriteria: [
              `Implement the requested change in issue #${issue.number} and verify it with the configured checks.`,
            ],
            exclusions: [
              "Do not publish, merge, or close the source issue from the worker.",
            ],
            risk: "medium",
            verification: {
              checks: configuredChecks
                .filter((check) => check.required)
                .map((check) => check.command),
              artifacts: ["commit", "focused check output", "review evidence"],
            },
            unresolvedQuestions: [],
            authorization: {
              status: "approved",
              actor: "shipyard activation policy",
              actorRole: "policy",
              approvedAt: "1970-01-01T00:00:00.000Z",
            },
            base,
            policyRevision: policy.revision,
            skillRevision: policy.worker.skillRevision,
            createdAt: "1970-01-01T00:00:00.000Z",
          });
    const currentIssueMatches = async (): Promise<void> => {
      const current = await transport.fetchIssue({
        repository,
        issueNumber: issue.number,
      });
      if (
        current === undefined ||
        current.state !== "open" ||
        !current.labels.some((label) => label.toLowerCase() === "shipyard") ||
        `${current.title}\n\n${current.body || "(empty issue body)"}` !==
          brief.problem
      ) {
        throw new Error(
          "Selected issue changed or lost activation during delivery",
        );
      }
      const activation = await shipyard.readActivatedDeliveryRoot(
        repository,
        issue.number,
        relationships,
      );
      if (activation.mode !== "standalone") {
        throw new Error(
          "Selected issue is no longer a standalone delivery root",
        );
      }
    };
    const readCurrent = async (): Promise<shipyard.HandoffCandidate> => {
      await currentIssueMatches();
      const latestBase = await currentBase();
      const remoteBranch = await transport.findBranchByName({
        repository,
        branch,
      });
      const remotePullRequests = JSON.parse(
        await hostCommand("gh", [
          "pr",
          "list",
          "--repo",
          repository,
          "--head",
          branch,
          "--state",
          "all",
          "--json",
          "number,state,isDraft,headRefOid,baseRefName,headRefName",
        ]),
      ) as Array<{
        number: number;
        state: string;
        isDraft: boolean;
        headRefOid: string;
        baseRefName: string;
        headRefName: string;
      }>;
      if (remoteBranch === undefined) {
        if (remotePullRequests.length > 0) {
          throw new Error(
            "A pull request exists without its remote issue branch",
          );
        }
        return {
          base: latestBase,
          head: { branch, sha: latestBase.sha },
          briefHash: brief.hash,
        };
      }
      if (
        remotePullRequests.length !== 1 ||
        remotePullRequests[0]?.state !== "OPEN" ||
        remotePullRequests[0].headRefOid !== remoteBranch.headSha ||
        remotePullRequests[0].baseRefName !== baseBranch ||
        remotePullRequests[0].headRefName !== branch
      ) {
        throw new Error(
          "Remote issue branch has no matching open pull request",
        );
      }
      return {
        base: latestBase,
        head: { branch, sha: remoteBranch.headSha },
        briefHash: brief.hash,
      };
    };

    const workerPrompt = (
      await readFile(`${cwd}/.shipyard/implement-prompt.md`, "utf8")
    )
      .replaceAll("{{TASK_ID}}", String(issue.number))
      .replaceAll("{{ISSUE_TITLE}}", issue.title);
    const worker = shipyard.codex(shipyard.CODEX_MODELS.routine);
    const sandbox = docker();
    const artifactStore = shipyard.createInMemoryArtifactStore();
    const phaseAdapter = shipyard.createCredentialIsolatedRunPhaseEngineAdapter(
      {
        agent: worker,
        sandbox,
        workerEnvAllowlist: modelEnvAllowlist,
        run: async (options) => {
          const requestedBranch =
            options.branchStrategy?.type === "branch"
              ? options.branchStrategy.branch
              : undefined;
          if (requestedBranch !== branch) {
            throw new Error(
              "Implementation adapter received an unexpected branch",
            );
          }
          if (await transport.findBranchByName({ repository, branch })) {
            throw new Error(
              "A remote issue branch exists without coordinator candidate evidence",
            );
          }
          const existingPullRequests = JSON.parse(
            await hostCommand("gh", [
              "pr",
              "list",
              "--repo",
              repository,
              "--head",
              branch,
              "--state",
              "all",
              "--json",
              "number",
            ]),
          ) as unknown[];
          if (existingPullRequests.length > 0) {
            throw new Error(
              "A pull request already exists without coordinator candidate evidence",
            );
          }
          const localBranch = await hostCommand("git", [
            "branch",
            "--list",
            branch,
          ]);
          if (localBranch.length > 0) {
            const currentBranch = await hostCommand("git", [
              "branch",
              "--show-current",
            ]);
            if (currentBranch === branch) {
              throw new Error(
                "The unpublished issue branch is checked out in the host worktree; refusing to adopt it",
              );
            }
            const oldHead = await hostCommand("git", [
              "rev-parse",
              `refs/heads/${branch}`,
            ]);
            const orphanBranch = `shipyard/orphan-issue-${issue.number}-${oldHead.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
            await hostCommand("git", ["branch", "-m", branch, orphanBranch]);
            console.warn(
              `Preserved unpublished local branch as ${orphanBranch}`,
            );
          }
          return shipyard.run({
            ...options,
            sandbox,
            hooks: sandboxHooks,
            copyToWorktree,
            prompt: options.prompt,
            output: shipyard.Output.object({
              tag: "phase-result",
              schema: phaseReportSchema,
            }),
            completionSignal: "<promise>COMPLETE</promise>",
            maxIterations: 1,
            envAllowlist: modelEnvAllowlist,
          });
        },
      },
    );

    const reviewProvider: shipyard.ReviewProvider = {
      review: async (request) => {
        const reviewPrompt = (
          await readFile(`${cwd}/.shipyard/review-prompt.md`, "utf8")
        )
          .replaceAll("{{TASK_ID}}", String(issue.number))
          .replaceAll("{{ISSUE_TITLE}}", issue.title)
          .replaceAll("{{BRANCH}}", request.candidate.head.branch)
          .replaceAll("{{BASE_SHA}}", request.candidate.base.sha)
          .replaceAll("{{HEAD_SHA}}", request.candidate.head.sha);
        const review = await shipyard.run({
          name: "reviewer",
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          sandbox,
          cwd,
          hooks: sandboxHooks,
          copyToWorktree,
          prompt: [
            reviewPrompt,
            `Source request:\n${request.candidate.brief.problem}`,
            `Acceptance criteria:\n${request.candidate.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
            `Review exact base ${request.candidate.base.sha} and head ${request.candidate.head.sha}. Do not edit files, create commits, or run GitHub commands.`,
            "Return the required review axes, findings, and evidence inside <review-report> JSON matching the output schema.",
          ].join("\n\n"),
          output: shipyard.Output.object({
            tag: "review-report",
            schema: reviewSchema,
          }),
          completionSignal: "<promise>COMPLETE</promise>",
          maxIterations: 1,
          envAllowlist: modelEnvAllowlist,
          branchStrategy: {
            type: "branch",
            branch: `shipyard/review-issue-${issue.number}-${randomUUID().slice(0, 8)}`,
            baseBranch: request.candidate.head.sha,
          },
        });
        if (
          review.completionSignal === undefined ||
          review.commits.length > 0 ||
          review.preservedWorktreePath !== undefined
        ) {
          throw new Error("Independent review did not complete read-only");
        }
        return {
          ...review.output,
          baseSha: request.candidate.base.sha,
          headSha: request.candidate.head.sha,
          briefHash: request.candidate.brief.hash,
          commits: review.commits.map((commit) => commit.sha),
        };
      },
    };

    const runCandidateChecks = async (
      candidate: shipyard.HandoffCandidate,
    ): Promise<shipyard.CheckEvidence[]> => {
      const checkSandbox = await shipyard.createSandbox({
        branch: `shipyard/check-${issue.number}-${randomUUID().slice(0, 8)}`,
        baseBranch: candidate.head.sha,
        sandbox: docker(),
        cwd,
        copyToWorktree: ["node_modules"],
        envAllowlist: [],
      });
      try {
        const evidence: shipyard.CheckEvidence[] = [];
        for (const check of configuredChecks) {
          const startedAt = new Date().toISOString();
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort("check timed out"),
            900_000,
          );
          let result: Awaited<ReturnType<typeof checkSandbox.exec>>;
          try {
            result = await checkSandbox.exec(check.command, {
              signal: controller.signal,
              maxOutputBytes: 4 * 1024 * 1024,
            });
          } finally {
            clearTimeout(timer);
          }
          const completedAt = new Date().toISOString();
          evidence.push({
            name: check.name,
            command: check.command,
            status: result.exitCode === 0 ? "passed" : "failed",
            summary:
              `${result.stdout}\n${result.stderr}`.trim().slice(-2000) ||
              (result.exitCode === 0 ? "Check passed." : "Check failed."),
            exitCode: result.exitCode,
            baseSha: candidate.base.sha,
            headSha: candidate.head.sha,
            briefHash: candidate.briefHash,
            startedAt,
            completedAt,
          });
        }
        return evidence;
      } finally {
        await checkSandbox.close();
      }
    };
    const runCandidateCleanup = async (
      candidate: shipyard.HandoffCandidate,
    ): Promise<boolean> => {
      const cleanupSandbox = await shipyard.createSandbox({
        branch: `shipyard/cleanup-${issue.number}-${randomUUID().slice(0, 8)}`,
        baseBranch: candidate.head.sha,
        sandbox: docker(),
        cwd,
        copyToWorktree,
        envAllowlist: [],
      });
      try {
        const result = await cleanupSandbox.exec("git diff --check", {
          maxOutputBytes: 1024 * 1024,
        });
        return result.exitCode === 0;
      } finally {
        await cleanupSandbox.close();
      }
    };

    const result = await shipyard.deliverStandalone({
      coordinator: coordinatorRuntime.coordinator,
      publication,
      brief,
      policy,
      workerId: `sequential-reviewer-${randomUUID()}`,
      issueNumber: issue.number,
      branch,
      leaseTtlMs: 7_200_000,
      execution: {
        trusted: {
          brief,
          policy,
          skill: {
            revision: policy.worker.skillRevision,
            content: workerPrompt,
          },
        },
        untrusted: {
          sourceText: issue.body,
          repositoryContent: [],
        },
        controls: {
          toolAllowlist: [],
          credentialAllowlist: modelEnvAllowlist,
          timeoutSeconds: policy.phaseBudgets.implementation.timeoutSeconds,
          maxIterations: 1,
        },
        adapter: phaseAdapter,
        artifactStore,
        credentialResolver: {
          resolve: async (name) => hostEnv[name],
        },
        output: shipyard.Output.object({
          tag: "phase-result",
          schema: phaseReportSchema,
        }),
      },
      review: reviewProvider,
      readCurrent,
      verifyChecks: runCandidateChecks,
      cleanup: runCandidateCleanup,
    });
    if (result.outcome === "ready-for-human") {
      console.log(
        `Issue #${issue.number} ready for human handoff: ${result.pullRequest?.htmlUrl ?? "pull request created"}`,
      );
    } else {
      console.error(
        `Issue #${issue.number} blocked: ${result.reason ?? "delivery did not reach human handoff"}`,
      );
    }
    return result;
  };

  const seenDeliveryRoots = new Set<string>();
  let completedDeliveryAttempt = false;
  for (const listed of listIssues) {
    let route: shipyard.ActivatedDeliveryGroup;
    try {
      route = await shipyard.readActivatedDeliveryGroup(
        repository,
        listed.number,
        relationships,
      );
    } catch (error) {
      if (error instanceof shipyard.GitHubDeliveryRouteError) {
        continue;
      }
      throw error;
    }

    const rootKey = `${route.mode}:${route.root.number}`;
    if (seenDeliveryRoots.has(rootKey)) continue;
    seenDeliveryRoots.add(rootKey);

    if (route.mode === "planning-spec") {
      const result = await deliverSpecGroup(route);
      if (
        result.outcome === "blocked" &&
        result.reason?.startsWith("Spec delivery is already leased:")
      ) {
        continue;
      }
      completedDeliveryAttempt = true;
      break;
    }

    const result = await deliverStandaloneIssue(route.root);
    if (
      result.outcome === "blocked" &&
      (result.reason === "delivery-busy" ||
        result.reason?.startsWith(
          `Implementation branch is unavailable: Branch shipyard/issue-${route.root.number} is leased by worker `,
        ))
    ) {
      continue;
    }
    completedDeliveryAttempt = true;
    break;
  }

  if (!completedDeliveryAttempt) {
    if (seenDeliveryRoots.size > 0) {
      console.error("All eligible deliveries are already leased.");
    } else {
      console.log("No activated delivery is ready.");
    }
  }
} finally {
  await coordinatorRuntime.close();
}
