# Shipyard

<p align="center">
  <img src="assets/brand/shipyard-robot-on-boat.png" alt="A friendly robot steering a blue boat for Shipyard" width="320">
</p>

> **Source-available toolkit for running AI coding agents in isolated sandboxes.**

[![CI](https://github.com/snappedly/shipyard/actions/workflows/ci.yml/badge.svg)](https://github.com/snappedly/shipyard/actions/workflows/ci.yml)

Shipyard runs AI coding agents in isolated sandboxes. Choose an agent, a
sandbox provider, and a prompt; Shipyard manages the sandbox lifecycle,
branches, logs, sessions, and commits.

## Why Shipyard

- **Isolated by default.** Keep agent work inside Docker locally or Vercel
  Sandbox remotely.
- **Purpose-built agents.** Use Codex or Claude Code without carrying support
  for unrelated coding-agent CLIs.
- **Reviewable changes.** Control how branches and worktrees move changes back
  to the host repository.

## Quick start

You need Node.js 20.18.1 or newer, Git, Docker, and credentials for your chosen
coding agent.
Run these commands inside the Git repository the agent should change:

```sh
npm install --save-dev @snappedly-tools/shipyard
npx shipyard init
cp .shipyard/.env.example .shipyard/.env
```

`init` asks which agent, sandbox provider, issue tracker, and starter template
to use. When you select Codex, it also asks whether to sign in with ChatGPT or
use an API key. Start with the `blank` template. Put any requested credentials
in `.shipyard/.env`, then write one concrete task in `.shipyard/prompt.md`.

Run it:

```sh
npx shipyard run
```

`shipyard run` builds the generated Docker image, executes the
generated TypeScript entry point, and cleans up the sandbox. Reuse the cached
image when its definition has not changed:

```sh
npx shipyard run --skip-build
```

Inspect the generated branch strategy and start from a clean working tree. A
completion marker means the agent stopped; inspect its commits and run the
repository's checks before keeping the result.

## JavaScript API

The generated `.shipyard/main.ts` or `.shipyard/main.mts` is ordinary
TypeScript:

```ts
import { CODEX_MODELS, codex, run } from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

const result = await run({
  agent: codex(CODEX_MODELS.routine),
  sandbox: docker(),
  promptFile: ".shipyard/prompt.md",
});

console.log(result.commits);
```

Use a dedicated branch when the scaffold has already been committed:

```ts
const result = await run({
  agent: codex(CODEX_MODELS.routine),
  sandbox: docker(),
  promptFile: ".shipyard/prompt.md",
  branchStrategy: { type: "branch", branch: "agent/my-task" },
  maxIterations: 1,
  logging: { type: "stdout" },
});
```

Shipyard supports Codex and Claude Code agents, with Docker, Vercel Sandbox,
and no-sandbox providers. `shipyard init` scaffolds Docker; configure Vercel
Sandbox or no-sandbox mode through the JavaScript interface.

To run directly on the host without isolation:

```ts
import { CODEX_MODELS, codex, run } from "@snappedly-tools/shipyard";
import { noSandbox } from "@snappedly-tools/shipyard/sandboxes/no-sandbox";

const result = await run({
  agent: codex(CODEX_MODELS.routine),
  sandbox: noSandbox(),
  promptFile: ".shipyard/prompt.md",
});
```

No-sandbox mode grants the agent the permissions of the Shipyard process. Use
it only with trusted repositories and prompts.

## Branch behavior

Docker keeps the repository and Git metadata inside the sandbox. It starts
from committed history and syncs changes back. The generated blank
template omits `branchStrategy`, which defaults to `merge-to-head`: commits
are transferred to a temporary host branch and merged into your current
branch. Direct `head` mode is not supported by Docker or Vercel Sandbox.

The explicit `branch` strategy keeps commits on the named branch for review.
Commit input files before either strategy, or use `copyToWorktree` for specific
untracked or ignored files.

## Authentication

`shipyard init` generates the environment variables and mounts required by
the chosen agent. Keep `.shipyard/.env`, agent login files, logs, and recovery
patches private.

For Codex, choose either:

- ChatGPT authentication: choose **Sign in with ChatGPT** during interactive
  init and complete the browser login. The generated configuration mounts
  `~/.codex/auth.json` read-only.
- API authentication: choose **OpenAI API key** and put `OPENAI_API_KEY` in
  `.shipyard/.env`.

For non-interactive init, pass `--codex-auth chatgpt` or
`--codex-auth api-key` explicitly.

For Claude Code, run `claude setup-token` and put the resulting value in the
generated `CLAUDE_CODE_OAUTH_TOKEN` entry.

## Generated files

| Path                              | Purpose                                                      |
| --------------------------------- | ------------------------------------------------------------ |
| `.shipyard/main.ts` or `main.mts` | Agent, sandbox, prompt, branch, hook, and iteration settings |
| `.shipyard/prompt.md`             | Task given to the agent                                      |
| `.shipyard/Dockerfile`            | Sandbox image definition                                     |
| `.shipyard/.env`                  | Untracked credentials passed into the sandbox                |
| `.shipyard/logs/`                 | Run logs                                                     |
| `.shipyard/worktrees/`            | Worktrees for separate-branch runs                           |
| `.shipyard/patches/`              | Recovery artifacts preserved after some failures             |

## Workflow templates

The bundled templates are:

- `blank`: one agent and your prompt;
- `simple-loop`: process issue-tracker tasks sequentially;
- `sequential-reviewer`: implement and review each task;
- `parallel-planner`: plan parallel work and merge its branches; and
- `parallel-planner-with-review`: add review to each parallel branch.

Read generated prompts before running an issue or merge workflow. Those
templates can close issues, create branches, and merge work.

The package also exports contracts for triage, implementation, review,
repair, handoff, and release recording. They are building blocks for hosted
automation, not a hosted service started by the quick-start commands.

## Security

Agents receive the permissions granted by their sandbox, mounts, credentials,
and hooks. Docker isolates repository and Git storage; it does not
mount the host checkout or Git metadata automatically. Explicit mounts must
stay outside the sandbox workspace and its ancestors.

Mounted credentials, devices, Docker sockets, groups, and network access can
still broaden an agent's access. Host hooks, no-sandbox mode, and custom
provider code retain their own trust requirements. Use
least-privilege credentials and review generated configuration before running
untrusted code.

See the [security evaluation](docs/security-evaluation.md) for findings,
fixes, and validation limits. Report vulnerabilities according to
[SECURITY.md](SECURITY.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The standard repository check is:

```sh
npm ci
npm run check
```

## License

Shipyard is source-available under the
[PolyForm Strict License 1.0.0](LICENSE). It is available for permitted
noncommercial use; the license does not permit redistribution, modification,
or derivative works. Contact Snappedly to request a commercial license.
