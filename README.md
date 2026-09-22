# Shipyard

<p align="center">
  <img src="assets/brand/shipyard-robot-on-boat.png" alt="A friendly robot steering a blue boat for Shipyard" width="320">
</p>

> **Fully autonomous coding workflows, protected by Docker.**

[![CI](https://github.com/snappedly/shipyard/actions/workflows/ci.yml/badge.svg)](https://github.com/snappedly/shipyard/actions/workflows/ci.yml)

Give Shipyard a backlog and a policy. It plans dependencies, runs AI coding
agents in isolated sandboxes, reviews their work, and returns reviewable
commits—without babysitting.

## The Shipyard advantage

Most agent setups launch a CLI and hope for the best. Shipyard is the control
plane around the agent:

- **Protected execution:** Run Codex or Claude Code in an isolated Docker-backed
  sandbox with explicit mounts, credentials, and network access.
- **Real orchestration:** Plan dependencies, parallelize safe work, leave
  blocked work alone, review each branch, and merge completed work.
- **Failure-aware by design:** Use finite budgets, no-progress detection,
  cancellation, logs, and recovery artifacts instead of runaway loops.
- **Reviewable output:** Runs preserve branches, worktrees, logs, and evidence;
  completed work comes back as commits. You keep control of the repository and
  the final release.

## Install and run

Requirements: Node.js 20.18.1+, Git, Docker, and credentials for your chosen
agent. Run these commands in the repository Shipyard should change:

```sh
npm install --save-dev @snappedly-tools/shipyard
npx shipyard init
```

`init` asks for the agent, authentication, sandbox, issue tracker, and workflow
template, then creates `.shipyard/`. For the first run, choose Docker and
`blank` or `sequential-reviewer`.

Add the requested credentials to `.shipyard/.env`, write a task in
`.shipyard/prompt.md` when using the `blank` template, then run:

```sh
npx shipyard run
```

The first run builds the Docker image automatically. Reuse it when the
Dockerfile has not changed:

```sh
npx shipyard run --skip-build
```

For Codex, `init` can sign in with a ChatGPT subscription or configure an OpenAI
API key. Claude Code supports a subscription token or an Anthropic API key. See
the [agent guide](docs/content/docs/agents.mdx) for authentication details.

## Pick the workflow you need

| Template                       | Best for              | Built-in flow                                     |
| ------------------------------ | --------------------- | ------------------------------------------------- |
| `blank`                        | One custom task       | One agent run                                     |
| `simple-loop`                  | A small issue backlog | Implement issues sequentially                     |
| `sequential-reviewer`          | Safer issue delivery  | Implement → review, one issue at a time           |
| `parallel-planner`             | Independent issues    | Plan dependencies → implement in parallel → merge |
| `parallel-planner-with-review` | Maximum autonomy      | Plan → implement and review in parallel → merge   |

All templates are generated TypeScript. Adjust prompts, models, iteration
limits, branch strategy, hooks, and checks in `.shipyard/main.ts` or
`.shipyard/main.mts`.

## Keep a repository running

On Apple Silicon macOS, the optional repository runner keeps a foreground
Shipyard controller ready for GitHub Issues. Label an issue `shipyard`; the
controller wakes, drains a finite batch of eligible work, coalesces duplicate
wake-ups, and stops when it makes no progress. Restarting it recovers work
labelled while the host was offline.

Accept runner installation during `init`, or install it later:

```sh
npx shipyard runner install
git add .github/workflows/shipyard-wake.yml .shipyard/.gitignore
git commit -m "Add Shipyard wake workflow"
git push
npx shipyard runner start
```

See the [repository runner guide](docs/content/docs/repository-runner.mdx) for
requirements, lifecycle commands, and the security model.

## Build your own coordinator

Shipyard is also a TypeScript library. Compose your own workflow with
`run()`, `createSandbox()`, and `createWorktree()` while reusing its agent,
sandbox, branch, prompt, logging, cancellation, and session primitives.

```ts
import { CODEX_MODELS, codex, run } from "@snappedly-tools/shipyard";
import { docker } from "@snappedly-tools/shipyard/sandboxes/docker";

await run({
  agent: codex(CODEX_MODELS.routine),
  sandbox: docker(),
  promptFile: ".shipyard/prompt.md",
});
```

Docker is the default path. Vercel Sandbox is available for isolated cloud
execution; `noSandbox()` is available only for trusted repositories and prompts.

## What gets created

```text
.shipyard/
├── main.ts or main.mts   # workflow configuration
├── prompt.md              # task or issue instructions
├── Dockerfile             # sandbox image definition
├── .env                   # untracked credentials
├── logs/                  # run logs
├── worktrees/             # isolated branch worktrees
└── patches/               # recovery artifacts
```

## Security and control

Docker keeps the agent's repository and Git storage inside the sandbox by
default. It is not a magic security boundary: mounts, credentials, devices,
network access, host hooks, and `noSandbox()` can expand what an agent can do.
Use least-privilege credentials and review generated configuration before
running untrusted code. Read the [security evaluation](docs/security-evaluation.md)
and [SECURITY.md](SECURITY.md).

Shipyard runs in your infrastructure. There is no required hosted control
plane; you control the host, Docker, model access, logs, and release policy.

## Learn more

- [Getting started](docs/content/docs/index.mdx)
- [Configuration](docs/content/docs/configuration.mdx)
- [Repository runner operations](docs/runbooks/repository-runner-macos-validation.md)
- [Contributing](CONTRIBUTING.md)

## License

Shipyard is source-available under the
[PolyForm Strict License 1.0.0](LICENSE). It is available for permitted
noncommercial use; the license does not permit redistribution, modification, or
derivative works. Contact Snappedly to request a commercial license.
