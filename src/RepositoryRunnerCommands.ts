import { Command, Options } from "@effect/cli";
import { Effect } from "effect";
import { Display } from "./Display.js";
import { InitError } from "./errors.js";
import {
  installRepositoryRunner,
  RunnerInstallError,
} from "./RepositoryRunner.js";
import {
  getRepositoryRunnerStatus,
  RunnerControlError,
  startRepositoryRunner,
  stopRepositoryRunner,
} from "./RepositoryRunnerControl.js";
import {
  removeRepositoryRunner,
  RunnerLifecycleError,
} from "./RepositoryRunnerLifecycle.js";

const registrationTokenOption = Options.text("registration-token").pipe(
  Options.withDescription(
    "one-time GitHub repository runner registration token (not stored)",
  ),
  Options.optional,
);

const installRunnerCommand = Command.make(
  "install",
  { registrationToken: registrationTokenOption },
  ({ registrationToken }) =>
    Effect.gen(function* () {
      const display = yield* Display;
      const result = yield* display.spinner(
        "Installing repository runner...",
        Effect.tryPromise({
          try: () =>
            installRepositoryRunner({
              repoDir: process.cwd(),
              registrationToken:
                registrationToken._tag === "Some"
                  ? registrationToken.value
                  : undefined,
            }),
          catch: (error) =>
            new InitError({
              message:
                error instanceof RunnerInstallError
                  ? error.message
                  : `Repository runner installation failed: ${error instanceof Error ? error.message : String(error)}`,
            }),
        }),
      );
      yield* display.status(
        `Installed ${result.name} for ${result.repository}.`,
        "success",
      );
    }),
);

const runnerControlEffect = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: (error) =>
      new InitError({
        message:
          error instanceof RunnerControlError ||
          error instanceof RunnerLifecycleError
            ? error.message
            : `Repository runner operation failed: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const startRunnerCommand = Command.make("start", {}, () =>
  Effect.gen(function* () {
    const display = yield* Display;
    const cwd = process.cwd();
    yield* display.status(
      "Starting the repository runner in this terminal...",
      "info",
    );
    const result = yield* runnerControlEffect(() =>
      startRepositoryRunner({ repoDir: cwd }),
    );
    yield* display.status(
      result.initialWorkFound
        ? `Repository runner for ${result.repository} stopped after processing startup work.`
        : `Repository runner for ${result.repository} stopped.`,
      "info",
    );
  }),
);

const statusRunnerCommand = Command.make("status", {}, () =>
  Effect.gen(function* () {
    const display = yield* Display;
    const status = yield* runnerControlEffect(() =>
      getRepositoryRunnerStatus({ repoDir: process.cwd() }),
    );
    yield* display.summary("Repository runner", {
      Installed: status.installed ? "yes" : "no",
      "Local process": status.running
        ? `running (PID ${status.pid ?? "unknown"})`
        : "stopped",
      GitHub: status.github,
      Repository: status.repository ?? "unknown",
      State: status.state,
      "Last outcome": status.lastOutcome,
    });
  }),
);

const stopRunnerCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const display = yield* Display;
    const result = yield* runnerControlEffect(() =>
      stopRepositoryRunner({ repoDir: process.cwd() }),
    );
    yield* display.status(
      `Stopping repository runner process ${result.pid}...`,
      "success",
    );
  }),
);

const forceRemoveRunnerOption = Options.boolean("force").pipe(
  Options.withDescription(
    "delete local runner files if GitHub unregistration fails",
  ),
);

const removeRunnerCommand = Command.make(
  "remove",
  { force: forceRemoveRunnerOption },
  ({ force }) =>
    Effect.gen(function* () {
      const display = yield* Display;
      const result = yield* runnerControlEffect(() =>
        removeRepositoryRunner({ repoDir: process.cwd(), force }),
      );
      yield* display.status("Repository runner removed.", "success");
      if (result.manualCleanup) {
        yield* display.status(result.manualCleanup, "warn");
      }
    }),
);

export const runnerCommand = Command.make("runner", {}, () =>
  Effect.gen(function* () {
    const display = yield* Display;
    yield* display.status(
      "Repository runner commands. Use --help to see available subcommands.",
      "info",
    );
  }),
).pipe(
  Command.withSubcommands([
    installRunnerCommand,
    startRunnerCommand,
    statusRunnerCommand,
    stopRunnerCommand,
    removeRunnerCommand,
  ]),
);
