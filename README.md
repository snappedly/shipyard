# Shipyard

<p align="center">
  <img src="assets/brand/shipyard-robot-on-boat.png" alt="A friendly robot steering a blue boat for Shipyard" width="320">
</p>

> **Fully autonomous coding workflows, protected by Docker.**

[![CI](https://github.com/snappedly/shipyard/actions/workflows/ci.yml/badge.svg)](https://github.com/snappedly/shipyard/actions/workflows/ci.yml)

Give Shipyard a task or a GitHub issue. It runs Codex or Claude Code in an
isolated sandbox, can plan and review larger jobs, and brings the result back as
a commit or pull request you can inspect.

## The Shipyard advantage

- **Isolated work.** Docker keeps the agent's files and Git work inside a
  sandbox while it runs.
- **Built for real projects.** Shipyard can sort issue dependencies, work on
  independent tasks in parallel, and review the combined result.
- **You stay in control.** Runs have limits and logs. Issue workflows return a
  pull request for you to review and merge.

## Try it on one task

You need **Node.js 20.18.1+**, **Git**, **Docker running**, and **Codex or Claude Code**
with a subscription login or API key.

Run:

```sh
npx skills add snappedly/skills
```

Ask your coding agent to run `setup-snappedly-skills` in that repository.

```sh
npm install --save-dev @snappedly-tools/shipyard
npx shipyard init
```

During `shipyard init`, choose your agent, **Docker**, the template you want, and install the optional
[repository runner](docs/content/docs/repository-runner.mdx). Follow
the authentication prompts.

On a local Mac, the repository runner automatically wakes Shipyard when you label an issue.
It runs as long as its terminal stays open.

See the [getting started guide](docs/content/docs/index.mdx) for authentication and
branch options.

Fill in any credentials required in `.shipyard/.env`.
`GH_TOKEN` in `.shipyard/.env` to a GH token with Contents, Issues, and Pull
Requests read/write access and Metadata read access.

Commit the setup and prompt so the sandbox can read them. Make sure the Git ignore file keeps
`.shipyard/.env` out of the commit.

```sh
npx shipyard run
```

Or for the automated runner:

```sh
npx shipyard runner start
```

## Turn GitHub issues into pull requests

Then:

1. Write an issue with a clear goal and add the `shipyard` and
   `ready-for-agent` labels.
2. Make sure the runner is running, or start `npx shipyard run`. Shipyard checks the issue, implements it in Docker,
   reviews the work, and opens a pull request.
3. Inspect the pull request and merge it when you are happy with the result.

## Choose a workflow

| Template                       | What it does                                       |
| ------------------------------ | -------------------------------------------------- |
| `simple-loop`                  | Works through labeled issues one at a time.        |
| `sequential-reviewer`          | Implements and reviews issues before PR handoff.   |
| `parallel-planner`             | Plans and works on independent issues in parallel. |
| `parallel-planner-with-review` | Adds review to the parallel workflow.              |

Shipyard also exports TypeScript APIs for custom workflows. Configure prompts,
branches, limits, and hooks in the generated `.shipyard/main.ts` or
`.shipyard/main.mts`. See [configuration](docs/content/docs/configuration.mdx)
and [agent setup](docs/content/docs/agents.mdx).

Generated workflows use separate routine and strong model roles. Set them during
initialization with `--routine-model` and `--strong-model`, or edit the
`modelRoles` object in `.shipyard/main.ts` or `.shipyard/main.mts`. `--model`
sets both roles to one model unless a role-specific option overrides it. Shipyard
records reported token use by issue and phase in
`.shipyard/logs/model-usage.jsonl`. Built-in subagents are disabled in generated
workflows so the selected role controls each model call.

## Safety and license

Shipyard runs on your machine or infrastructure. Sandbox access depends on the
mounts, credentials, and network settings you choose. Read the
[security guide](docs/security-evaluation.md) before using untrusted code.

Shipyard is source-available under the [PolyForm Strict License 1.0.0](LICENSE)
for permitted noncommercial use. Contact Snappedly for a commercial license.
