import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { styleText } from "node:util";

import { Display, type DisplayService } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  DEFAULT_AGENT_NAME,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  removeDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type { AgentEntry, SandboxProviderEntry } from "./InitService.js";
import { ExecHostError, InitError } from "./errors.js";
import {
  ensureCodexChatGptAuth,
  resolveCodexAuthMode,
  type CodexAuthMode,
} from "./CodexAuth.js";
import { requireCanonicalConfigDir } from "./runtimeConfig.js";
import {
  installRepositoryRunnerWithReplacement,
  installRepositoryRunner,
} from "./RepositoryRunner.js";
import {
  removeRepositoryRunner,
  RunnerLifecycleError,
} from "./RepositoryRunnerLifecycle.js";
import { DEFAULT_LOG_RETENTION_DAYS, purgeRunLogs } from "./LogRetention.js";
import { repositoryRunnerNextSteps } from "./InitRepositoryRunner.js";
import { commitAndPushInitSetup } from "./InitGitSetup.js";
import { runnerCommand } from "./RepositoryRunnerCommands.js";
import {
  ACTIVATION_LABEL,
  CONFIG_DIR,
  CLI_NAME,
  PRODUCT_NAME,
  RUNNER_DIR,
} from "./runtimeNames.js";
import { VERSION } from "./version.js";
import {
  inspectShipyardConfigDirectory,
  removeShipyardRepositoryFiles,
  SHIPYARD_PACKAGE_NAME,
} from "./UninstallService.js";
import { REPOSITORY_RUNNER_WORKFLOW_PATH } from "./RepositoryRunnerWake.js";

// --- Shared options ---

const imageNameOption = Options.text("image-name").pipe(
  Options.withDescription("Docker image name"),
  Options.optional,
);

const resolveImageName = (
  cliFlag: Option.Option<string>,
  cwd: string,
): string => (cliFlag._tag === "Some" ? cliFlag.value : defaultImageName(cwd));

// --- UID build-args ---

/** Build-args that align the image UID/GID to the host (Linux/macOS). No-op on Windows. */
const defaultUidBuildArgs = (): Record<string, string> => {
  const args: Record<string, string> = {};
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined) args.AGENT_UID = String(uid);
  if (gid !== undefined) args.AGENT_GID = String(gid);
  return args;
};

// --- Config directory check ---

const requireConfigDir = (
  cwd: string,
): ReturnType<typeof requireCanonicalConfigDir> =>
  requireCanonicalConfigDir(cwd);

/**
 * Apply the default log-retention policy without making an agent run depend on
 * maintenance. Explicit `runner purge` remains available when an operator
 * wants to run it directly or use a host scheduler.
 */
