import { CODEX_MODELS, run, codex } from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

// Simple loop: an agent that picks open issues one by one and closes them.
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

  // Maximum number of iterations (agent invocations) to run in a session.
  // Each iteration works on a single issue. Increase this to process more issues
  // per run, or set it to 1 for a single-shot mode.
  maxIterations: 3,

  // Branch strategy — merge-to-head creates a temporary branch for the agent
  // to work on, then merges the result back to HEAD when the run completes.
  // This is required when using copyToWorktree, since head mode bind-mounts
  // the host directory directly (no worktree to copy into).
  branchStrategy: { type: "merge-to-head" },

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
