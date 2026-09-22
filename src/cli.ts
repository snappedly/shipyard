import { Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import * as clack from "@clack/prompts";
import { execSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { styleText } from "node:util";

import { Display } from "./Display.js";
import { buildImage, removeImage } from "./DockerLifecycle.js";
import {
  scaffold,
  listTemplates,
  listAgents,
  getAgent,
  listIssueTrackers,
  getIssueTracker,
  listSandboxProviders,
  getSandboxProvider,
  DEFAULT_AGENT_NAME,
  getNextStepsLines,
  detectPackageManager,
  addDependencyCommand,
  hostHasDependency,
  getTemplateDependencies,
} from "./InitService.js";
import { defaultImageName } from "./sandboxes/docker.js";
import type {
  AgentEntry,
  IssueTrackerEntry,
  SandboxProviderEntry,
} from "./InitService.js";
import { ExecHostError, InitError } from "./errors.js";
import {
  ensureCodexChatGptAuth,
  resolveCodexAuthMode,
  type CodexAuthMode,
} from "./CodexAuth.js";
import { requireCanonicalConfigDir } from "./runtimeConfig.js";
import {
  installRepositoryRunner,
  RunnerInstallError,
} from "./RepositoryRunner.js";
import {
  initializeRepositoryRunner,
  repositoryRunnerNextSteps,
} from "./InitRepositoryRunner.js";
import { runnerCommand } from "./RepositoryRunnerCommands.js";
import {
  ACTIVATION_LABEL,
  CONFIG_DIR,
  CLI_NAME,
  PRODUCT_NAME,
} from "./runtimeNames.js";
import { VERSION } from "./version.js";

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
    "Template to scaffold (e.g. blank, simple-loop, parallel-planner)",
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

const issueTrackerOption = Options.text("issue-tracker").pipe(
  Options.withDescription("Issue tracker to use (github-issues)"),
  Options.optional,
);

// Tri-state booleans (Some(true) / Some(false) / None) so we can tell "user
// chose false" from "user didn't pass the flag at all" — only the latter
// triggers the interactive prompt.
const buildImageOption = Options.choice("build-image", ["true", "false"]).pipe(
  Options.withDescription("Whether to build the sandbox image now"),
  Options.optional,
);

const installTemplateDepsOption = Options.choice("install-template-deps", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install the template's host dependencies (e.g. zod for the planner templates)",
  ),
  Options.optional,
);

const installRunnerOption = Options.choice("install-runner", [
  "true",
  "false",
]).pipe(
  Options.withDescription(
    "Whether to install a foreground repository runner after scaffolding",
  ),
  Options.optional,
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
    issueTracker: issueTrackerOption,
    buildImage: buildImageOption,
    installTemplateDeps: installTemplateDepsOption,
    installRunner: installRunnerOption,
  },
  ({
    imageName: imageNameFlag,
    template,
    agent: agentFlag,
    codexAuth: codexAuthFlag,
    model: modelFlag,
    sandbox: sandboxFlag,
    issueTracker: issueTrackerFlag,
    buildImage: buildImageFlag,
    installTemplateDeps: installTemplateDepsFlag,
    installRunner: installRunnerFlag,
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

      if (issueTrackerFlag._tag === "Some") {
        const valid = getIssueTracker(issueTrackerFlag.value);
        if (!valid) {
          const names = listIssueTrackers()
            .map((t) => t.name)
            .join(", ");
          yield* Effect.fail(
            new InitError({
              message: `Unknown issue tracker "${issueTrackerFlag.value}". Available: ${names}`,
            }),
          );
        }
      }

      const buildImageChoice = choiceToTriBool(buildImageFlag);
      const installTemplateDepsChoice = choiceToTriBool(
        installTemplateDepsFlag,
      );
      const installRunnerChoice = choiceToTriBool(installRunnerFlag);

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
            clack.confirm({
              message: params.promptMessage,
              initialValue: true,
            }),
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
          clack.select({
            message: "Select an agent:",
            initialValue: DEFAULT_AGENT_NAME,
            options: agents.map((a) => ({
              value: a.name,
              label: a.label,
              hint: `Default model: ${a.defaultModel}`,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Agent selection cancelled." }),
          );
        }
        selectedAgent = getAgent(selected as string)!;
      }

      const selectedCodexAuth = yield* Effect.tryPromise({
        try: () =>
          resolveCodexAuthMode({
            agentName: selectedAgent.name,
            requested:
              codexAuthFlag._tag === "Some" ? codexAuthFlag.value : undefined,
            interactive: isInteractive,
            select: async () => {
              const selected = await clack.select({
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
              });
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

      // Resolve model: CLI flag > agent default
      const selectedModel =
        modelFlag._tag === "Some"
          ? modelFlag.value
          : selectedAgent.defaultModel;

      if (selectedCodexAuth === "chatgpt") {
        yield* Effect.try({
          try: () =>
            ensureCodexChatGptAuth({
              cwd,
              interactive: isInteractive,
            }),
          catch: (error) =>
            error instanceof InitError
              ? error
              : new InitError({
                  message: `Codex authentication setup failed: ${String(error)}`,
                }),
        });
      }

      // Resolve sandbox provider: CLI flag > interactive select (no default — user must choose)
      const sandboxProviders = listSandboxProviders();
      let selectedSandboxProvider: SandboxProviderEntry;
      if (sandboxFlag._tag === "Some") {
        selectedSandboxProvider = getSandboxProvider(sandboxFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--sandbox");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a sandbox provider:",
            options: sandboxProviders.map((p) => ({
              value: p.name,
              label: p.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Sandbox provider selection cancelled.",
            }),
          );
        }
        selectedSandboxProvider = getSandboxProvider(selected as string)!;
      }

      // Resolve issue tracker: CLI flag > interactive select (already validated above)
      const issueTrackers = listIssueTrackers();
      let selectedIssueTracker: IssueTrackerEntry;
      if (issueTrackerFlag._tag === "Some") {
        selectedIssueTracker = getIssueTracker(issueTrackerFlag.value)!;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--issue-tracker");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select an issue tracker:",
            initialValue: "github-issues",
            options: issueTrackers.map((b) => ({
              value: b.name,
              label: b.label,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({
              message: "Issue tracker selection cancelled.",
            }),
          );
        }
        selectedIssueTracker = getIssueTracker(selected as string)!;
      }

      // Resolve template: CLI flag > interactive select (already validated above)
      let selectedTemplate: string;
      if (template._tag === "Some") {
        selectedTemplate = template.value;
      } else {
        if (!isInteractive) {
          yield* failIfNonInteractive("--template");
        }
        const selected = yield* Effect.promise(() =>
          clack.select({
            message: "Select a template:",
            initialValue: "blank",
            options: templates.map((tmpl) => ({
              value: tmpl.name,
              label: tmpl.name,
              hint: tmpl.description,
            })),
          }),
        );
        if (clack.isCancel(selected)) {
          yield* Effect.fail(
            new InitError({ message: "Template selection cancelled." }),
          );
        }
        selectedTemplate = selected as string;
      }

      // The GitHub Issues integration has one fixed activation-label contract.
      // Label creation remains best-effort so init can still scaffold when gh
      // is unavailable or the current identity cannot manage labels.
      if (selectedIssueTracker.name === "github-issues") {
        yield* Effect.try({
          try: () =>
            execSync(
              `gh label create "${ACTIVATION_LABEL}" --description "Issues for ${PRODUCT_NAME} to work on" --color "F9A825" --force 2>/dev/null`,
              { cwd, stdio: "ignore" },
            ),
          catch: () => undefined,
        }).pipe(Effect.ignore);
      }

      const scaffoldResult = yield* d.spinner(
        `Scaffolding ${CONFIG_DIR}/ config directory...`,
        scaffold(cwd, {
          agent: selectedAgent,
          model: selectedModel,
          templateName: selectedTemplate,
          issueTracker: selectedIssueTracker,
          sandboxProvider: selectedSandboxProvider,
          codexAuth: selectedCodexAuth,
        }).pipe(
          Effect.mapError(
            (e) =>
              new InitError({
                message: `${e instanceof Error ? e.message : e}`,
              }),
          ),
        ),
      );

      // Detect the host package manager so the zod offer below and the next
      // steps below both use the right install command.
      const packageManager = yield* detectPackageManager(cwd);

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
          if (shouldInstall) {
            const installed = yield* Effect.sync(() => {
              try {
                execSync(installCmd, { cwd, stdio: "ignore" });
                return true;
              } catch {
                return false;
              }
            });
            yield* installed
              ? d.status(`Installed zod with ${packageManager}.`, "success")
              : d.status(
                  `Couldn't install zod automatically. Run \`${installCmd}\` before running the agent.`,
                  "warn",
                );
          }
        }
      }

      const providerLabel = selectedSandboxProvider.label;
      const shouldBuild = yield* resolveConfirmFlag({
        choice: buildImageChoice,
        flag: "--build-image",
        promptMessage: `Build the default ${providerLabel} image now?`,
        cancelMessage: "Build-image selection cancelled.",
      });

      if (shouldBuild) {
        const containerfileDir = join(cwd, CONFIG_DIR);
        yield* d.spinner(
          `Building ${providerLabel} image '${imageName}'...`,
          buildImage(imageName, containerfileDir, {
            buildArgs: defaultUidBuildArgs(),
          }),
        );
        yield* d.status("Image built successfully.", "success");
      } else {
        yield* d.status(
          `Run \`${CLI_NAME} ${selectedSandboxProvider.cliNamespace} build-image\` to build the ${providerLabel} image later.`,
          "info",
        );
      }

      const runnerInit = yield* Effect.tryPromise({
        try: () =>
          initializeRepositoryRunner({
            interactive: isInteractive,
            requested:
              installRunnerChoice._tag === "Some"
                ? installRunnerChoice.value
                : undefined,
            confirm: async ({ message, initialValue }) => {
              const confirmed = await clack.confirm({ message, initialValue });
              if (clack.isCancel(confirmed)) {
                throw new InitError({
                  message:
                    "Repository-runner installation selection cancelled.",
                });
              }
              return confirmed === true;
            },
            install: () =>
              Effect.runPromise(
                d.progress("Installing repository runner", (report) =>
                  Effect.tryPromise({
                    try: () =>
                      installRepositoryRunner({
                        repoDir: cwd,
                        onProgress: report,
                      }),
                    catch: (error) =>
                      new InitError({
                        message:
                          error instanceof RunnerInstallError
                            ? error.message
                            : `Repository runner installation failed: ${error instanceof Error ? error.message : String(error)}`,
                      }),
                  }),
                ),
              ),
          }),
        catch: (error) =>
          error instanceof InitError
            ? error
            : new InitError({
                message: `Repository-runner setup failed: ${error instanceof Error ? error.message : String(error)}`,
              }),
      });

      if (runnerInit.status === "installed") {
        yield* d.status(
          `Installed ${runnerInit.result.name} for ${runnerInit.result.repository}.`,
          "success",
        );
        yield* d.text("Repository runner next steps:");
        for (const [index, line] of repositoryRunnerNextSteps().entries()) {
          yield* d.text(styleText("dim", `${index + 1}. ${line}`));
        }
      } else if (runnerInit.status === "failed") {
        yield* d.status(
          `Shipyard scaffolding is ready, but repository runner installation failed: ${runnerInit.message}`,
          "warn",
        );
        yield* d.status(
          `Retry from this repository with \`npx ${CLI_NAME} runner install\`.`,
          "warn",
        );
      }

      yield* d.status("Init complete!", "success");

      const nextSteps = getNextStepsLines();
      for (const [i, line] of nextSteps.entries()) {
        yield* d.text(i === 0 ? line : styleText("dim", line));
      }
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
    runCommand,
    dockerCommand,
    runnerCommand,
  ]),
);

export const cli = Command.run(shipyard, {
  name: CLI_NAME,
  version: VERSION,
});
