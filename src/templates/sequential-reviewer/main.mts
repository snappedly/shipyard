// Sequential Reviewer — coordinator-owned implement-then-review worker
//
// This template drives a two-phase workflow per issue:
//   Phase 1 (Implement): A Codex worker implements one coordinator-selected issue
//                        and returns a commit plus evidence.
//   Phase 2 (Review):    A second Codex worker reviews the exact candidate
//                        read-only and returns findings.
//
// The branch remains an implementation detail. The coordinator owns
// runAuthorizedImplementation, GitHubPublication, repair, handoff, and source
// issue effects; this template never merges or closes a source issue.
//
// The outer loop repeats up to MAX_ITERATIONS times, processing one issue per
// iteration and stopping early once the backlog is exhausted. This is a
// middle-complexity option between
// the simple-loop (no review gate) and the parallel-planner (concurrent
// execution with a planning phase).
// Generated entrypoint: .shipyard/main.mts
//
// Usage:
//   npx shipyard run
// Or add to package.json:
//   "scripts": { "shipyard": "shipyard run" }

import * as shipyard from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
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

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];
const exec = promisify(execFile);
const command = async (file: string, args: string[]) =>
  (await exec(file, args, { encoding: "utf8" })).stdout.trim();
const repository = JSON.parse(
  await command("gh", ["repo", "view", "--json", "nameWithOwner"]),
).nameWithOwner as string;
const baseBranch = process.env.SHIPYARD_BASE_BRANCH ?? "staging";
await command("git", ["fetch", "origin", baseBranch]);
const baseSha = await command("git", ["rev-parse", "FETCH_HEAD"]);

const nextIssue = async () => {
  const issues = JSON.parse(
    await command("gh", [
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
      "number,title,body,labels",
    ]),
  ) as Array<{
    number: number;
    title: string;
    body: string;
    labels: Array<{ name: string }>;
  }>;
  for (const issue of issues) {
    const names = new Set(
      issue.labels.map((label) => label.name.toLowerCase()),
    );
    if (
      names.has("planning-spec") ||
      names.has("planning") ||
      names.has("pr-repair") ||
      /^shipyard-parent:\s*#\d+/im.test(issue.body)
    )
      continue;
    try {
      await command("gh", [
        "api",
        `repos/${repository}/issues/${issue.number}/parent`,
        "--jq",
        ".number",
      ]);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("404"))
        throw error;
    }
    return issue;
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);
  const issue = await nextIssue();
  if (issue === undefined) break;

  // Stable per-iteration branch names allow a retry to resume the same remote
  // delivery. A caller may provide a repository-specific deterministic name.
  const branch = `shipyard/issue-${issue.number}`;

  // Create a single sandbox that both the implementer and reviewer share.
  // This gives both agents a real, named branch that persists across phases.
  const sandbox = await shipyard.createSandbox({
    branch,
    baseBranch: baseSha,
    sandbox: docker(),
    hooks,
    copyToWorktree,
  });

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Implement one selected issue. The worker is not allowed to
    // publish, merge, or close anything; the host coordinator does that after
    // candidate verification.
    //
    // A Codex agent picks the next open issue, writes the
    // implementation (using RGR: Red → Green → Repeat → Refactor), and
    // commits the result.
    //
    // The agent signals completion via <promise>COMPLETE</promise> when done.
    // -----------------------------------------------------------------------
    // One iteration so each outer pass implements a single issue on its own
    // branch, then hands it to the reviewer. A higher value lets the agent
    // drain the whole backlog onto this one branch in a single pass, which
    // defeats the per-issue review.
    const implement = await sandbox.run({
      name: "implementer",
      maxIterations: 1,
      agent: shipyard.codex(shipyard.CODEX_MODELS.routine),
      promptFile: "./.shipyard/implement-prompt.md",
      promptArgs: {
        TASK_ID: String(issue.number),
        ISSUE_TITLE: issue.title,
      },
    });

    if (!implement.commits.length) {
      // No commits means the backlog is empty or every remaining issue is
      // blocked — there is nothing left to implement or review, so stop.
      console.log("Implementation agent made no commits. Stopping.");
      break;
    }

    console.log(`\nImplementation complete on branch: ${branch}`);
    console.log(`Commits: ${implement.commits.length}`);

    // -----------------------------------------------------------------------
    // Phase 2: Review. The prompt is deliberately read-only; any repair is a
    // separate bounded coordinator action against the published candidate.
    //
    // A second Codex agent reviews the diff of the branch produced by
    // Phase 1. It uses the {{BRANCH}} prompt argument to inspect the right
    // branch, and either approves or makes corrections directly on the branch.
    // -----------------------------------------------------------------------
    const review = await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
      promptFile: "./.shipyard/review-prompt.md",
      promptArgs: {
        BRANCH: branch,
        BASE_SHA: baseSha,
        HEAD_SHA: implement.commits.at(-1)!.sha,
      },
    });

    if (review.commits.length > 0) {
      throw new Error(
        `Reviewer changed issue #${issue.number}; candidate was not published`,
      );
    }

    const headSha = implement.commits.at(-1)!.sha;
    const briefHash = createHash("sha256")
      .update(`${issue.title}\n${issue.body}`)
      .digest("hex");
    const published = await shipyard.publishTemplateDelivery({
      repository,
      itemId: String(issue.number),
      kind: "executable-issue",
      branch,
      baseBranch,
      headSha,
      title: `[Shipyard] ${issue.title}`,
      body: `Source issue: #${issue.number}\n\nWorker commit: ${headSha}\n\nRead-only review ran; any findings and required checks must be resolved before this draft is ready for merge.`,
      metadata: {
        version: 1,
        repository,
        itemId: String(issue.number),
        kind: "executable-issue",
        briefRevision: 1,
        briefHash,
        baseBranch,
        baseSha,
        branch,
      },
    });

    console.log(`Draft PR ready for human handoff: ${published.url}`);
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
