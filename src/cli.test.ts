import { exec } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { NodeContext } from "@effect/platform-node";
import { Cause, Effect, Exit, Layer, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { cli } from "./cli.js";
import { ClackDisplay, type DisplayEntry, SilentDisplay } from "./Display.js";
import { REPOSITORY_RUNNER_WORKFLOW } from "./RepositoryRunnerWake.js";
import { RUNNER_INSTALL_METADATA } from "./RepositoryRunnerLifecycle.js";

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

const runCli = (args: string, cwd: string, env?: NodeJS.ProcessEnv) =>
  execAsync(`node ${cliPath} ${args}`, {
    cwd,
    env: { ...process.env, ...env },
  });

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

const withEnvironment = async <A>(
  changes: NodeJS.ProcessEnv,
  operation: () => Promise<A>,
): Promise<A> => {
  const previous = new Map(
    Object.keys(changes).map((key) => [key, process.env[key]] as const),
  );
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const writePosixCommand = async (path: string, source: string) => {
  await writeFile(path, `#!/usr/bin/env node\n${source}\n`);
  await chmod(path, 0o755);
};

const createRunnerUninstallFixture = async (hostDir: string) => {
  const configDir = join(hostDir, ".shipyard");
  const runnerDir = join(configDir, "runner");
  const workflowPath = join(
    hostDir,
    ".github",
    "workflows",
    "shipyard-wake.yml",
  );
  await Promise.all([
    mkdir(runnerDir, { recursive: true }),
    mkdir(join(hostDir, ".github", "workflows"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(configDir, "main.ts"), "export {};\n"),
    writeFile(join(configDir, ".env"), "GH_TOKEN=keep-me\n"),
    writeFile(
      join(runnerDir, RUNNER_INSTALL_METADATA),
      `${JSON.stringify({
        schemaVersion: 1,
        repository: "owner/repo",
        repositoryUrl: "https://github.com/owner/repo",
        name: "shipyard-owner-repo-test",
        label: "shipyard",
        version: "2.331.0",
      })}\n`,
    ),
    writeFile(workflowPath, REPOSITORY_RUNNER_WORKFLOW),
    writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({
        packageManager: "npm@12.0.2",
        devDependencies: { "@snappedly-tools/shipyard": "^0.7.0" },
      }),
    ),
  ]);
  return { configDir, runnerDir, workflowPath };
};

describe("shipyard CLI", { timeout: cliTestTimeoutMs }, () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("shipyard");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("uninstall");
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

  it("uninstall --help explains confirmation and forced runner cleanup", async () => {
    const { stdout } = await runCli("uninstall --help", process.cwd());
    expect(stdout).toContain("--yes");
    expect(stdout).toContain("--force");
    expect(stdout).toContain("GitHub unregistration");
  });

  it("uninstall requires confirmation before changing repository files", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-uninstall-confirm-"));
    const configDir = join(hostDir, ".shipyard");
    await mkdir(configDir);
    await writeFile(join(configDir, "main.ts"), "export {};\n");

    const result = await runCliInProcessAt(["uninstall"], hostDir);

    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      expect(Cause.pretty(result.cause)).toContain("pass --yes");
    }
    await expect(readFile(join(configDir, "main.ts"), "utf8")).resolves.toBe(
      "export {};\n",
    );
  });

  it("uninstall removes generated setup and preserves secrets and runtime data", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-uninstall-"));
    const configDir = join(hostDir, ".shipyard");
    const logsDir = join(configDir, "logs");
    const worktreeDir = join(configDir, "worktrees", "active-task");
    const workflowPath = join(
      hostDir,
      ".github",
      "workflows",
      "shipyard-wake.yml",
    );
    await Promise.all([
      mkdir(logsDir, { recursive: true }),
      mkdir(worktreeDir, { recursive: true }),
      mkdir(join(hostDir, ".github", "workflows"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(configDir, "main.ts"), "export {};\n"),
      writeFile(join(configDir, ".env"), "GH_TOKEN=keep-me\n"),
      writeFile(join(logsDir, "run.log"), "evidence"),
      writeFile(join(worktreeDir, "uncommitted.txt"), "work"),
      writeFile(workflowPath, REPOSITORY_RUNNER_WORKFLOW),
    ]);
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

    const result = await runCliInProcessAt(
      ["uninstall", "--yes"],
      hostDir,
      displayRef,
    );

    expect(Exit.isSuccess(result)).toBe(true);
    await expect(
      readFile(join(configDir, "main.ts"), "utf8"),
    ).rejects.toThrow();
    await expect(readFile(join(configDir, ".env"), "utf8")).resolves.toBe(
      "GH_TOKEN=keep-me\n",
    );
    await expect(readFile(join(logsDir, "run.log"), "utf8")).resolves.toBe(
      "evidence",
    );
    await expect(
      readFile(join(worktreeDir, "uncommitted.txt"), "utf8"),
    ).resolves.toBe("work");
    await expect(readFile(workflowPath, "utf8")).rejects.toThrow();
    expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual({
      _tag: "status",
      message: "Shipyard uninstalled from this repository.",
      severity: "success",
    });
  });

  it("uninstall removes the declared Shipyard package with the detected manager", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-uninstall-package-"));
    const binDir = join(hostDir, "bin");
    const callsPath = join(hostDir, "package-manager-call.txt");
    await mkdir(binDir);
    await writeFile(
      join(hostDir, "package.json"),
      JSON.stringify({
        packageManager: "npm@12.0.2",
        devDependencies: { "@snappedly-tools/shipyard": "^0.7.0" },
      }),
    );
    const npmPath = join(
      binDir,
      process.platform === "win32" ? "npm.cmd" : "npm",
    );
    await writeFile(
      npmPath,
      process.platform === "win32"
        ? '@echo off\r\n> "%SHIPYARD_NPM_CALLS%" echo %*\r\n'
        : '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.SHIPYARD_NPM_CALLS, process.argv.slice(2).join(" "))\n',
    );
    if (process.platform !== "win32") await chmod(npmPath, 0o755);

    const originalPath = process.env.PATH;
    const originalCallsPath = process.env.SHIPYARD_NPM_CALLS;
    const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
    process.env.SHIPYARD_NPM_CALLS = callsPath;
    try {
      const result = await runCliInProcessAt(
        ["uninstall", "--yes"],
        hostDir,
        displayRef,
      );

      expect(Exit.isSuccess(result)).toBe(true);
      await expect(readFile(callsPath, "utf8")).resolves.toBe(
        "uninstall @snappedly-tools/shipyard",
      );
      expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual({
        _tag: "status",
        message: "Removed @snappedly-tools/shipyard with npm.",
        severity: "success",
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalCallsPath === undefined)
        delete process.env.SHIPYARD_NPM_CALLS;
      else process.env.SHIPYARD_NPM_CALLS = originalCallsPath;
    }
  });

  it.skipIf(process.platform === "win32")(
    "uninstall preserves setup when GitHub runner unregistration fails",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-uninstall-runner-"));
      const binDir = join(hostDir, "bin");
      await mkdir(binDir);
      const fixture = await createRunnerUninstallFixture(hostDir);
      await writePosixCommand(join(binDir, "gh"), "process.exit(1);");

      const result = await withEnvironment(
        { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        () => runCliInProcessAt(["uninstall", "--yes"], hostDir),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(
          "Local runner files were preserved",
        );
      }
      await expect(
        readFile(join(fixture.configDir, "main.ts"), "utf8"),
      ).resolves.toBe("export {};\n");
      await expect(
        readFile(join(fixture.runnerDir, RUNNER_INSTALL_METADATA), "utf8"),
      ).resolves.toContain('"repository":"owner/repo"');
      await expect(readFile(fixture.workflowPath, "utf8")).resolves.toBe(
        REPOSITORY_RUNNER_WORKFLOW,
      );
      const packageJson = JSON.parse(
        await readFile(join(hostDir, "package.json"), "utf8"),
      ) as { devDependencies: Record<string, string> };
      expect(packageJson.devDependencies).toHaveProperty(
        "@snappedly-tools/shipyard",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "uninstall --force removes local setup after runner unregistration fails",
    async () => {
      const hostDir = await mkdtemp(join(tmpdir(), "cli-uninstall-force-"));
      const binDir = join(hostDir, "bin");
      const npmCalls = join(hostDir, "npm-calls.txt");
      await mkdir(binDir);
      const fixture = await createRunnerUninstallFixture(hostDir);
      await Promise.all([
        writePosixCommand(join(binDir, "gh"), "process.exit(1);"),
        writePosixCommand(
          join(binDir, "npm"),
          'require("node:fs").writeFileSync(process.env.SHIPYARD_NPM_CALLS, process.argv.slice(2).join(" "));',
        ),
      ]);
      const displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);

      const result = await withEnvironment(
        {
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
          SHIPYARD_NPM_CALLS: npmCalls,
        },
        () =>
          runCliInProcessAt(
            ["uninstall", "--yes", "--force"],
            hostDir,
            displayRef,
          ),
      );

      expect(Exit.isSuccess(result)).toBe(true);
      await expect(
        readFile(join(fixture.configDir, "main.ts"), "utf8"),
      ).rejects.toThrow();
      await expect(
        readFile(join(fixture.runnerDir, RUNNER_INSTALL_METADATA), "utf8"),
      ).rejects.toThrow();
      await expect(readFile(fixture.workflowPath, "utf8")).rejects.toThrow();
      await expect(
        readFile(join(fixture.configDir, ".env"), "utf8"),
      ).resolves.toBe("GH_TOKEN=keep-me\n");
      await expect(readFile(npmCalls, "utf8")).resolves.toBe(
        "uninstall @snappedly-tools/shipyard",
      );
      expect(await Ref.get(displayRef).pipe(Effect.runPromise)).toContainEqual(
        expect.objectContaining({
          _tag: "status",
          severity: "warn",
          message: expect.stringContaining(
            "Remove runner shipyard-owner-repo-test",
          ),
        }),
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "reports package-manager failure after removing repository setup",
    async () => {
      const hostDir = await mkdtemp(
        join(tmpdir(), "cli-uninstall-package-fail-"),
      );
      const configDir = join(hostDir, ".shipyard");
      const binDir = join(hostDir, "bin");
      await Promise.all([mkdir(configDir), mkdir(binDir)]);
      await Promise.all([
        writeFile(join(configDir, "main.ts"), "export {};\n"),
        writeFile(
          join(hostDir, "package.json"),
          JSON.stringify({
            devDependencies: { "@snappedly-tools/shipyard": "^0.7.0" },
          }),
        ),
        writePosixCommand(join(binDir, "npm"), "process.exit(7);"),
      ]);

      const result = await withEnvironment(
        { PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}` },
        () => runCliInProcessAt(["uninstall", "--yes"], hostDir),
      );

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.pretty(result.cause)).toContain(
          "Rerun the uninstall after resolving the package-manager error",
        );
      }
      await expect(
        readFile(join(configDir, "main.ts"), "utf8"),
      ).rejects.toThrow();
      const packageJson = JSON.parse(
        await readFile(join(hostDir, "package.json"), "utf8"),
      ) as { devDependencies: Record<string, string> };
      expect(packageJson.devDependencies).toHaveProperty(
        "@snappedly-tools/shipyard",
      );
    },
  );

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

  it("init --help exposes --issue-tracker flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--issue-tracker");
  });

  it("init --help does not expose the obsolete --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).not.toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
  });

  it("init --help exposes the optional repository runner choice", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-runner");
  });

  it("init --issue-tracker nonexistent produces error listing available trackers", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli("init --issue-tracker nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("github-issues");
      expect(output).not.toContain("beads");
      expect(output).not.toContain("custom");
    }
  });

  it("init with full flag set scaffolds non-interactively in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // vitest workers have no TTY, so this confirms the fully-non-interactive
    // path runs to completion without clack crashing on a missing prompt.
    const { stdout } = await runCli(
      "init --agent claude-code --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    expect(stdout).toContain("npx shipyard run");
    const entries = await readdir(join(hostDir, ".shipyard"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
    expect(entries).not.toContain("runner");
    expect(
      await readdir(join(hostDir, ".github", "workflows")).catch(() => []),
    ).not.toContain("shipyard-wake.yml");
  });

  it("init requires --codex-auth for Codex in a non-TTY env", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent codex --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      expect(stdout + stderr).toContain("--codex-auth");
    }
  });

  it("init --codex-auth chatgpt scaffolds the subscription auth mount", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const isolatedHome = join(hostDir, "home");
    await mkdir(join(isolatedHome, ".codex"), { recursive: true });
    await writeFile(join(isolatedHome, ".codex", "auth.json"), "{}\n");

    await runCli(
      "init --agent codex --codex-auth chatgpt --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
      hostDir,
      { HOME: isolatedHome },
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
        "init --agent codex --codex-auth chatgpt --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
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

    const { stdout } = await runCli(
      "init --agent claude-code --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
      hostDir,
      {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        GH_ARGS_FILE: ghArgsFile,
      },
    );

    expect(stdout).toContain("Init complete");
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

    const { stdout } = await runCli(
      "init --agent claude-code --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
      hostDir,
      { PATH: `${binDir}:${process.env.PATH ?? ""}` },
    );
    expect(stdout).toContain("Init complete");
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
      "init --agent claude-code --template simple-loop --sandbox docker --issue-tracker github-issues --build-image false",
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
