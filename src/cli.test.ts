import { exec } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { cli } from "./cli.js";
import { ClackDisplay, type DisplayEntry, SilentDisplay } from "./Display.js";

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

const cliPath = join(import.meta.dirname, "..", "dist", "main.js");
const cliTestTimeoutMs = 15_000;

const runCli = async (args: string, cwd: string, env?: NodeJS.ProcessEnv) => {
  const runEnv = { ...process.env, ...env };
  if (
    (args === "init" || args.startsWith("init ")) &&
    !args.includes("--help")
  ) {
    const binDir = join(cwd, ".shipyard-cli-test-bin");
    await mkdir(binDir, { recursive: true });
    const dockerArgsFile = join(cwd, ".shipyard-cli-docker-args");
    await writeFile(
      join(binDir, "docker"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SHIPYARD_TEST_DOCKER_ARGS"\n',
      { mode: 0o755 },
    );
    runEnv.PATH = `${binDir}:${runEnv.PATH ?? ""}`;
    runEnv.SHIPYARD_TEST_DOCKER_ARGS = dockerArgsFile;
  }
  return execAsync(`node ${cliPath} ${args}`, { cwd, env: runEnv });
};

// CLI validation checks do not need a packaged-process boundary. Keeping them
// in-process avoids a flaky child-process wait under CI.
const cliTestLayer = Layer.merge(NodeContext.layer, ClackDisplay.layer);

const runCliInProcess = (args: ReadonlyArray<string>) =>
  Effect.runPromiseExit(
    cli(["node", "shipyard", ...args]).pipe(Effect.provide(cliTestLayer)),
  );

const runCliInProcessAt = async (
  args: ReadonlyArray<string>,
  cwd: string,
  displayRef?: Ref.Ref<ReadonlyArray<DisplayEntry>>,
) => {
  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    return displayRef === undefined
      ? await runCliInProcess(args)
      : await Effect.runPromiseExit(
          cli(["node", "shipyard", ...args]).pipe(
            Effect.provide(
              Layer.merge(NodeContext.layer, SilentDisplay.layer(displayRef)),
            ),
          ),
        );
  } finally {
    process.chdir(previousCwd);
  }
};