const purgeRunLogsBestEffort = (
  display: DisplayService,
  repoDir: string,
): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () =>
      purgeRunLogs({
        repoDir,
        retentionDays: DEFAULT_LOG_RETENTION_DAYS,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.flatMap((result) => {
      const removed = result.removedCount;
      return removed === 0
        ? Effect.void
        : display.status(
            `Purged ${removed} outdated run-log ${removed === 1 ? "entry" : "entries"}.`,
            "info",
          );
    }),
    Effect.catchAll((error) =>
      display.status(
        `Automatic run-log purge skipped: ${error instanceof Error ? error.message : String(error)}`,
        "warn",
      ),
    ),
  );

// --- Run command ---

const runSandboxOption = Options.choice("sandbox", ["docker"] as const).pipe(
  Options.withDescription(
    "Sandbox provider to build (inferred from Dockerfile)",
  ),
  Options.optional,
);

const skipBuildOption = Options.boolean("skip-build").pipe(
  Options.withDescription("Skip rebuilding the sandbox image"),
);

const entrypointOption = Options.text("entrypoint").pipe(
  Options.withDescription(
    "TypeScript entrypoint (defaults to .shipyard/main.ts or main.mts)",
  ),
  Options.optional,
);

type RunSandbox = "docker";

const resolveRunEntrypoint = (
  cwd: string,
  configDir: string,
  entrypoint: Option.Option<string>,
): string | InitError => {
  if (entrypoint._tag === "Some") {
    const path = resolve(cwd, entrypoint.value);
    return existsSync(path)
      ? path
      : new InitError({ message: `Entrypoint not found: ${entrypoint.value}` });
  }

  for (const filename of ["main.ts", "main.mts"]) {
    const path = join(configDir, filename);
    if (existsSync(path)) return path;
  }

  return new InitError({
    message:
      "No Shipyard entrypoint found. Expected .shipyard/main.ts or .shipyard/main.mts; run `shipyard init` first or pass `--entrypoint <path>.",
  });
};

const resolveRunSandbox = (
  configDir: string,
  sandbox: Option.Option<RunSandbox>,
): RunSandbox | InitError => {
  if (sandbox._tag === "Some") {
    const filename = "Dockerfile";
    if (!existsSync(join(configDir, filename))) {
      return new InitError({
        message: `No .shipyard/${filename} found for the selected ${sandbox.value} sandbox provider.`,
      });
    }
    return sandbox.value;
  }

  const hasDockerfile = existsSync(join(configDir, "Dockerfile"));
  if (hasDockerfile) return "docker";
  return new InitError({
    message:
      "No .shipyard/Dockerfile found. Run `shipyard init` first, or pass `--skip-build` for a programmatically configured sandbox.",
  });
};

const executeEntrypoint = (
  cwd: string,
  entrypoint: string,
): Effect.Effect<void, ExecHostError> =>
  Effect.async((resume, signal) => {
    const command = process.platform === "win32" ? "npx.cmd" : "npx";
    const args = ["--no-install", "tsx", entrypoint];
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: "inherit",
    });
    const commandText = `${command} ${args.join(" ")}`;
    let settled = false;

    const finish = (effect: Effect.Effect<void, ExecHostError>) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resume(effect);
    };
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });

    child.once("error", (error) => {
      finish(
        Effect.fail(
          new ExecHostError({
            command: commandText,
            message: error.message,
          }),
        ),
      );
    });
    child.once("close", (code, closeSignal) => {
      if (code === 0) {
        finish(Effect.succeed(undefined));
        return;
      }
      finish(
        Effect.fail(
          new ExecHostError({
            command: commandText,
            message:
              closeSignal === null
                ? `Process exited with code ${code ?? "unknown"}.`
                : `Process terminated by ${closeSignal}.`,
          }),
        ),
      );
    });
  });

const runCommand = Command.make(
  "run",
  {
    imageName: imageNameOption,
    sandbox: runSandboxOption,
    skipBuild: skipBuildOption,
    entrypoint: entrypointOption,
  },
  ({ imageName: imageNameFlag, sandbox, skipBuild, entrypoint }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const configDir = yield* requireConfigDir(cwd);
      yield* purgeRunLogsBestEffort(d, cwd);
      const resolvedEntrypoint = resolveRunEntrypoint(
        cwd,
        configDir,
        entrypoint,
      );
      if (resolvedEntrypoint instanceof InitError) {
        return yield* Effect.fail(resolvedEntrypoint);
      }

      if (!skipBuild) {
        const selectedSandbox = resolveRunSandbox(configDir, sandbox);
        if (selectedSandbox instanceof InitError) {
          return yield* Effect.fail(selectedSandbox);
        }
        const imageName = resolveImageName(imageNameFlag, cwd);
        yield* d.spinner(
          `Building Docker image '${imageName}'...`,
          buildImage(imageName, configDir, {
            buildArgs: defaultUidBuildArgs(),
          }),
        );
      }

      yield* d.status(
        `Running ${entrypoint._tag === "Some" ? entrypoint.value : ".shipyard/" + resolvedEntrypoint.split(/[\\/]/).pop()}.`,
        "info",
      );
      yield* executeEntrypoint(cwd, resolvedEntrypoint);
    }),
);

// --- Init command ---

const templateOption = Options.text("template").pipe(
  Options.withDescription(
    "Template to scaffold (e.g. simple-loop, parallel-planner)",
  ),
  Options.optional,
);

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Agent to use (e.g. codex)"),
  Options.optional,
);

