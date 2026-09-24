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

You need **Node.js 20.18.1+**, **Git**, **Docker running**, and **Codex or Claude
Code** with a login or API key. Start with a clean Git repository you want
Shipyard to change. If it is on GitHub, sign in with the
[GitHub CLI](https://cli.github.com/) (`gh auth login`) before `init`; Shipyard
creates its issue labels there.

Run:

```sh
git switch -c try-shipyard
npx skills add snappedly/skills
npm install --save-dev @snappedly-tools/shipyard
npx shipyard init
```

Ask your coding agent to run `setup-snappedly-skills` in that repository. During
`shipyard init`, choose your agent, **Docker**, and the **blank** template. Follow
the authentication prompts. You can skip the optional repository runner for
this first task.

Open `.shipyard/prompt.md` and describe a small change. For example:

```md
# Task

Document how to run this project locally using commands already in the repo.
Run the relevant checks and commit the change.

# Done

Output <promise>COMPLETE</promise> when finished.
```

Fill in any credentials requested in `.shipyard/.env`. Commit the setup and
prompt so the sandbox can read them. The generated Git ignore file keeps
`.shipyard/.env` out of the commit.

```sh
git add .
git commit -m "Set up Shipyard"
npx shipyard run
git show --stat HEAD
```

Shipyard builds the Docker image, runs the agent, and returns its commit to your
current branch. `git show` lets you inspect what changed. See the
[getting started guide](docs/content/docs/index.mdx) for authentication and
branch options.

## Turn GitHub issues into pull requests

For a repository you want to automate from GitHub Issues, choose
**sequential-reviewer** instead of **blank** during `shipyard init`. Set
`GH_TOKEN` in `.shipyard/.env` to a token with Contents, Issues, and Pull
requests read/write access and Metadata read access. Then:

1. Write an issue with a clear goal and add the `shipyard` and
   `ready-for-agent` labels.
2. Run `npx shipyard run`. Shipyard checks the issue, implements it in Docker,
   reviews the work, and opens a pull request.
3. Inspect the pull request and merge it when you are happy with the result.

On an Apple Silicon Mac, the optional [repository runner](docs/content/docs/repository-runner.mdx)
can wake Shipyard when you label an issue. It runs while its terminal stays open.
The guide covers installation, retries, and issue status labels.

## Choose a workflow

| Template                       | What it does                                       |
| ------------------------------ | -------------------------------------------------- |
| `blank`                        | Runs your own task and prompt.                     |
| `simple-loop`                  | Works through labelled issues one at a time.       |
| `sequential-reviewer`          | Implements and reviews issues before PR handoff.   |
| `parallel-planner`             | Plans and works on independent issues in parallel. |
| `parallel-planner-with-review` | Adds review to the parallel workflow.              |

Shipyard also exports TypeScript APIs for custom workflows. Configure prompts,
branches, limits, and hooks in the generated `.shipyard/main.ts` or
`.shipyard/main.mts`. See [configuration](docs/content/docs/configuration.mdx)
and [agent setup](docs/content/docs/agents.mdx).

## Safety and license

Shipyard runs on your machine or infrastructure. Sandbox access depends on the
mounts, credentials, and network settings you choose. Read the
[security guide](docs/security-evaluation.md) before using untrusted code.

Shipyard is source-available under the [PolyForm Strict License 1.0.0](LICENSE)
for permitted noncommercial use. Contact Snappedly for a commercial license.
