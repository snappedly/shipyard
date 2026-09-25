import { Effect, Layer } from "effect";
import { agentStreamEmitterLayer } from "./AgentStreamEmitter.js";
import { Display } from "./Display.js";
import { CLI_NAME } from "./runtimeNames.js";
import {
  SandboxFactory,
  type SandboxInfo,
  type SandboxService,
} from "./SandboxFactory.js";
import {
  orchestrate,
  type OrchestrateOptions,
  type OrchestrateResult,
} from "./Orchestrator.js";
import type { SandboxError } from "./errors.js";
import {
  buildAgentStreamHandler,
  buildCompletionMessage,
  buildContextWindowLines,
  type LoggingOption,
} from "./run.js";

export interface RunInExistingSandboxOptions {
  readonly orchestration: OrchestrateOptions;
  readonly sandboxInfo: SandboxInfo;
  readonly sandbox: SandboxService;
  readonly logging: LoggingOption;
}

/** Run the common orchestration path against a sandbox that is already open. */
export const runInExistingSandbox = (
  options: RunInExistingSandboxOptions,
): Effect.Effect<OrchestrateResult, SandboxError, Display> => {
  const sandboxFactory = Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      makeEffect: (
        info: SandboxInfo,
        sandbox: SandboxService,
      ) => Effect.Effect<A, E, R>,
    ) =>
      makeEffect(options.sandboxInfo, options.sandbox).pipe(
        Effect.map((value) => ({ value })),
      ),
  });
  const runLayers = Layer.mergeAll(
    sandboxFactory,
    agentStreamEmitterLayer(buildAgentStreamHandler(options.logging)),
  );

  return Effect.gen(function* () {
    const display = yield* Display;
    const orchestration = options.orchestration;
    yield* display.intro(orchestration.name ?? CLI_NAME);

    const result = yield* orchestrate(orchestration);
    const completion = buildCompletionMessage(
      result.completionSignal,
      result.iterations.length,
    );
    yield* display.status(completion.message, completion.severity);

    for (const line of buildContextWindowLines(result.iterations)) {
      yield* display.text(line);
    }

    return result;
  }).pipe(Effect.provide(runLayers));
};
