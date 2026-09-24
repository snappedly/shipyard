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

Before running Shipyard, install the [Snappedly skills](https://github.com/snappedly/skills)
and run `setup-snapedly-skills` in the target repository.

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

| Template                       | Best for              | Built-in flow                                 |
| ------------------------------ | --------------------- | --------------------------------------------- |
| `blank`                        | One custom task       | One agent run                                 |
| `simple-loop`                  | A small issue backlog | Implement issues sequentially → review PRs    |
| `sequential-reviewer`          | Safer issue delivery  | Implement → review → review PR                |
| `parallel-planner`             | Independent issues    | Plan → implement in parallel → review PRs     |
| `parallel-planner-with-review` | Maximum autonomy      | Plan → implement and review in parallel → PRs |

All templates are generated TypeScript. Adjust prompts, models, iteration
limits, branch strategy, hooks, and checks in `.shipyard/main.ts` or
`.shipyard/main.mts`.

## Keep a repository running

On Apple Silicon macOS, the optional repository runner keeps a foreground
Shipyard controller ready for GitHub Issues. Label an issue `shipyard`; the
controller wakes, drains a finite batch of eligible work, coalesces duplicate
wake-ups, and stops when it makes no progress. Restarting it recovers work
labelled while the host was offline.
GitHub-backed `shipyard init` provisions `shipyard`, `shipyard:blocked`,
`shipyard:pending`, `shipyard:complete`, and `shipyard:outstanding-tasks` in the repository.
For a connected repository, init reports an error if any label cannot be created.

The bundled issue workflows install Snappedly skills and the candidate's
dependencies in Docker. A standalone issue runs through `/implement`. Activating
a planning spec or a linked executable child resolves the parent and only
linked tickets labelled `shipyard` into one `/implement-spec` scope. The sequential
templates deliver selected tickets on one branch; the parallel templates assign
ready tickets to `/implement` workers, integrate dependency waves, resolve ticket
merge conflicts on the spec branch, and review the integrated change. One
non-draft PR per spec awaits human merge. Later selected tickets update that PR.
Shipyard also recognizes a ticket added to an open verified spec PR's `Source
issues:` line as belonging to that spec, even without a GitHub sub-issue or
`## Parent` link. Conflicting links block the selected ticket for correction.
Selected tickets receive `shipyard:pending` while Shipyard works on them.
Successful handoff replaces it with `shipyard:complete` and removes `shipyard`.
The parent spec and PR show `shipyard:blocked` if an unfinished child is blocked,
`shipyard:outstanding-tasks` if children remain, or `shipyard:complete` when all
linked tickets are complete. Spec labels report child state; they never prevent
a reactivated child from running. The issues remain open under the target
repository's closure policy.
With no labelled tickets yet, Shipyard marks the parent outstanding and waits
to create the PR until a ticket is selected.
If an attempted issue cannot be completed, Shipyard comments with the reason,
marks the attempted tickets `shipyard:blocked`, clears `shipyard:pending`, and
removes `shipyard` from the scope. The parent spec and any existing PR show
`shipyard:blocked` while an unfinished child remains blocked. It does not
publish a new PR for failed work. Resolve the problem, remove
`shipyard:blocked` from a ticket, then add `shipyard` to retry that ticket;
the parent spec's status label needs no manual change. Missing or ambiguous
relationships block the affected selected issue and record the reason. If GitHub cannot confirm whether a
PR became ready, Shipyard leaves the issue active for reconciliation. The GitHub token
needs Contents, Issues, and Pull requests read/write permission plus Metadata
read permission. Keep the Mac and foreground controller running for wake-ups.
If GitHub rejects a failure comment, Shipyard keeps a local pending report for
replay. A fresh `shipyard` activation on an unblocked ticket supersedes that
report. Spec and PR status label failures are logged without stopping ticket
work; retained activation lets the next invocation recalculate their labels.

Accept runner installation during `init`, or install it later:

```sh
npx shipyard runner install
git add .shipyard .github/workflows/shipyard-wake.yml
git commit -m "Add Shipyard wake workflow"
git push
npx shipyard runner start
```

Run `npx shipyard runner purge` to remove every dated run-log folder and
root-level `.log` file under `.shipyard/logs/`. Shipyard automatically removes
entries older than eight days before `shipyard run`, at runner startup, and
daily while the runner stays active. Use a path outside `.shipyard/logs/` for
logs that must be retained separately.

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
