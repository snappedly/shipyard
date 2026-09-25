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

During `shipyard init`, choose your agent and template, then follow the
authentication prompts. GitHub Issues is the built-in tracker. Init builds the
Docker image and automatically installs the
[repository runner](docs/content/docs/repository-runner.mdx) on supported
Apple Silicon Macs. Init offers to commit and push the generated Shipyard setup
to the current branch. The offer stages `.shipyard/` and
`.github/workflows/shipyard-wake.yml`. It leaves
`.shipyard/.env` untracked. Non-interactive init skips the commit offer; pass
`--commit-setup true` to commit and push the generated files.

On a local Mac, the repository runner automatically wakes Shipyard when you label an issue.
It runs as long as its terminal stays open.

See the [getting started guide](docs/content/docs/index.mdx) for authentication and
branch options.

Fill in any credentials required in `.shipyard/.env`.
`GH_TOKEN` in `.shipyard/.env` to a GH token with Contents, Issues, and Pull
Requests read/write access and Metadata read access.
Set `SHIPYARD_ROUTINE_MODEL` and `SHIPYARD_STRONG_MODEL` in `.shipyard/.env`
for the roles your template uses. `simple-loop` uses routine for triage and
implementation. `sequential-reviewer` also uses strong for issue reviews.
Parallel planner templates use routine for ticket work and strong for planning,
conflict resolution, and integration. The review-enabled planner also uses
strong for ticket and final specification reviews. See
[agent setup](docs/content/docs/agents.mdx).

If you decline the commit, commit `.shipyard/` before running Shipyard. Docker
sandboxes read setup files from Git history. Keep `.shipyard/.env` untracked.
Init completes only after the repository runner installs. If that step fails,
init exits with the error and keeps the generated configuration and image. Fix
the issue and retry with `npx shipyard runner install`; then commit and push
`.shipyard/` and `.github/workflows/shipyard-wake.yml` before starting the
runner. Runner installation currently requires Apple Silicon macOS.

```sh
npx shipyard run
```

Or for the automated runner:

```sh
npx shipyard runner start
```

To remove Shipyard from the repository:

```sh
npx shipyard uninstall
```

Uninstall confirms before removing the repository runner, the entire
`.shipyard/` folder (including `.env` and runtime data), the generated wake
workflow, and the `@snappedly-tools/shipyard` dependency. It leaves GitHub issues
and labels unchanged. Commit and push the workflow deletion to disable it on
GitHub. Use `--yes` to confirm in a non-interactive shell.

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

## Safety and license

Shipyard runs on your machine or infrastructure. Sandbox access depends on the
mounts, credentials, and network settings you choose. Read the
[security guide](docs/security-evaluation.md) before using untrusted code.

Shipyard is source-available under the [PolyForm Strict License 1.0.0](LICENSE)
for permitted noncommercial use. Contact Snappedly for a commercial license.