const codexAuthOption = Options.choice("codex-auth", [
  "api-key",
  "chatgpt",
]).pipe(
  Options.withDescription(
    "How Codex should authenticate: API key or ChatGPT subscription",
  ),
  Options.optional,
);

const initModelOption = Options.text("model").pipe(
  Options.withDescription(
    "Model to use for the agent. Defaults to the agent's configured default model",
  ),
  Options.optional,
);

const sandboxOption = Options.text("sandbox").pipe(
  Options.withDescription("Sandbox provider to use (docker)"),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

const commitSetupOption = Options.choice("commit-setup", ["true", "false"])
  .pipe(
    Options.withDescription(
      "Whether to commit and push .shipyard/ and any generated runner workflow",
    ),
  )
  .pipe(Options.optional);

const uninstallYesOption = Options.boolean("yes").pipe(
  Options.withDescription("confirm uninstall without an interactive prompt"),
);

const uninstallForceOption = Options.boolean("force").pipe(
  Options.withDescription(
    "remove local runner files if GitHub unregistration fails",
  ),
);

/**
 * Translate an `Options.choice("flag", ["true", "false"]).optional` value into
 * a tri-state boolean. None when the flag was absent; otherwise the parsed bool.
 */
const choiceToTriBool = (
  opt: Option.Option<"true" | "false">,
): Option.Option<boolean> =>
  opt._tag === "Some" ? Option.some(opt.value === "true") : Option.none();

const initCommand = Command.make(
  "init",
  {
    imageName: imageNameOption,
    template: templateOption,
    agent: agentOption,
    codexAuth: codexAuthOption,
    model: initModelOption,
    sandbox: sandboxOption,
    installTemplateDeps: installTemplateDepsOption,
    commitSetup: commitSetupOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    codexAuth: codexAuthFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    installTemplateDeps: installTemplateDepsFlag,
    commitSetup: commitSetupFlag,
  }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      const imageName = resolveImageName(imageNameFlag, cwd);

      // Early validation of CLI flags before interactive prompts
      const templates = listTemplates();
      if (template._tag === "Some") {
        const valid = templates.find((tmpl) => tmpl.name === template.value);
        if (!valid) {
          const names = templates.map((tmpl) => tmpl.name).join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown template "${template.value}". Available: ${names}`,
            }),
          );
        }
      }

      if (sandboxFlag._tag === "Some") {
        const valid = getSandboxProvider(sandboxFlag.value);
        if (!valid) {
          const names = listSandboxProviders()
            .map((p) => p.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown sandbox provider "${sandboxFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      yield* d.progress("Initializing Shipyard", (report) =>
        Effect.gen(function* () {
          const progressAt = (current: number, message: string) =>
            report({ current, total: 100, message });
          const progressRange = (
            start: number,
            end: number,
            update: { current: number; total: number; message: string },
          ) => {
            const total = Math.max(1, update.total);
            const fraction = Math.min(1, Math.max(0, update.current / total));
            progressAt(
              Math.round(start + (end - start) * fraction),
              update.message,
            );
          };
          const whilePrompt = async <A>(
            prompt: () => Promise<A>,
          ): Promise<A> => {
            report.pause();
            try {
              return await prompt();
            } finally {
              report.resume();
            }
          };
          const statusWithProgress = (
            message: string,
            severity: Parameters<DisplayService["status"]>[1],
          ) =>
            Effect.acquireUseRelease(
              Effect.sync(() => report.pause()),
              () => d.status(message, severity),
              () => Effect.sync(() => report.resume()),
            );

          const installTemplateDepsChoice = choiceToTriBool(
            installTemplateDepsFlag,
          );
          const commitSetupChoice = choiceToTriBool(commitSetupFlag);

          const isInteractive = process.stdin.isTTY === true;
          const failIfNonInteractive = (flag: string) =>
            Effect.fail(
              new InitError({
                message: `${flag} is required in non-interactive mode (no TTY detected).`,
              }),
            );

          // Tri-state confirm: CLI flag wins; otherwise prompt interactively (or
          // fail fast in non-interactive mode naming the missing flag). Cancelling
          // the prompt is treated as abort — same shape as the select prompts above.
          const resolveConfirmFlag = (params: {
            choice: Option.Option<boolean>;
            flag: string;
            promptMessage: string;
            cancelMessage: string;
          }): Effect.Effect<boolean, InitError> =>
            Effect.gen(function* () {
              if (params.choice._tag === "Some") return params.choice.value;
              if (!isInteractive) {
                yield* failIfNonInteractive(params.flag);
              }
              const confirmed = yield* Effect.promise(() =>
                whilePrompt(() =>
                  clack.confirm({
                    message: params.promptMessage,
                    initialValue: true,
                  }),
                ),
              );
              if (clack.isCancel(confirmed)) {
                yield* Effect.fail(
                  new InitError({ message: params.cancelMessage }),
                );
              }
              return confirmed === true;
            });

          // Resolve agent: CLI flag > interactive select
          const agents = listAgents();
          let selectedAgent: AgentEntry;
          if (agentFlag._tag === "Some") {
            const entry = getAgent(agentFlag.value);
            if (!entry) {
              const names = agents.map((a) => a.name).join(", ");
              yield* Effect.fail(
                new InitError({
                  message: `Unknown agent "${agentFlag.value}". Available: ${names}`,
                }),
              );
            }
            selectedAgent = entry!;
          } else {
            if (!isInteractive) {
              yield* failIfNonInteractive("--agent");
            }
            const selected = yield* Effect.promise(() =>
              whilePrompt(() =>
                clack.select({
                  message: "Select an agent:",
                  initialValue: DEFAULT_AGENT_NAME,
                  options: agents.map((a) => ({
                    value: a.name,
                    label: a.label,
                    hint: `Default model: ${a.defaultModel}`,
                  })),
                }),
              ),
            );
            if (clack.isCancel(selected)) {
              yield* Effect.fail(
                new InitError({ message: "Agent selection cancelled." }),
              );
            }
            selectedAgent = getAgent(selected as string)!;
          }
          progressAt(6, `Selected ${selectedAgent.label}`);

          const selectedCodexAuth = yield* Effect.tryPromise({
            try: () =>
              resolveCodexAuthMode({
                agentName: selectedAgent.name,
                requested:
                  codexAuthFlag._tag === "Some"
                    ? codexAuthFlag.value
                    : undefined,
                interactive: isInteractive,
                select: async () => {
                  const selected = await whilePrompt(() =>
                    clack.select({
                      message: "How will you authenticate Codex?",
                      initialValue: "chatgpt",
                      options: [
                        {
                          value: "chatgpt" as const,
                          label: "Sign in with ChatGPT",
                          hint: "Use your ChatGPT subscription",
                        },
                        {
                          value: "api-key" as const,
                          label: "OpenAI API key",
                          hint: "Use API billing",
                        },
                      ],
                    }),
                  );
                  return clack.isCancel(selected)
                    ? undefined
                    : (selected as CodexAuthMode);
                },
              }),
            catch: (error) =>
              error instanceof InitError
                ? error
                : new InitError({
                    message: `Codex authentication selection failed: ${String(error)}`,
                  }),
          });
          progressAt(12, "Authentication method selected");

          // Resolve model: CLI flag > agent default
          const selectedModel =
            modelFlag._tag === "Some"
              ? modelFlag.value
              : selectedAgent.defaultModel;

          if (selectedCodexAuth === "chatgpt") {
            yield* Effect.try({
              try: () => {
                report.pause();
                try {
                  ensureCodexChatGptAuth({
                    cwd,
                    interactive: isInteractive,
                  });
                } finally {
                  report.resume();
                }
              },
              catch: (error) =>
                error instanceof InitError
                  ? error
                  : new InitError({
                      message: `Codex authentication setup failed: ${String(error)}`,
                    }),
            });
          }
          progressAt(18, "Authentication setup complete");

          // Docker is the sole supported provider. Keep --sandbox docker accepted
          // for existing non-interactive init scripts.
          const selectedSandboxProvider: SandboxProviderEntry =
            getSandboxProvider("docker")!;

          const selectedIssueTracker = getIssueTracker("github-issues")!;

          // Resolve template: CLI flag > interactive select (already validated above)
          let selectedTemplate: string;
          if (template._tag === "Some") {
            selectedTemplate = template.value;
          } else {
            if (!isInteractive) {
              yield* failIfNonInteractive("--template");
            }
            const selected = yield* Effect.promise(() =>
              whilePrompt(() =>
                clack.select({
                  message: "Select a template:",
                  initialValue: "simple-loop",
                  options: templates.map((tmpl) => ({
                    value: tmpl.name,
                    label: tmpl.name,
                    hint: tmpl.description,
                  })),
                }),
              ),
            );
            if (clack.isCancel(selected)) {
              yield* Effect.fail(
                new InitError({ message: "Template selection cancelled." }),
              );
            }
            selectedTemplate = selected as string;
          }
          progressAt(24, `Selected ${selectedTemplate} template`);

          // These labels are part of the GitHub Issues workflow contract.
          const failedLabels: string[] = [];
          const labels = [
            [
              ACTIVATION_LABEL,
              `Issues for ${PRODUCT_NAME} to work on`,
              "F9A825",
            ],
            ["bug", "Something is broken", "D73A4A"],
            ["enhancement", "New feature or improvement", "A2EEEF"],
            ["needs-triage", "Maintainer evaluation needed", "FBCA04"],
            ["needs-info", "Waiting for reporter information", "D4C5F9"],
            ["ready-for-agent", "Ready for agent implementation", "0E8A16"],
            ["ready-for-human", "Requires human implementation", "1D76DB"],
            ["wontfix", "Will not be actioned", "FFFFFF"],
            ["shipyard:blocked", "Shipyard work needs intervention", "B60205"],
            [
              "shipyard:pending",
              "Shipyard is working on this ticket",
              "1D76DB",
            ],
            [
              "shipyard:complete",
              "Shipyard work ready for human review",
              "0E8A16",
            ],
            [
              "shipyard:outstanding-tasks",
              "Spec has uncompleted tickets",
              "FBCA04",
            ],
          ] as const;
          for (const [index, [name, description, color]] of labels.entries()) {
            try {
              execSync(
                `gh label create "${name}" --description "${description}" --color "${color}" --force`,
                { cwd, stdio: "ignore" },
              );
            } catch {
              failedLabels.push(name);
            }
            progressAt(
              24 + Math.round(((index + 1) / labels.length) * 10),
              "Provisioning GitHub labels",
            );
          }
          if (failedLabels.length) {
            let connected = Boolean(process.env.GH_REPO);
            try {
              execSync("git remote get-url origin", { cwd, stdio: "ignore" });
              connected = true;
            } catch {
              // A local repository can be scaffolded before its GitHub remote exists.
            }
            const message = `Could not create GitHub labels: ${failedLabels.join(", ")}. Check GitHub access and rerun init.`;
            if (connected) yield* Effect.fail(new InitError({ message }));
            report.pause();
            try {
              console.warn(message);
            } finally {
              report.resume();
            }
          }

          progressAt(34, `Scaffolding ${CONFIG_DIR}/ config directory`);
          yield* scaffold(cwd, {
            agent: selectedAgent,
            model: selectedModel,
            modelExplicit: modelFlag._tag === "Some",
            templateName: selectedTemplate,
            issueTracker: selectedIssueTracker,
            sandboxProvider: selectedSandboxProvider,
            codexAuth: selectedCodexAuth,
            onProgress: (update) => progressRange(34, 56, update),
          }).pipe(
            Effect.mapError(
              (e) =>
                new InitError({
                  message: `${e instanceof Error ? e.message : e}`,
                }),
            ),
          );
          progressAt(56, "Shipyard configuration generated");

          // Detect the host package manager so the zod offer below and the next
          // steps below both use the right install command.
          const packageManager = yield* detectPackageManager(cwd);
          progressAt(58, `Detected ${packageManager}`);

          // If the chosen template imports zod on the host (the planner templates
          // build their <plan> output schema with it) and the host doesn't already
          // declare it, offer to install it. Without this, the very first
          // `npx tsx .shipyard/main.ts` crashes with ERR_MODULE_NOT_FOUND.
          if (getTemplateDependencies(selectedTemplate).includes("zod")) {
            const alreadyInstalled = yield* hostHasDependency(cwd, "zod");
            if (!alreadyInstalled) {
              const installCmd = addDependencyCommand(packageManager, "zod");
              const shouldInstall = yield* resolveConfirmFlag({
                choice: installTemplateDepsChoice,
                flag: "--install-template-deps",
                promptMessage: `The ${selectedTemplate} template needs a schema validator. Install zod now (\`${installCmd}\`)?`,
                cancelMessage: "Install-template-deps selection cancelled.",
              });
              progressAt(
                60,
                shouldInstall
                  ? "Installing template dependency"
                  : "Skipping zod installation",
              );
              if (shouldInstall) {
                progressAt(62, `Installing zod with ${packageManager}`);
                const installed = yield* Effect.sync(() => {
                  try {
                    execSync(installCmd, { cwd, stdio: "ignore" });
                    return true;
                  } catch {
                    return false;
                  }
                });
                progressAt(64, "Template dependency setup complete");
                yield* installed
                  ? statusWithProgress(
                      `Installed zod with ${packageManager}.`,
                      "success",
                    )
                  : statusWithProgress(
                      `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                      "warn",
                    );
              }
            }
          }
          progressAt(66, "Template dependencies ready");

          const providerLabel = selectedSandboxProvider.label;
          const containerfileDir = join(cwd, CONFIG_DIR);
          progressAt(68, `Building ${providerLabel} image '${imageName}'`);
          yield* buildImage(imageName, containerfileDir, {
            buildArgs: defaultUidBuildArgs(),
          });
          progressAt(78, "Docker image built");
          yield* statusWithProgress("Image built successfully.", "success");

          progressAt(78, "Installing repository runner");
          const runner = yield* Effect.tryPromise({
            try: () =>
              installRepositoryRunnerWithReplacement({
                repoDir: cwd,
                interactive: isInteractive,
                confirmReplacement: async (conflict) => {
                  const confirmed = await whilePrompt(() =>
                    clack.confirm({
                      message: conflict.confirmationMessage,
                      initialValue: false,
                    }),
                  );
                  return !clack.isCancel(confirmed) && confirmed === true;
                },
                install: () =>
                  installRepositoryRunner({
                    repoDir: cwd,
                    onProgress: (update) => progressRange(78, 94, update),
                  }),
              }),
            catch: (error) =>
              error instanceof InitError
                ? error
                : new InitError({
                    message: `Repository runner installation failed: ${error instanceof Error ? error.message : String(error)}. Init is incomplete. Fix the issue and retry with \`npx ${CLI_NAME} runner install\`.`,
                  }),
          });
          progressAt(94, "Repository runner installed");
          yield* statusWithProgress(
            `Installed ${runner.name} for ${runner.repository}.`,
            "success",
          );

          let shouldCommitSetup =
            commitSetupChoice._tag === "Some" && commitSetupChoice.value;
          if (commitSetupChoice._tag === "None" && isInteractive) {
            const confirmed = yield* Effect.promise(() =>
              whilePrompt(() =>
                clack.confirm({
                  message:
                    "Commit .shipyard/ and any generated runner workflow, then push this branch to origin? Sandboxes need the setup committed. The push also sends any local commits not already on origin.",
                  initialValue: true,
                }),
              ),
            );
            if (clack.isCancel(confirmed)) {
              yield* Effect.fail(
                new InitError({
                  message: "Shipyard setup commit cancelled.",
                }),
              );
            }
            shouldCommitSetup = confirmed === true;
          }
          progressAt(
            96,
            shouldCommitSetup
              ? "Committing and pushing Shipyard setup"
              : "Setup commit skipped",
          );

          if (shouldCommitSetup) {
            const publishResult = yield* Effect.sync(() => {
              try {
                return {
                  status: "committed" as const,
                  result: commitAndPushInitSetup(cwd),
                };
              } catch (error) {
                return {
                  status: "failed" as const,
                  message:
                    error instanceof Error ? error.message : String(error),
                };
              }
            });
            progressAt(99, "Shipyard setup commit finished");
            if (publishResult.status === "failed") {
              yield* statusWithProgress(
                `Could not commit the Shipyard setup: ${publishResult.message}`,
                "warn",
              );
              yield* statusWithProgress(
                `Commit \`${CONFIG_DIR}/\` before running Shipyard.`,
                "warn",
              );
            } else if (publishResult.result.pushError) {
              yield* statusWithProgress(
                `Committed ${publishResult.result.commit}, but could not push to origin/${publishResult.result.branch}: ${publishResult.result.pushError}`,
                "warn",
              );
              yield* statusWithProgress(
                `Push it later with \`git push origin ${publishResult.result.branch}\`.`,
                "warn",
              );
            } else {
              yield* statusWithProgress(
                `Committed ${publishResult.result.commit} and pushed origin/${publishResult.result.branch}.`,
                "success",
              );
            }
          } else {
            yield* statusWithProgress(
              `Commit \`${CONFIG_DIR}/\` before running Shipyard. Sandboxes do not receive uncommitted setup files.`,
              "warn",
            );
            yield* statusWithProgress(
              "Push the runner wake workflow to the repository's default branch before starting the runner.",
              "warn",
            );
          }

          progressAt(100, "Initialization complete");
        }),
      );

      yield* d.text("Repository runner next steps:");
      for (const [index, line] of repositoryRunnerNextSteps().entries()) {
        yield* d.text(styleText("dim", `${index + 1}. ${line}`));
      }

      yield* d.status("Init complete!", "success");

      const nextSteps = getNextStepsLines();
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
    }),
);

