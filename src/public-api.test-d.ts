import type { InteractiveOptions } from "./interactive.js";
import type {
  CreateWorktreeOptions,
  WorktreeCreateSandboxOptions,
  WorktreeInteractiveOptions,
  WorktreeRunOptions,
} from "./createWorktree.js";
import type { RunOptions } from "./run.js";

type Assert<T extends true> = T;
type Has<T, K extends PropertyKey> = K extends keyof T ? true : false;
type IsRequired<T, K extends keyof T> =
  object extends Pick<T, K> ? false : true;

type RunOptionsContract = [
  Assert<IsRequired<RunOptions, "agent">>,
  Assert<IsRequired<RunOptions, "sandbox">>,
  Assert<Has<RunOptions, "output">>,
  Assert<Has<RunOptions, "worktree"> extends false ? true : false>,
  Assert<Has<RunOptions, "branch"> extends false ? true : false>,
  Assert<Has<RunOptions, "imageName"> extends false ? true : false>,
];

type InteractiveOptionsContract = [
  Assert<Has<InteractiveOptions, "output"> extends false ? true : false>,
  Assert<
    Has<WorktreeInteractiveOptions, "output"> extends false ? true : false
  >,
  Assert<Has<WorktreeInteractiveOptions, "signal">>,
];

type WorktreeOptionsContract = [
  Assert<
    "head" extends CreateWorktreeOptions["branchStrategy"]["type"]
      ? false
      : true
  >,
  Assert<Has<CreateWorktreeOptions, "signal"> extends false ? true : false>,
  Assert<IsRequired<WorktreeRunOptions, "sandbox">>,
  Assert<Has<WorktreeRunOptions, "signal">>,
  Assert<
    Has<WorktreeCreateSandboxOptions, "branch"> extends false ? true : false
  >,
];
