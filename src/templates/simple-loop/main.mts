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
  revision: "simple-loop-v1",
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
  let selectedIssue: shipyard.GitHubIssueSnapshot | undefined;
  for (const listed of listIssues) {
    try {
      const activation = await shipyard.readActivatedDeliveryRoot(
        repository,
        listed.number,
        relationships,
      );
      if (activation.mode !== "standalone") continue;
      const issue = await transport.fetchIssue({
        repository,
        issueNumber: listed.number,
      });
      if (
        issue?.state === "open" &&
        issue.labels.some((label) => label.toLowerCase() === "shipyard")
      ) {
        selectedIssue = issue;
        break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        /has a parent issue|is a repair issue|no longer activated/i.test(
          message,
        )
      )
        continue;
      throw error;
    }
  }

  if (selectedIssue === undefined) {
    console.log("No standalone issue is ready.");
  } else {
    const issue = selectedIssue;
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

    const workerPrompt = (await readFile(`${cwd}/.shipyard/prompt.md`, "utf8"))
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
        const review = await shipyard.run({
          name: "reviewer",
          agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
          sandbox,
          cwd,
          hooks: sandboxHooks,
          copyToWorktree,
          prompt: [
            `Review the implementation for issue #${issue.number} in ${repository}.`,
            `Inspect exactly base ${request.candidate.base.sha} and head ${request.candidate.head.sha}.`,
            `The source request is:\n${request.candidate.brief.problem}`,
            `Acceptance criteria:\n${request.candidate.brief.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}`,
            `Use git diff ${request.candidate.base.sha} ${request.candidate.head.sha}. Do not edit files, create commits, or run GitHub commands.`,
            "Return all required review axes and evidence in <review-report> JSON.",
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
      workerId: `simple-loop-${randomUUID()}`,
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
  }
} finally {
  await coordinatorRuntime.close();
}
