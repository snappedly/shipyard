import { run } from "../run.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { docker } from "./docker.js";
import { startSandbox } from "../startSandbox.js";
import { syncOut } from "../syncOut.js";
import { shellQuote } from "../shellQuote.js";
import type { IsolatedSandboxHandle } from "../SandboxProvider.js";

const exec = promisify(execFile);
const imageName = process.env.SHIPYARD_TEST_DOCKER_IMAGE;

it.skipIf(!imageName)(
  "docker abort terminates the interactive process inside the container",
  async () => {
    const provider = docker({
      imageName,
      containerUid: 1000,
      containerGid: 1000,
    });
    const handle = (await provider.create({
      hostRepoPath: process.cwd(),
      env: {},
    })) as IsolatedSandboxHandle;
    const marker = `/tmp/shipyard-abort-test-${Date.now()}.pid`;
    const controller = new AbortController();
    try {
      const execution = handle.interactiveExec!(
        [
          "sh",
          "-c",
          `sleep 30 & child=$!; printf '%s %s\\n' "$$" "$child" > ${marker}; wait "$child"`,
        ],
        {
          stdin: process.stdin,
          stdout: process.stdout,
          stderr: process.stderr,
          signal: controller.signal,
        },
      );
      const started = await handle.exec(
        `attempts=0; while [ ! -s ${marker} ] && [ "$attempts" -lt 50 ]; do sleep 0.1; attempts=$((attempts + 1)); done; test -s ${marker}`,
      );
      expect(started.exitCode, started.stderr).toBe(0);

      controller.abort(new Error("test cancellation"));
      await expect(execution).rejects.toThrow("test cancellation");

      const stopped = await handle.exec(
        `read parent child < ${marker}; states=$(ps -o stat= -p "$parent,$child" 2>/dev/null || true); [ -z "$states" ] || ! printf '%s\\n' "$states" | grep -qv '^[[:space:]]*Z'`,
      );
      expect(stopped.exitCode, stopped.stderr).toBe(0);
    } finally {
      await handle.close();
    }
  },
  60_000,
);

// Opt-in real engine checks. The image needs git and /home/agent owned by UID/GID 1000.
it.skipIf(!imageName)(
  "docker isolates Git metadata while syncing ordinary changes",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "shipyard-container-security-"));
    let handle: IsolatedSandboxHandle | undefined;
    try {
      await exec("git", ["init", "-b", "main", root]);
      const git = (...args: string[]) => exec("git", args, { cwd: root });
      await git("config", "user.name", "Security test");
      await git("config", "user.email", "security@example.invalid");
      await writeFile(join(root, "initial.txt"), "initial");
      await git("add", ".");
      await git("commit", "-m", "initial");
      const hostConfig = await readFile(join(root, ".git/config"), "utf8");
      const sentinel = join(root, "host-command-executed");
      const provider = docker({
        imageName,
        containerUid: 1000,
        containerGid: 1000,
      });
      const started = await Effect.runPromise(
        startSandbox({ provider, hostRepoDir: root, env: {} }),
      );
      handle = started.handle as IsolatedSandboxHandle;
      const run = async (command: string) => {
        const result = await handle!.exec(command, {
          cwd: handle!.worktreePath,
        });
        expect(result.exitCode, result.stderr).toBe(0);
        return result.stdout;
      };
      await run(
        `git config user.name 'Security test' && git config user.email security@example.invalid && git config core.fsmonitor ${shellQuote(`touch ${shellQuote(sentinel)}`)}`,
      );
      await run(
        `printf '%s\n' ${shellQuote(`#!/bin/sh\ntouch ${shellQuote(sentinel)}`)} > .git/hooks/post-applypatch && chmod +x .git/hooks/post-applypatch`,
      );
      await run(
        "printf committed > added.txt && git add added.txt && git commit -m added",
      );
      await run(
        "printf dirty > initial.txt && printf untracked > untracked.txt",
      );
      await Effect.runPromise(syncOut(root, handle));
      expect(await readFile(join(root, "added.txt"), "utf8")).toBe("committed");
      expect(await readFile(join(root, "initial.txt"), "utf8")).toBe("dirty");
      expect(await readFile(join(root, "untracked.txt"), "utf8")).toBe(
        "untracked",
      );
      expect(await readFile(join(root, ".git/config"), "utf8")).toBe(
        hostConfig,
      );
      expect(existsSync(join(root, ".git/hooks/post-applypatch"))).toBe(false);
      await git("status", "--porcelain");
      expect(existsSync(sentinel)).toBe(false);
      // Session input files use owner-only permissions; they must remain readable by the agent.
      const session = join(root, "session.jsonl");
      await writeFile(session, "private-session", { mode: 0o600 });
      await handle.copyIn(session, "/home/agent/session.jsonl");
      expect(await run("cat /home/agent/session.jsonl")).toBe(
        "private-session",
      );
    } finally {
      await handle?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
it.skipIf(!imageName)(
  "docker runs the default merge strategy and removes its temporary branch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "shipyard-container-run-"));
    try {
      await exec("git", ["init", "-b", "main", root]);
      const git = (...args: string[]) => exec("git", args, { cwd: root });
      await git("config", "user.name", "Security test");
      await git("config", "user.email", "security@example.invalid");
      await writeFile(join(root, "initial.txt"), "initial");
      await git("add", ".");
      await git("commit", "-m", "initial");
      const result = await run({
        cwd: root,
        sandbox: docker({
          imageName,
          containerUid: 1000,
          containerGid: 1000,
        }),
        agent: {
          name: "fixture",
          env: {},
          captureSessions: false,
          buildPrintCommand: () => ({
            command:
              "printf changed > added.txt && git add added.txt && git commit -m added && printf done",
          }),
          parseStreamLine: (text) => [{ type: "text", text }],
        },
        prompt: "make a change",
        maxIterations: 1,
        logging: { type: "file", path: join(root, "run.log") },
      });
      expect(result.commits).toHaveLength(1);
      expect(await readFile(join(root, "added.txt"), "utf8")).toBe("changed");
      expect(
        (await git("branch", "--format=%(refname:short)")).stdout.trim(),
      ).toBe("main");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
