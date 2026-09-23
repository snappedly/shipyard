import {
  CODEX_MODELS,
  run,
  codex,
  publishTemplateDelivery,
} from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

// The host selects one issue, runs one worker, and publishes one draft PR.
// Generated entrypoint: .shipyard/main.mts
// Run this with: npx shipyard run
// Or add to package.json scripts: "shipyard": "shipyard run"

const exec = promisify(execFile);
const command = async (file: string, args: string[]) =>
  (await exec(file, args, { encoding: "utf8" })).stdout.trim();
const repository = JSON.parse(
  await command("gh", ["repo", "view", "--json", "nameWithOwner"]),
).nameWithOwner as string;
const baseBranch = process.env.SHIPYARD_BASE_BRANCH ?? "staging";
await command("git", ["fetch", "origin", baseBranch]);
const baseSha = await command("git", ["rev-parse", "FETCH_HEAD"]);
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
const issue = await (async () => {
  for (const candidate of issues) {
    const names = new Set(
      candidate.labels.map((label) => label.name.toLowerCase()),
    );
    if (
      names.has("planning-spec") ||
      names.has("planning") ||
      names.has("pr-repair") ||
      /^shipyard-parent:\s*#\d+/im.test(candidate.body)
    )
      continue;
    try {
      await command("gh", [
        "api",
        `repos/${repository}/issues/${candidate.number}/parent`,
        "--jq",
        ".number",
      ]);
      continue;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("404"))
        throw error;
    }
    return candidate;
  }
  return undefined;
})();
if (issue === undefined) {
  console.log("No standalone issue is ready.");
} else {
  const branch = `shipyard/issue-${issue.number}`;
  const result = await run({
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

    // One selected issue and one deterministic branch per delivery.
    maxIterations: 1,
    promptArgs: {
      TASK_ID: String(issue.number),
      ISSUE_TITLE: issue.title,
    },

    // Worker-only branch strategy. Publication and integration belong to the
    // coordinator-owned delivery adapter, never to the worker invocation.
    branchStrategy: {
      type: "branch",
      branch,
      baseBranch: baseSha,
    },

    // Copy node_modules from the host into the worktree before the sandbox
    // starts. This avoids a full npm install from scratch on every iteration.
    // The onSandboxReady hook installs dependencies and the full skill catalog.
    copyToWorktree: ["node_modules"],

    // Lifecycle hooks — commands grouped by where they run (host or sandbox).
    hooks: {
      sandbox: {
        // onSandboxReady runs once after the sandbox is initialised and the repo is
        // synced in, before the agent starts. Use it to install dependencies or run
        // any other setup steps your project needs.
        onSandboxReady: [
          {
            command:
              "npm install && npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y",
            timeoutMs: 300_000,
          },
        ],
      },
    },
  });
  const headSha = result.commits.at(-1)?.sha;
  if (headSha === undefined) {
    console.log(
      `Issue #${issue.number} produced no commit; no PR was published.`,
    );
  } else {
    const briefHash = createHash("sha256")
      .update(`${issue.title}\n${issue.body}`)
      .digest("hex");
    const published = await publishTemplateDelivery({
      repository,
      itemId: String(issue.number),
      kind: "executable-issue",
      branch,
      baseBranch,
      headSha,
      title: `[Shipyard] ${issue.title}`,
      body: `Source issue: #${issue.number}\n\nWorker commit: ${headSha}\n\nAutomated review and required checks must pass before this draft is ready for merge.`,
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
  }
}
