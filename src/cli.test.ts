import { exec } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeContext } from "@effect/platform-node";
import { Effect, Exit, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { cli } from "./cli.js";
import { ClackDisplay } from "./Display.js";

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

// Parser-only compatibility checks do not need a packaged-process boundary.
// Keeping them in-process avoids a flaky child-process wait under CI.
const cliTestLayer = Layer.merge(NodeContext.layer, ClackDisplay.layer);

const runCliInProcess = (args: ReadonlyArray<string>) =>
  Effect.runPromiseExit(
    cli(["node", "shipyard", ...args]).pipe(Effect.provide(cliTestLayer)),
  );

describe("shipyard CLI", { timeout: cliTestTimeoutMs }, () => {
  it("shows help with --help flag", async () => {
    const { stdout } = await runCli("--help", process.cwd());
    expect(stdout).toContain("shipyard");
    expect(stdout).toContain("docker");
    expect(stdout).toContain("init");
    expect(stdout).toContain("run");
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

    try {
      await runCli("run --skip-build", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No .shipyard/ found");
    }
  });

  it("run errors when the generated entrypoint is missing", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    await mkdir(join(hostDir, ".shipyard"));

    try {
      await runCli("run --skip-build", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("No Shipyard entrypoint found");
      expect(output).toContain("main.ts");
      expect(output).toContain("main.mts");
    }
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

    try {
      await runCli("init --agent claude-code --template nonexistent", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("nonexistent");
      expect(output).toContain("blank");
      expect(output).toContain("simple-loop");
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

  it("init --help exposes --create-label flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--create-label");
  });

  it("init --help exposes --build-image flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--build-image");
  });

  it("init --help exposes --install-template-deps flag", async () => {
    const { stdout } = await runCli("init --help", process.cwd());
    expect(stdout).toContain("--install-template-deps");
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
      "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false",
      hostDir,
    );

    expect(stdout).toContain("Init complete");
    const entries = await readdir(join(hostDir, ".shipyard"));
    expect(entries).toContain("Dockerfile");
    expect(entries).toContain("prompt.md");
  });

  it("init --codex-auth chatgpt scaffolds the subscription auth mount", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");
    const isolatedHome = join(hostDir, "home");
    await mkdir(join(isolatedHome, ".codex"), { recursive: true });
    await writeFile(join(isolatedHome, ".codex", "auth.json"), "{}\n");

    await runCli(
      "init --agent codex --codex-auth chatgpt --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false",
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
        "init --agent codex --codex-auth chatgpt --template blank --sandbox docker --issue-tracker github-issues --create-label false --build-image false",
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
      await runCli("init --template blank --sandbox docker", hostDir);
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--agent");
      expect(output).toContain("non-interactive");
    }
  });

  it("init --issue-tracker github-issues without --create-label fails fast in non-interactive mode", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "cli-host-"));
    await initRepo(hostDir);

    try {
      await runCli(
        "init --agent claude-code --template blank --sandbox docker --issue-tracker github-issues",
        hostDir,
      );
      expect.fail("Expected command to fail");
    } catch (err: unknown) {
      const { stdout, stderr } = err as { stdout: string; stderr: string };
      const output = stdout + stderr;
      expect(output).toContain("--create-label");
      expect(output).toContain("non-interactive");
    }
  });
});
