import { CODEX_MODELS, run, codex } from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

// Blank template: customize this to build your own orchestration.
// Generated entrypoint: .shipyard/main.mts
// Run this with: npx shipyard run
// Or add to package.json scripts: "shipyard": "shipyard run"

await run({
  agent: codex(CODEX_MODELS.routine),
  sandbox: docker(),
  hooks: {
    sandbox: {
      onSandboxReady: [
        {
          command:
            "npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
          timeoutMs: 300_000,
        },
      ],
    },
  },
  promptFile: "./.shipyard/prompt.md",
});
