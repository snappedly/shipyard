import { CODEX_MODELS, run, codex } from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

// Simple loop: a worker that receives one coordinator-selected issue.
//
// The canonical standalone coordinator owns runAuthorizedImplementation,
// GitHubPublication, independent review, handoff, and source-issue effects.
// This low-level worker remains configurable for repositories that provide
// their own coordinator adapter.
// Generated entrypoint: .shipyard/main.mts
// Run this with: npx shipyard run
// Or add to package.json scripts: "shipyard": "shipyard run"

await run({
  // A name for this run, shown as a prefix in log output.
  name: "worker",

  // Sandbox provider — runs the agent inside an isolated container.
  sandbox: docker(),

  // The agent provider. The routine configured Codex model runs at max
  // reasoning by default. Switch to CODEX_MODELS.strong for more demanding
  // planning or review work.
  agent: codex(CODEX_MODELS.routine),

  // Path to the prompt file. Shell expressions inside are evaluated inside the
  // sandbox at the start of each iteration, so the agent always sees fresh data.
  promptFile: "./.shipyard/prompt.md",

  // The coordinator assigns one issue per worker invocation. Replays use the
  // same configured branch and remote delivery metadata rather than merging a
  // local branch into the host checkout.
  maxIterations: 1,

  // Worker-only branch strategy. Publication and integration belong to the
  // coordinator-owned delivery adapter, never to the worker invocation.
  branchStrategy: {
    type: "branch",
    branch: process.env.SHIPYARD_WORKER_BRANCH ?? "shipyard/standalone-worker",
  },

  // Copy node_modules from the host into the worktree before the sandbox
  // starts. This avoids a full npm install from scratch on every iteration.
  // The onSandboxReady hook still runs npm install as a safety net to handle
  // platform-specific binaries and any packages added since the last copy.
  copyToWorktree: ["node_modules"],

  // Lifecycle hooks — commands grouped by where they run (host or sandbox).
  hooks: {
    sandbox: {
      // onSandboxReady runs once after the sandbox is initialised and the repo is
      // synced in, before the agent starts. Use it to install dependencies or run
      // any other setup steps your project needs.
      onSandboxReady: [{ command: "npm install" }],
    },
  },
});