// --- Uninstall command ---

const uninstallCommand = Command.make(
  "uninstall",
  { yes: uninstallYesOption, force: uninstallForceOption },
  ({ yes, force }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const repoDir = process.cwd();
      const configDirExists = yield* Effect.tryPromise({
        try: () => inspectShipyardConfigDirectory(repoDir),
        catch: (error) =>
          new InitError({
            message: `Could not inspect Shipyard configuration: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
      const runnerDir = join(repoDir, CONFIG_DIR, RUNNER_DIR);
      const runnerInstalled = configDirExists && existsSync(runnerDir);
      const workflowExists = existsSync(
        join(repoDir, REPOSITORY_RUNNER_WORKFLOW_PATH),
      );
      const packageInstalled = yield* hostHasDependency(
        repoDir,
        SHIPYARD_PACKAGE_NAME,
      );

      if (
        !configDirExists &&
        !workflowExists &&
        !runnerInstalled &&
        !packageInstalled
      ) {
        yield* d.status(
          "No Shipyard installation found in this repository.",
          "info",
        );
        return;
      }

      if (!yes && process.stdin.isTTY !== true) {
        return yield* Effect.fail(
          new InitError({
            message:
              "Shipyard uninstall needs confirmation. Run it in a terminal or pass --yes.",
          }),
        );
      }

      if (!yes) {
        const actions = [
          runnerInstalled
            ? "unregister and remove the repository runner"
            : null,
          configDirExists
            ? `remove all of ${CONFIG_DIR}/, including .env and runtime data`
            : null,
          workflowExists ? "remove the generated runner wake workflow" : null,
          packageInstalled
            ? `remove ${SHIPYARD_PACKAGE_NAME} from package.json`
            : null,
        ].filter((action): action is string => action !== null);
        const confirmation = yield* Effect.tryPromise({
          try: () =>
            clack.confirm({
              message: `Uninstall Shipyard from ${repoDir}? This will ${actions.join(", ")}. It leaves GitHub issues and labels unchanged.`,
              initialValue: false,
            }),
          catch: (error) =>
            new InitError({
              message: `Could not confirm Shipyard uninstall: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        if (clack.isCancel(confirmation) || confirmation !== true) {
          yield* d.status("Shipyard uninstall cancelled.", "info");
          return;
        }
      }

      if (runnerInstalled) {
        const result = yield* Effect.tryPromise({
          try: () => removeRepositoryRunner({ repoDir, force }),
          catch: (error) =>
            error instanceof RunnerLifecycleError
              ? new InitError({ message: error.message })
              : new InitError({
                  message: `Repository runner removal failed: ${error instanceof Error ? error.message : String(error)}`,
                }),
        });
        yield* d.status("Repository runner removed.", "success");
        if (result.manualCleanup) {
          yield* d.status(result.manualCleanup, "warn");
        }
      }

      const files = yield* Effect.tryPromise({
        try: () => removeShipyardRepositoryFiles({ repoDir }),
        catch: (error) =>
          new InitError({
            message: `Could not remove Shipyard repository files: ${error instanceof Error ? error.message : String(error)}`,
          }),
      });
      if (files.configDirectoryRemoved) {
        yield* d.status(`Removed all of ${CONFIG_DIR}/.`, "success");
      }
      if (files.workflowRemoved) {
        yield* d.status(
          `Removed ${REPOSITORY_RUNNER_WORKFLOW_PATH}.`,
          "success",
        );
        yield* d.status(
          "Commit and push the workflow deletion to disable it on GitHub.",
          "info",
        );
      } else if (files.workflowPreserved) {
        yield* d.status(
          `Preserved ${REPOSITORY_RUNNER_WORKFLOW_PATH} because it is customized or linked.`,
          "warn",
        );
      }
      if (packageInstalled) {
        const packageManager = yield* detectPackageManager(repoDir);
        const command = removeDependencyCommand(
          packageManager,
          SHIPYARD_PACKAGE_NAME,
        );
        yield* Effect.try({
          try: () => execSync(command, { cwd: repoDir, stdio: "inherit" }),
          catch: (error) =>
            new InitError({
              message: `Could not remove ${SHIPYARD_PACKAGE_NAME}. Rerun the uninstall after resolving the package-manager error: ${error instanceof Error ? error.message : String(error)}`,
            }),
        });
        yield* d.status(
          `Removed ${SHIPYARD_PACKAGE_NAME} with ${packageManager}.`,
          "success",
        );
      }

      yield* d.status("Shipyard uninstalled from this repository.", "success");
    }),
);

// --- Build-image command ---

const dockerfileOption = Options.file("dockerfile").pipe(
  Options.withDescription(
    "Path to a custom Dockerfile (build context will be the current working directory)",
  ),
  Options.optional,
);

const buildImageCommand = Command.make(
  "build-image",
  {
    imageName: imageNameOption,
    dockerfile: dockerfileOption,
  },
  ({ imageName: imageNameFlag, dockerfile }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();
      yield* requireConfigDir(cwd);

      const imageName = resolveImageName(imageNameFlag, cwd);

      const dockerfileDir = join(cwd, CONFIG_DIR);
      const dockerfilePath =
        dockerfile._tag === "Some" ? dockerfile.value : undefined;

      yield* d.spinner(
        `Building Docker image '${imageName}'...`,
        buildImage(imageName, dockerfileDir, {
          dockerfile: dockerfilePath,
          buildArgs: defaultUidBuildArgs(),
        }),
      );

      yield* d.status("Build complete!", "success");
    }),
);

// --- Remove-image command ---

const removeImageCommand = Command.make(
  "remove-image",
  {
    imageName: imageNameOption,
  },
  ({ imageName: imageNameFlag }) =>
    Effect.gen(function* () {
      const d = yield* Display;
      const cwd = process.cwd();

      const imageName = resolveImageName(imageNameFlag, cwd);

      yield* d.spinner(
        `Removing Docker image '${imageName}'...`,
        removeImage(imageName),
      );
      yield* d.status("Image removed.", "success");
    }),
);

// --- Docker namespace command ---

const dockerCommand = Command.make("docker", {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(
      "Docker sandbox commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(Command.withSubcommands([buildImageCommand, removeImageCommand]));

// --- Root command ---

const rootCommand = Command.make(CLI_NAME, {}, () =>
  Effect.gen(function* () {
    const d = yield* Display;
    yield* d.status(`${PRODUCT_NAME} v${VERSION}`, "info");
    yield* d.status("Use --help to see available commands.", "info");
  }),
);

export const shipyard = rootCommand.pipe(
  Command.withSubcommands([
    initCommand,
    uninstallCommand,
    runCommand,
    dockerCommand,
    runnerCommand,
  ]),
);

export const cli = Command.run(shipyard, {
  name: CLI_NAME,
  version: VERSION,
});