describe("shipyard CLI", { timeout: cliTestTimeoutMs }, () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("shipyard");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
    expect(stdout).toContain("runner install");
    expect(stdout).not.toContain("interactive");
    // build-image and remove-image are namespaced under docker, not top-level
    expect(stdout).toContain("docker build-image");
    expect(stdout).toContain("docker remove-image");
    // Old command names should not be exposed
    expect(stdout).not.toContain("setup-sandbox");
    expect(stdout).not.toContain("cleanup-sandbox");
    expect(stdout).not.toContain("sync-in");
    expect(stdout).not.toContain("sync-out");
  });

  it("runner --help exposes foreground lifecycle commands", async () => {
    const { stdout } = await runCli("runner --help", process.cwd());
    expect(stdout).toContain("install");
    expect(stdout).toContain("start");
    expect(stdout).toContain("status");
    expect(stdout).toContain("stop");
    expect(stdout).toContain("remove");
    expect(stdout).toContain("purge");
  });

  it("runner purge removes all default run logs regardless of age", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-log-purge-"));
    const logsDir = join(hostDir, ".shipyard", "logs");
    await mkdir(join(logsDir, "2000-01-01"), { recursive: true });
    await mkdir(join(logsDir, "2099-12-31"), { recursive: true });
    await writeFile(join(logsDir, "audit.log"), "root-level run log");
    await writeFile(join(logsDir, "notes.txt"), "operator notes");
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

    const result = await runCliInProcessAt(
      ["runner", "purge"],
      hostDir,
      displayRef,
    );

    expect(Exit.isSuccess(result)).toBe(true);
    await expect(readdir(logsDir)).resolves.not.toContain("2000-01-01");
    await expect(readdir(logsDir)).resolves.not.toContain("2099-12-31");
    await expect(readdir(logsDir)).resolves.not.toContain("audit.log");
    await expect(readdir(logsDir)).resolves.toContain("notes.txt");
    expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual({
      _tag: "status",
      message: "Purged 3 run-log entries.",
      severity: "success",
    });
  });

  it("runner remove --help exposes explicit forced local removal", async () => {
    const { stdout } = await runCli("runner remove --help", process.cwd());
    expect(stdout).toContain("--force");
    expect(stdout).toContain("GitHub");
  });

  it("runner install --help exposes one-time registration token input", async () => {
    const { stdout } = await runCli("runner install --help", process.cwd());
    expect(stdout).toContain("--registration-token");
    expect(stdout).toContain("one-time");
  });

  it("docker --help shows build-image and remove-image subcommands", async () => {
    const { stdout } = await runCli("docker --help", process.cwd());
    expect(stdout).toContain("build-image");
    expect(stdout).toContain("remove-image");
  });

  it("docker build-image errors when .shipyard/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    try {
      await runCli("docker build-image", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .shipyard/ found");
    }
  });

  it("run errors when .shipyard/ is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const result = await runCliInProcessAt(["run", "--skip-build"], hostDir);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain("No .shipyard/ found");
    }
  });

  it("run errors when the generated entrypoint is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    await mkdir(join(hostDir, ".shipyard"));

    const result = await runCliInProcessAt(["run", "--skip-build"], hostDir);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const output = Cause.pretty(result.cause);
      expect(output).toContain("No Shipyard entrypoint found");
      expect(output).toContain("main.ts");
      expect(output).toContain("main.mts");
    }
  });

  it("run applies automatic log retention before resolving the entrypoint", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-log-retention-"));
    const logsDir = join(hostDir, ".shipyard", "logs");
    await mkdir(join(logsDir, "2000-01-01"), { recursive: true });
    const rootLog = join(logsDir, "audit.log");
    await writeFile(rootLog, "root-level run log");
    await utimes(rootLog, new Date(2000, 0, 1), new Date(2000, 0, 1));
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

    const result = await runCliInProcessAt(
      ["run", "--skip-build"],
      hostDir,
      displayRef,
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        "No Shipyard entrypoint found",
      );
    }
    await expect(readdir(logsDir)).resolves.not.toContain("2000-01-01");
    await expect(readdir(logsDir)).resolves.not.toContain("audit.log");
    expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual({
      _tag: "status",
      message: "Purged 2 outdated run-log entries.",
      severity: "info",
    });
  });

  it("run continues when automatic log retention fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-log-retention-error-"));
    const configDir = join(hostDir, ".shipyard");
    await mkdir(configDir);
    await writeFile(join(configDir, "logs"), "not a directory");
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

    const result = await runCliInProcessAt(
      ["run", "--skip-build"],
      hostDir,
      displayRef,
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        "No Shipyard entrypoint found",
      );
    }
    expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual({
      _tag: "status",
      message: expect.stringContaining("Automatic run-log purge skipped"),
      severity: "warn",
    });
  });

  it.skipIf(process.platform === "win32")(
    "run builds the detected Docker image and executes the generated entrypoint",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
      await initRepo(hostDir);
      await commitFile(hostDir, "hello.txt", "hello", "initial commit");
      const configDir = join(hostDir, ".shipyard");
      const binDir = join(hostDir, "bin");
      await mkdir(configDir);
      await mkdir(binDir);
      await writeFile(join(configDir, "Dockerfile"), "FROM node:22\n");
      await writeFile(join(configDir, "main.mts"), "console.log('test');\n");

      const dockerArgsFile = join(hostDir, "docker-args.txt");
      const npxArgsFile = join(hostDir, "npx-args.txt");
      await writeFile(
        join(binDir, "docker"),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$DOCKER_ARGS_FILE"\n',
        { mode: 0o755 },
      );
      await writeFile(
        join(binDir, "npx"),
        '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$NPX_ARGS_FILE"\n',
        { mode: 0o755 },
      );

      const { stdout } = await runCli("run", hostDir, {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        DOCKER_ARGS_FILE: dockerArgsFile,
        NPX_ARGS_FILE: npxArgsFile,
      });

      expect(stdout).toContain("Building Docker image");
      expect(stdout).toContain("Running .shipyard/main.mts");
      expect(await readFile(dockerArgsFile, "utf8")).toContain("build -t");
      expect(await readFile(npxArgsFile, "utf8")).toContain("--no-install tsx");
      expect(await readFile(npxArgsFile, "utf8")).toContain(
        join(configDir, "main.mts"),
      );
    },
  );

  it("init --help shows --template flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--template");
  });

  it("init --help exposes --agent flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--agent");
  });

  it("init --help exposes --codex-auth flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--codex-auth");
    expect(stdout).toContain("ChatGPT subscription");
  });

  it("init --help exposes --model flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--model");
  });

  it("init --help exposes --sandbox flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--sandbox");
  });

  it("init --sandbox nonexistent produces error listing available providers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --sandbox nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("docker");
      expect(output).not.toContain("podman");
    }
  });

  it("init --template nonexistent produces error listing available templates", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const result = await runCliInProcessAt(
      ["init", "--agent", "claude-code", "--template", "nonexistent"],
      hostDir,
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const output = Cause.pretty(result.cause);
      expect(output).toContain("nonexistent");
      expect(output).toContain("simple-loop");
      expect(output).not.toContain("Available: blank");
    }
  });

  it("init rejects the removed blank template", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    const result = await runCliInProcessAt(
      ["init", "--template", "blank"],
      hostDir,
    );

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const output = Cause.pretty(result.cause);
      expect(output).toContain('Unknown template "blank"');
      expect(output).toContain("Available: simple-loop");
    }
  });

  it("old top-level build-image command no longer works", async () => {
    const result = await runCliInProcess(["build-image"]);

    expect(Exit.isFailure(result)).toBe(true);
  });

  it("old top-level remove-image command no longer works", async () => {
    const result = await runCliInProcess(["remove-image"]);

    expect(Exit.isFailure(result)).toBe(true);
  });

  it("--help does not show a podman namespace", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).not.toContain("podman");
  });

  it("init --agent nonexistent produces error listing available agents", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("claude-code");
    }
  });

  it("init --help omits fixed setup choices", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).not.toContain("--issue-tracker");
    expect(stdout).not.toContain("--build-image");
    expect(stdout).not.toContain("--install-runner");
  });

  it.each([
    ["--issue-tracker", "github-issues"],
    ["--build-image", "false"],
    ["--install-runner", "false"],
  ])("init rejects the removed %s option", async (flag, value) => {
    const result = await runCliInProcess(["init", flag!, value!]);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(flag);
    }
  });

  it("init --help does not expose the obsolete --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).not.toContain("--create-label");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("fails init when automatic runner installation fails", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // This repo has no origin remote or GitHub runner setup, so init must stop
    // after scaffolding instead of reporting completion.
    const failure = await runCli(
      "init --agent claude-code --template simple-loop",
      hostDir,
    ).catch((error: Error & { stdout: string; stderr: string }) => error);

    expect(failure).toBeInstanceOf(Error);
    const output = failure.stdout + failure.stderr;
    expect(output).toContain("Repository runner installation failed");
    expect(output).toContain("Init is incomplete");
    expect(output).not.toContain("Init complete");
    expect(
      await readFile(join(hostDir, ".shipyard-cli-docker-args"), "utf8"),
    ).toContain("build -t");
    const entries = await readdir(join(hostDir, ".shipyard"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
    expect(
      await readFile(join(hostDir, ".shipyard", "Dockerfile"), "utf8"),
    ).toContain("GitHub CLI");
    expect(
      await readFile(join(hostDir, ".shipyard", ".env.example"), "utf8"),
    ).toContain("GH_TOKEN=");
    expect(
      await readdir(join(hostDir, ".github", "workflows")).catch(() => []),
    ).not.toContain("shipyard-wake.yml");
  });

  it("init advances one progress bar across setup stages", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-init-progress-"));
    await initRepo(hostDir);
    const binDir = join(hostDir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "docker"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    await writeFile(join(binDir, "gh"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });

    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    let result: Awaited<ReturnType<typeof runCliInProcessAt>>;
    try {
      result = await runCliInProcessAt(
        [
          "init",
          "--agent",
          "claude-code",
          "--template",
          "simple-loop",
          "--commit-setup",
          "false",
        ],
        hostDir,
        displayRef,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain(
        "Repository runner installation failed",
      );
    }
    const entries = await Ref.get(displayRef).pipe(Effect.runPromise);
    const progressEntries = entries.filter(
      (entry): entry is Extract<DisplayEntry, { _tag: "progress" }> =>
        entry._tag === "progress",
    );
    expect(progressEntries).toHaveLength(1);
    const updates = progressEntries[0]!.updates;
    expect(updates[0]).toMatchObject({
      current: 6,
      total: 100,
      message: "Selected Claude Code",
    });
    expect(updates.at(-1)!.current).toBeLessThan(100);
    expect(updates.at(-1)!.message).toBe("Installing repository runner");
    expect(updates.map(({ current }) => current)).toEqual(
      [...updates.map(({ current }) => current)].sort((a, b) => a - b),
    );
    expect(updates.map(({ message }) => message)).toContain(
      "Selected simple-loop template",
    );
    expect(updates.map(({ message }) => message)).toContain(
      "Docker image built",
    );
  });

  it("init requires --codex-auth for Codex in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --agent codex --template simple-loop", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--codex-auth");
    }
  });

  it("init scaffolds Codex ChatGPT auth before reporting runner failure", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const isolatedHome = join(hostDir, "home");
    await mkdir(join(isolatedHome, ".codex"), { recursive: true });
    await writeFile(join(isolatedHome, ".codex", "auth.json"), "{}\n");

    const failure = await runCli(
      "init --agent codex --codex-auth chatgpt --template simple-loop",
      hostDir,
      { HOME: isolatedHome },
    ).catch((error: Error & { stdout: string; stderr: string }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.stdout + failure.stderr).toContain(
      "Repository runner installation failed",
    );

    const main = await readFile(
      join(hostDir, ".shipyard", "main.mts"),
      "utf-8",
    );
    const envExample = await readFile(
      join(hostDir, ".shipyard", ".env.example"),
      "utf-8",
    );
    expect(main).toContain('hostPath: "~/.codex/auth.json"');
    expect(envExample).not.toContain("OPENAI_API_KEY=");
  });

  it("init --codex-auth chatgpt fails clearly without an auth cache in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const isolatedHome = join(hostDir, "home");
    await mkdir(isolatedHome, { recursive: true });

    let error: unknown;
    try {
      await runCli(
        "init --agent codex --codex-auth chatgpt --template simple-loop",
        hostDir,
        { HOME: isolatedHome },
      );
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeDefined();
    const { stdout, stderr } = error as { stdout: string; stderr: string };
    const output = stdout + stderr;
    expect(output).toContain("~/.codex/auth.json");
    expect(output).toContain("codex login");
    expect(output).toContain("non-interactive");
  });

  it("init without --agent fails fast with a clear non-interactive error message", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --template simple-loop --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init creates the five Shipyard issue labels", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const binDir = join(hostDir, "bin");
    const ghArgsFile = join(hostDir, "gh-args.txt");
    await mkdir(binDir);
    await writeFile(
      join(binDir, "gh"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$GH_ARGS_FILE"\n',
      { mode: 0o755 },
    );

    const failure = await runCli(
      "init --agent claude-code --template simple-loop",
      hostDir,
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_ARGS_FILE: ghArgsFile,
      },
    ).catch((error: Error & { stdout: string; stderr: string }) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure.stdout + failure.stderr).toContain(
      "Repository runner installation failed",
    );
    expect(failure.stdout + failure.stderr).not.toContain("Init complete");
    const commands = await readFile(ghArgsFile, "utf8");
    for (const label of [
      "shipyard",
      "bug",
      "enhancement",
      "needs-triage",
      "needs-info",
      "ready-for-agent",
      "ready-for-human",
      "wontfix",
      "shipyard:blocked",
      "shipyard:pending",
      "shipyard:complete",
      "shipyard:outstanding-tasks",
    ])
      expect(commands).toContain(`label create ${label} `);
  });

  it("init can scaffold when GitHub label provisioning is unavailable", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const binDir = join(hostDir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "gh"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    const failure = await runCli(
      "init --agent claude-code --template simple-loop",
      hostDir,
      { PATH: `${binDir}:${process.env.PATH ?? ""}`, GH_REPO: "" },
    ).catch((error: Error & { stdout: string; stderr: string }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.stdout + failure.stderr).toContain(
      "Repository runner installation failed",
    );
    expect(failure.stdout + failure.stderr).not.toContain("Init complete");
    expect(await readdir(join(hostDir, ".shipyard"))).toContain("Dockerfile");
  });

  it("init reports label provisioning failure for a connected repository", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    await execAsync("git remote add origin https://github.com/owner/repo.git", {
      cwd: hostDir,
    });
    const binDir = join(hostDir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "gh"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });

    const failure = await runCli(
      "init --agent claude-code --template simple-loop",
      hostDir,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    ).catch((error: Error & { stdout: string; stderr: string }) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure.stdout + failure.stderr).toContain(
      "Could not create GitHub labels",
    );
    expect(failure.stdout).not.toContain("Init complete");
  });
});
