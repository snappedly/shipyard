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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Maximum number of implement→review cycles to run before stopping.
// Each cycle works on one issue. Raise this to process more issues per run.
const MAX_ITERATIONS = 10;

// Hooks run inside the sandbox before the agent starts each iteration.
// npm install ensures the sandbox always has fresh dependencies.
const hooks = {
  sandbox: { onSandboxReady: [{ command: "npm install" }] },
};

// Copy node_modules from the host into the worktree before each sandbox
// starts. Avoids a full npm install from scratch; the hook above handles
// platform-specific binaries and any packages added since the last copy.
const copyToWorktree = ["node_modules"];

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS} ===\n`);

  // Stable per-iteration branch names allow a retry to resume the same remote
  // delivery. A caller may provide a repository-specific deterministic name.
  const branch =
    process.env.SHIPYARD_WORKER_BRANCH ??
    `shipyard/sequential-reviewer/${iteration}`;

  // Create a single sandbox that both the implementer and reviewer share.
  // This gives both agents a real, named branch that persists across phases.
  const sandbox = await shipyard.createSandbox({
    branch,
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
    await sandbox.run({
      name: "reviewer",
      maxIterations: 1,
      agent: shipyard.codex(shipyard.CODEX_MODELS.strong),
      promptFile: "./.shipyard/review-prompt.md",
      promptArgs: {
        BRANCH: branch,
      },
    });

    console.log("\nReview complete.");
  } finally {
    await sandbox.close();
  }
}

console.log("\nAll done.");
