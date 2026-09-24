import { Duration, Effect, Exit, TestClock, TestContext } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { exec } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
} from "./SandboxProvider.js";
import { startSandbox, COPY_PATHS_TIMEOUT_MS } from "./startSandbox.js";
import { testIsolated } from "./sandboxes/test-isolated.js";
import { CopyToWorktreeTimeoutError } from "./errors.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

describe("startSandbox", () => {
  describe("isolated provider", () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
      await Promise.all(
        tempDirs.map((d) => rm(d, { recursive: true, force: true })),
      );
      tempDirs.length = 0;
    });

    it("creates handle, syncs repo, and returns sandboxLayer", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "shipyard-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello world", "initial");

      const provider = testIsolated();
      const { handle, sandbox, worktreePath } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
        }),
      );

      // Verify the repo was synced - hello.txt should exist
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* sandbox.exec("cat hello.txt");
        }),
      );

      expect(result.stdout.trim()).toBe("hello world");
      expect(worktreePath).toBeDefined();
      await handle.close();
    });

    it("copies copyPaths into the sandbox after sync", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "shipyard-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "extra.txt"), "extra content");

      const provider = testIsolated();
      const { handle, sandbox } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          copyPaths: ["extra.txt"],
        }),
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* sandbox.exec("cat extra.txt");
        }),
      );

      expect(result.stdout.trim()).toBe("extra content");
      await handle.close();
    });

    it("rejects protected runner paths before isolated copy-in", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "shipyard-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await mkdir(join(hostDir, ".shipyard", "runner"), { recursive: true });
      await writeFile(
        join(hostDir, ".shipyard", "runner", ".credentials"),
        "secret",
      );

      const provider = testIsolated();
      const exit = await Effect.runPromiseExit(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          sourceRepoDir: hostDir,
          env: {},
          copyPaths: [".shipyard"],
        }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        expect(exit.cause.error.message).toContain("repository runner");
      }
    });

    it("times out when copyIn hangs", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "shipyard-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");
      await writeFile(join(hostDir, "hang.txt"), "will hang");

      const realProvider = testIsolated();
      const hangingProvider = createIsolatedSandboxProvider({
        name: "hanging-copy",
        create: async (options) => {
          const handle = await realProvider.create(options);
          return {
            ...handle,
            copyIn: (hostPath: string, sandboxPath: string) => {
              // Allow syncIn's copyIn calls (bundle files) to succeed,
              // but hang on everything else
              if (sandboxPath.includes("repo.bundle")) {
                return handle.copyIn(hostPath, sandboxPath);
              }
              return new Promise<void>(() => {}); // never resolves
            },
          };
        },
      });

      // Fork startSandbox and advance the TestClock after syncIn completes.
      // Container create and syncIn use real promises that resolve in real time.
      // With TestClock, their withTimeout timers won't fire until we advance,
      // so they complete successfully. Then we advance past COPY_PATHS_TIMEOUT_MS.
      const program = Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          startSandbox({
            provider: hangingProvider,
            hostRepoDir: hostDir,
            env: {},
            copyPaths: ["hang.txt"],
          }),
        );
        // Yield to allow real async operations (create, syncIn) to complete
        yield* Effect.yieldNow();
        yield* Effect.promise(() => new Promise((r) => setTimeout(r, 2000)));
        yield* Effect.yieldNow();
        // Now advance past the copyPaths timeout
        yield* TestClock.adjust(Duration.millis(COPY_PATHS_TIMEOUT_MS + 1));
        return yield* fiber.await;
      }).pipe(Effect.provide(TestContext.TestContext));

      const exit = await Effect.runPromise(program);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit) && exit.cause._tag === "Fail") {
        const error = exit.cause.error;
        expect(error).toBeInstanceOf(CopyToWorktreeTimeoutError);
        const timeoutError = error as CopyToWorktreeTimeoutError;
        expect(timeoutError.timeoutMs).toBe(COPY_PATHS_TIMEOUT_MS);
        expect(timeoutError.paths).toEqual(["hang.txt"]);
      } else {
        throw new Error("Expected Fail cause");
      }
    }, 15_000);

    it("skips missing copyPaths without error", async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "shipyard-test-"));
      tempDirs.push(hostDir);
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial");

      const provider = testIsolated();
      const { handle } = await Effect.runPromise(
        startSandbox({
          provider,
          hostRepoDir: hostDir,
          env: {},
          copyPaths: ["nonexistent.txt"],
        }),
      );

      await handle.close();
    });
  });
});

it("closes an isolated sandbox if repository initialization fails", async () => {
  const close = vi.fn(async () => {});
  const provider = createIsolatedSandboxProvider({
    name: "failed-sync",
    create: async () => ({
      worktreePath: "/workspace",
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      copyIn: async () => {},
      copyFileOut: async () => {},
      close,
    }),
  });
  await expect(
    Effect.runPromise(
      startSandbox({
        provider,
        hostRepoDir: "/nonexistent/shipyard-repo",
        env: {},
      }),
    ),
  ).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
});

it("copies configured paths from the original repository when syncing a worktree", async () => {
  const root = await mkdtemp(join(tmpdir(), "shipyard-copy-source-"));
  const worktree = join(root, "worktree");
  const repo = join(root, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repo);
  let handle: IsolatedSandboxHandle | undefined;
  try {
    await initRepo(repo);
    await commitFile(repo, "initial.txt", "initial", "initial");
    await execAsync(`git worktree add -b agent "${worktree}"`, { cwd: repo });
    await writeFile(join(repo, "extra.txt"), "from-original");
    const result = await Effect.runPromise(
      startSandbox({
        provider: testIsolated(),
        hostRepoDir: worktree,
        sourceRepoDir: repo,
        env: {},
        copyPaths: ["extra.txt"],
      }),
    );
    handle = result.handle as IsolatedSandboxHandle;
    const copied = await handle.exec("cat extra.txt", {
      cwd: handle.worktreePath,
    });
    expect(copied.stdout).toBe("from-original");
  } finally {
    await handle?.close();
    await rm(root, { recursive: true, force: true });
  }
});
