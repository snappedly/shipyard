import { Effect } from "effect";
import { Display } from "./Display.js";
import { PromptError } from "./errors.js";
import {
  BUILT_IN_PROMPT_ARG_KEYS,
  findMissingPromptArgKeys,
  substitutePromptArgs,
  validateNoArgsWithInlinePrompt,
  validateNoBuiltInArgOverride,
  type PromptArgs,
} from "./PromptArgumentSubstitution.js";
import type { ResolvedPrompt } from "./PromptResolver.js";

export interface PreparePromptOptions {
  readonly resolved?: ResolvedPrompt;
  readonly promptArgs?: PromptArgs;
  readonly sourceBranch?: string;
  readonly targetBranch?: string;
  readonly resolveMissing?: (
    keys: readonly string[],
  ) => Effect.Effect<PromptArgs, Error>;
}

export interface PreparedPrompt {
  readonly source: ResolvedPrompt["source"] | "none";
  readonly sourceText: string;
  readonly text: string;
  readonly expandsShellExpressions: boolean;
}

const noPrompt: PreparedPrompt = {
  source: "none",
  sourceText: "",
  text: "",
  expandsShellExpressions: false,
};

/** Apply the shared inline/template rules and built-in branch arguments. */
export const preparePrompt = (
  options: PreparePromptOptions,
): Effect.Effect<PreparedPrompt, PromptError | Error, Display> => {
  const resolved = options.resolved;
  if (resolved === undefined) return Effect.succeed(noPrompt);

  const sourceText = resolved.text;
  if (resolved.source === "inline") {
    return Effect.as(validateNoArgsWithInlinePrompt(options.promptArgs ?? {}), {
      source: "inline",
      sourceText,
      text: sourceText,
      expandsShellExpressions: false,
    });
  }

  const userArgs = options.promptArgs ?? {};
  return Effect.gen(function* () {
    yield* validateNoBuiltInArgOverride(userArgs);
    const missing = findMissingPromptArgKeys(sourceText, userArgs);
    const collected =
      missing.length > 0 && options.resolveMissing !== undefined
        ? yield* options.resolveMissing(missing)
        : {};
    const args: PromptArgs = {
      ...(options.sourceBranch === undefined
        ? {}
        : { SOURCE_BRANCH: options.sourceBranch }),
      ...(options.targetBranch === undefined
        ? {}
        : { TARGET_BRANCH: options.targetBranch }),
      ...userArgs,
      ...collected,
    };
    const text = yield* substitutePromptArgs(
      sourceText,
      args,
      new Set<string>(BUILT_IN_PROMPT_ARG_KEYS),
    );
    return {
      source: "template" as const,
      sourceText,
      text,
      expandsShellExpressions: true,
    };
  });
};
