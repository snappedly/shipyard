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
plane around the agent and the reviewable pull request:

- **Protected execution:** Run Codex or Claude Code in an isolated Docker-backed
  sandbox with explicit mounts, credentials, and network access.
- **Real orchestration:** Plan delivery groups, parallelize safe work, leave
  blocked work alone, review the exact candidate, and hand off for a human
  merge.
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

| Template                       | Best for               | Built-in flow                                                 |
| ------------------------------ | ---------------------- | ------------------------------------------------------------- |
| `blank`                        | One custom task        | One agent run                                                 |
| `simple-loop`                  | A small issue backlog  | Standalone or promoted spec delivery → reviewed handoff       |
| `sequential-reviewer`          | Safer issue delivery   | Standalone or promoted spec delivery → reviewed handoff       |
| `parallel-planner`             | Mixed issue backlogs   | Standalone and spec groups → canonical delivery → handoff     |
| `parallel-planner-with-review` | Mixed backlog + repair | Canonical delivery → checks/review → bounded repair → handoff |

All templates are generated TypeScript. Adjust prompts, models, iteration
limits, branch strategy, hooks, and checks in `.shipyard/main.ts` or
`.shipyard/main.mts`.

The bundled GitHub workflows select or plan issues on the host and publish one
draft PR per delivery. `parallel-planner` sends standalone groups through
`deliverStandalone` and planning-spec groups through durable `deliverSpec`;
unrelated groups run concurrently while the spec coordinator schedules
dependency-safe workers and integrates their commits serially.
`parallel-planner-with-review` uses the same coordinator-owned paths. Reviewers
inspect the exact candidate; one consolidated repair and one targeted re-review
are allowed before human handoff. The host owns GitHub effects, checks, closure,
review, and handoff. `simple-loop` and `sequential-reviewer` verify the published
candidate, checks, review, and cleanup before marking the PR ready and closing a
standalone source issue with commit and PR evidence. When either template sees
an activated executable child of an open planning spec, it resolves the
complete native or documented fallback graph and routes the parent through the
same durable spec delivery. Sibling activations share the parent delivery
identity and integration branch; the parent never runs as an executable issue.
Spec child issues close after their integration and verification, while the
parent remains open until merge.
The host `gh` login needs Contents, Pull requests, Checks, and Issues write
access. Set
`SHIPYARD_BASE_BRANCH` if the integration branch is not `staging`. Required
checks and review findings must be resolved before a draft PR is marked ready
for merge.

The Docker sandbox startup hook runs
`npx --yes skills add snappedly/skills --skill '*' -a codex -a claude-code -g -y`
before each agent starts. Issue templates install project dependencies first.
This installs the full Snappedly catalog for Codex and Claude Code. Agents read
the skills and linked guidance from `~/.agents/skills`, and use other skills when
relevant to the issue. Standalone workers start with `/implement` and use
`/tdd`, `/code-cleanup`, and `/code-review` where relevant. Planners use
`/implement-spec` for a planning spec; the host fetches all open native
sub-issues or documented fallback children and their dependencies, even when
only the spec parent has the `shipyard` label. Reviewers use `/code-review`.
Sandbox startup fails if installation fails. Restart the repository runner
after updating generated `.shipyard/` files.

The coordinator owns delivery identity, branches, pull requests, checks,
review, repairs, and evidence. Workers return commits and cannot publish,
merge, or close source issues. A planning spec uses one integration branch and
one pull request for its scoped children. GitHub is the source of truth; a
local-only orphan branch is ignored after interruption. If a delivery is
blocked after bounded recovery, re-add the lowercase `shipyard` label to
explicitly retry the existing delivery.

On retry, the coordinator reconciles the existing pull request and remote head
with saved child evidence before scheduling work. Completed children stay
closed and are not run again. Pre-merge scope additions join the same delivery
and invalidate its candidate checks and review; additions after merge need a
follow-up delivery. Scope expansion reports when the pull request must return
to draft; satisfy that transition before resuming delivery.

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
Shipyard never merges a pull request: maintainers merge the exact reviewed
candidate, and planning-spec parents close only after the merged candidate and
all scoped child/repair checks reconcile.

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
