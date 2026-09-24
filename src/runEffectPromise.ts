import { Cause, Effect, Exit } from "effect";

export const runEffectPromise = async <A, E>(
  effect: Effect.Effect<A, E>,
): Promise<A> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
};
