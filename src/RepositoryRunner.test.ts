import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installRepositoryRunner,
  type RunnerInstallAdapters,
} from "./RepositoryRunner.js";

const repoDir = "/repo";
const archive = Buffer.from("official runner archive");
const archiveDigest = createHash("sha256").update(archive).digest("hex");

const makeAdapters = (
  overrides: Partial<RunnerInstallAdapters> = {},
): {
  adapters: RunnerInstallAdapters;
  calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }>;
  writes: Map<string, string | Uint8Array>;
  removes: string[];
} => {
  const calls: Array<{
    command: string;
    args: readonly string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
  }> = [];
  const writes = new Map<string, string | Uint8Array>();
  const removes: string[] = [];
  const files = new Set([
    repoDir,
    join(repoDir, ".shipyard"),
    join(repoDir, ".shipyard", ".gitignore"),
  ]);

  const adapters: RunnerInstallAdapters = {
    platform: () => "darwin",
    arch: () => "arm64",
    hostname: () => "Jon’s MacBook.local",
    environment: () => ({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/jon",
      GH_TOKEN: "admin-secret",
      OPENAI_API_KEY: "runtime-secret",
    }),
    exists: async (path) => files.has(path),
    readText: async (path) =>
      path === join(repoDir, ".shipyard", ".gitignore") ? ".env\n" : "",
    writeText: async (path, content) => {
      writes.set(path, content);
      files.add(path);
    },
    writeBytes: async (path, content) => {
      writes.set(path, content);
      files.add(path);
    },
    makeDirectory: async (path) => {
      files.add(path);
    },
    remove: async (path) => {
      removes.push(path);
      files.delete(path);
      writes.delete(path);
    },
    chmod: async () => undefined,
    commandExists: async () => true,
    fetchJson: async () => ({
      tag_name: "v2.331.0",
      assets: [
        {
          name: "actions-runner-osx-arm64-2.331.0.tar.gz",
          browser_download_url:
            "https://github.com/actions/runner/releases/download/v2.331.0/actions-runner-osx-arm64-2.331.0.tar.gz",
          digest: `sha256:${archiveDigest}`,
        },
      ],
    }),
    fetchBytes: async () => archive,
    run: async (command, args, options) => {
      calls.push({ command, args, ...options });
      if (command === "git") {
        return {
          stdout: "git@github.com:snappedly/shipyard.git\n",
          stderr: "",
        };
      }
      if (command === "gh" && args.includes("--method")) {
        return { stdout: '{"token":"one-time-token"}\n', stderr: "" };
      }
      if (command === "gh" && args.includes("actions/runners")) {
        return { stdout: '{"runners":[]}\n', stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    ...overrides,
  };

  return { adapters, calls, writes, removes };
};

describe("installRepositoryRunner", () => {
  it("installs and registers the verified official Apple Silicon runner", async () => {
    const { adapters, calls, writes } = makeAdapters();

    const result = await installRepositoryRunner({ repoDir }, adapters);

    expect(result).toEqual({
      name: "shipyard-shipyard-jon-s-macbook-local",
      repository: "snappedly/shipyard",
      version: "2.331.0",
      runnerDir: join(repoDir, ".shipyard", "runner"),
    });
    expect(writes.get(join(repoDir, ".shipyard", ".gitignore"))).toBe(
      ".env\nrunner/\nrunner-sandbox-mask/\n",
    );
    expect(writes.has(join(repoDir, ".shipyard", "runner", "runner.tgz"))).toBe(
      false,
    );

    const configCall = calls.find((call) => call.command === "./config.sh");
    expect(configCall?.args).toEqual([
      "--url",
      "https://github.com/snappedly/shipyard",
      "--token",
      "one-time-token",
      "--name",
      "shipyard-shipyard-jon-s-macbook-local",
      "--labels",
      "shipyard",
      "--work",
      "_work",
      "--unattended",
    ]);
    expect(configCall?.args).not.toContain("--disableupdate");
    expect(configCall?.env).toMatchObject({
      PATH: "/usr/bin:/bin",
      HOME: "/Users/jon",
    });
    expect(configCall?.env).not.toHaveProperty("GH_TOKEN");
    expect(configCall?.env).not.toHaveProperty("OPENAI_API_KEY");

    const metadata = JSON.parse(
      writes.get(
        join(repoDir, ".shipyard", "runner", ".shipyard-install.json"),
      ) as string,
    ) as Record<string, unknown>;
    expect(metadata).toMatchObject({
      repository: "snappedly/shipyard",
      name: "shipyard-shipyard-jon-s-macbook-local",
      version: "2.331.0",
    });
    expect(JSON.stringify(metadata)).not.toContain("one-time-token");
  });

  it.each([
    ["linux", "arm64"],
    ["darwin", "x64"],
  ])(
    "rejects unsupported host %s/%s before side effects",
    async (platform, arch) => {
      const { adapters, calls, writes } = makeAdapters({
        platform: () => platform,
        arch: () => arch,
      });

      await expect(
        installRepositoryRunner({ repoDir }, adapters),
      ).rejects.toThrow("Apple Silicon macOS");
      expect(calls).toHaveLength(0);
      expect(writes.size).toBe(0);
    },
  );

  it("requires an initialized repository", async () => {
    const { adapters, calls } = makeAdapters({ exists: async () => false });

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("shipyard init");
    expect(calls).toHaveLength(0);
  });

  it("reports a missing prerequisite", async () => {
    const { adapters } = makeAdapters({
      commandExists: async (command) => command !== "tar",
    });

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("Missing required command `tar`");
  });

  it("rejects non-GitHub.com origins", async () => {
    const base = makeAdapters();
    const adapters: RunnerInstallAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "git") {
          return {
            stdout: "https://github.example.com/acme/project.git\n",
            stderr: "",
          };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("GitHub.com repository");
  });

  it("refuses a local runner collision", async () => {
    const base = makeAdapters();
    const runnerDir = join(repoDir, ".shipyard", "runner");
    const adapters: RunnerInstallAdapters = {
      ...base.adapters,
      exists: async (path) => path === runnerDir || base.adapters.exists(path),
    };

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("already installed");
    expect(base.calls).toHaveLength(0);
  });

  it("refuses an existing repository runner carrying the shipyard label", async () => {
    const base = makeAdapters();
    const adapters: RunnerInstallAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (
          command === "gh" &&
          args.some((arg) => arg.endsWith("/actions/runners"))
        ) {
          return { stdout: "shipyard-other-mac\n", stderr: "" };
        }
        return base.adapters.run(command, args, options);
      },
    };

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("already registered");
  });

  it("accepts an explicit one-time token without requiring gh", async () => {
    const base = makeAdapters({
      commandExists: async (command) => command !== "gh",
    });

    await installRepositoryRunner(
      { repoDir, registrationToken: "supplied-once" },
      base.adapters,
    );

    expect(base.calls.some((call) => call.command === "gh")).toBe(false);
    expect(
      base.calls.find((call) => call.command === "./config.sh")?.args,
    ).toContain("supplied-once");
    expect(
      [...base.writes.values()].some((value) =>
        String(value).includes("supplied-once"),
      ),
    ).toBe(false);
  });

  it("rejects a digest mismatch before creating runner files", async () => {
    const base = makeAdapters({
      fetchBytes: async () => Buffer.from("tampered"),
    });

    await expect(
      installRepositoryRunner({ repoDir }, base.adapters),
    ).rejects.toThrow("digest mismatch");
    expect(base.writes.size).toBe(0);
    expect(base.calls.some((call) => call.command === "tar")).toBe(false);
  });

  it("removes a partial runner directory when extraction fails", async () => {
    const base = makeAdapters();
    const adapters: RunnerInstallAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "tar") throw new Error("bad archive");
        return base.adapters.run(command, args, options);
      },
    };

    await expect(
      installRepositoryRunner({ repoDir }, adapters),
    ).rejects.toThrow("Extracting the verified runner archive");
    expect(base.removes).toContain(join(repoDir, ".shipyard", "runner"));
    expect(base.calls.some((call) => call.command === "./config.sh")).toBe(
      false,
    );
  });

  it("never includes a one-time token in registration errors", async () => {
    const base = makeAdapters();
    const adapters: RunnerInstallAdapters = {
      ...base.adapters,
      run: async (command, args, options) => {
        if (command === "./config.sh") {
          throw new Error(`Command failed: ${command} ${args.join(" ")}`);
        }
        return base.adapters.run(command, args, options);
      },
    };

    const error = await installRepositoryRunner(
      { repoDir, registrationToken: "supplied-secret" },
      adapters,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("supplied-secret");
    expect((error as Error).message).toContain("retained");
  });
});
