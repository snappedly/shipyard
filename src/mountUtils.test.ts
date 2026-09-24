import { describe, expect, it, vi } from "vitest";
import {
  defaultImageName,
  expandTilde,
  resolveHostPath,
  resolveSandboxPath,
  resolveUserMounts,
  formatVolumeMount,
  processFileMountParents,
} from "./mountUtils.js";
import { SANDBOX_REPO_DIR } from "./SandboxFactory.js";

vi.mock("node:fs", () => ({
  existsSync: (p: string) =>
    p === "/existing/path" || p === "/home/testuser/data",
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => "/home/testuser",
  };
});

describe("defaultImageName", () => {
  it("derives image name from POSIX repo directory", () => {
    expect(defaultImageName("/home/user/my-repo")).toBe("shipyard:my-repo");
  });

  it("lowercases and sanitizes the directory name", () => {
    expect(defaultImageName("/home/user/My Repo!")).toBe("shipyard:my-repo-");
  });

  it("handles trailing slashes", () => {
    expect(defaultImageName("/home/user/repo/")).toBe("shipyard:repo");
  });

  it("falls back to 'local' for empty path", () => {
    expect(defaultImageName("")).toBe("shipyard:local");
  });

  it("handles Windows paths with backslashes", () => {
    expect(defaultImageName("C:\\Users\\project")).toBe("shipyard:project");
  });

  it("handles Windows paths with trailing backslash", () => {
    expect(defaultImageName("C:\\Users\\project\\")).toBe("shipyard:project");
  });

  it("handles mixed separators", () => {
    expect(defaultImageName("C:\\Users/project")).toBe("shipyard:project");
  });
});

describe("expandTilde", () => {
  it("expands ~ to home directory", () => {
    expect(expandTilde("~")).toBe("/home/testuser");
  });

  it("expands ~/ prefix", () => {
    expect(expandTilde("~/data")).toBe("/home/testuser/data");
  });

  it("expands ~\\ prefix (Windows tilde path)", () => {
    expect(expandTilde("~\\data")).toBe("/home/testuser/data");
  });

  it("leaves absolute POSIX paths unchanged", () => {
    expect(expandTilde("/usr/local")).toBe("/usr/local");
  });

  it("leaves relative paths unchanged", () => {
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});

describe("resolveHostPath", () => {
  it("expands tilde and returns absolute path", () => {
    expect(resolveHostPath("~/data")).toBe("/home/testuser/data");
  });

  it("returns absolute paths as-is", () => {
    expect(resolveHostPath("/absolute/path")).toBe("/absolute/path");
  });
});

describe("resolveSandboxPath", () => {
  it("returns absolute paths as-is", () => {
    expect(resolveSandboxPath("/mnt/data")).toBe("/mnt/data");
  });

  it("resolves relative paths against SANDBOX_REPO_DIR", () => {
    expect(resolveSandboxPath("data")).toBe(`${SANDBOX_REPO_DIR}/data`);
  });

  it("expands ~ to sandboxHomedir when provided", () => {
    expect(resolveSandboxPath("~", "/home/agent")).toBe("/home/agent");
  });

  it("expands ~/.npm to sandboxHomedir/.npm", () => {
    expect(resolveSandboxPath("~/.npm", "/home/agent")).toBe(
      "/home/agent/.npm",
    );
  });

  it("canonicalizes parent traversal in absolute sandbox paths", () => {
    expect(resolveSandboxPath("/home/agent/../etc")).toBe("/home/etc");
  });

  it("throws when ~ is used but sandboxHomedir is undefined", () => {
    expect(() => resolveSandboxPath("~/.npm")).toThrow(
      /sandboxPath.*tilde.*sandboxHomedir/i,
    );
  });

  it("throws when ~ alone is used but sandboxHomedir is undefined", () => {
    expect(() => resolveSandboxPath("~")).toThrow(
      /sandboxPath.*tilde.*sandboxHomedir/i,
    );
  });
});

describe("resolveUserMounts", () => {
  it("resolves and validates user mounts", () => {
    const result = resolveUserMounts([
      { hostPath: "/existing/path", sandboxPath: "/mnt/data" },
    ]);
    expect(result).toEqual([
      { hostPath: "/existing/path", sandboxPath: "/mnt/data" },
    ]);
  });

  it("throws if hostPath does not exist", () => {
    expect(() =>
      resolveUserMounts([
        { hostPath: "/nonexistent/path", sandboxPath: "/mnt/data" },
      ]),
    ).toThrow("Mount hostPath does not exist");
  });

  it("preserves readonly flag", () => {
    const result = resolveUserMounts([
      { hostPath: "/existing/path", sandboxPath: "/mnt/data", readonly: true },
    ]);
    expect(result[0]!.readonly).toBe(true);
  });

  it("expands ~ in sandboxPath when sandboxHomedir is provided", () => {
    const result = resolveUserMounts(
      [{ hostPath: "/existing/path", sandboxPath: "~/.npm" }],
      "/home/agent",
    );
    expect(result[0]!.sandboxPath).toBe("/home/agent/.npm");
  });

  it("expands ~ alone in sandboxPath when sandboxHomedir is provided", () => {
    const result = resolveUserMounts(
      [{ hostPath: "/existing/path", sandboxPath: "~" }],
      "/home/agent",
    );
    expect(result[0]!.sandboxPath).toBe("/home/agent");
  });

  it("throws when ~ used in sandboxPath but sandboxHomedir is undefined", () => {
    expect(() =>
      resolveUserMounts([
        { hostPath: "/existing/path", sandboxPath: "~/.npm" },
      ]),
    ).toThrow(/sandboxPath.*tilde.*sandboxHomedir/i);
  });

  it("resolves hostPath tilde via os.homedir() regardless of sandboxHomedir", () => {
    const result = resolveUserMounts(
      [{ hostPath: "~/data", sandboxPath: "/mnt/data" }],
      undefined,
    );
    expect(result[0]!.hostPath).toBe("/home/testuser/data");
  });
});

describe("formatVolumeMount", () => {
  it("formats basic mount without options", () => {
    expect(
      formatVolumeMount({ hostPath: "/host", sandboxPath: "/sandbox" }, false),
    ).toBe("/host:/sandbox");
  });

  it("appends :z when selinuxLabel is 'z'", () => {
    expect(
      formatVolumeMount({ hostPath: "/host", sandboxPath: "/sandbox" }, "z"),
    ).toBe("/host:/sandbox:z");
  });

  it("appends :Z when selinuxLabel is 'Z'", () => {
    expect(
      formatVolumeMount({ hostPath: "/host", sandboxPath: "/sandbox" }, "Z"),
    ).toBe("/host:/sandbox:Z");
  });

  it("appends :ro when readonly is true and no SELinux", () => {
    expect(
      formatVolumeMount(
        { hostPath: "/host", sandboxPath: "/sandbox", readonly: true },
        false,
      ),
    ).toBe("/host:/sandbox:ro");
  });

  it("combines ro and z options", () => {
    expect(
      formatVolumeMount(
        { hostPath: "/host", sandboxPath: "/sandbox", readonly: true },
        "z",
      ),
    ).toBe("/host:/sandbox:ro,z");
  });

  it("combines ro and Z options", () => {
    expect(
      formatVolumeMount(
        { hostPath: "/host", sandboxPath: "/sandbox", readonly: true },
        "Z",
      ),
    ).toBe("/host:/sandbox:ro,Z");
  });

  it("omits options for writable mount with selinuxLabel false", () => {
    const result = formatVolumeMount(
      { hostPath: "/host", sandboxPath: "/sandbox" },
      false,
    );
    expect(result).toBe("/host:/sandbox");
    expect(result).not.toContain("::");
  });

  it("accepts undefined selinuxLabel (treated as false)", () => {
    expect(
      formatVolumeMount(
        { hostPath: "/host", sandboxPath: "/sandbox" },
        undefined,
      ),
    ).toBe("/host:/sandbox");
  });
});

describe("processFileMountParents", () => {
  const sandboxHomedir = "/home/agent";
  const fileStatFn = () => ({ isFile: () => true });
  const dirStatFn = () => ({ isFile: () => false });

  it("returns parent dir for a file mount under /home/agent", () => {
    const mounts = [
      {
        hostPath: "/host/.codex/auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, fileStatFn);
    expect(result).toEqual(["/home/agent/.codex"]);
  });

  it("throws for a file mount whose parent is outside /home/agent", () => {
    const mounts = [
      {
        hostPath: "/host/config.json",
        sandboxPath: "/opt/foo/config.json",
      },
    ];
    expect(() =>
      processFileMountParents(mounts, sandboxHomedir, fileStatFn),
    ).toThrow(/parent directory.*\/opt\/foo.*outside the sandbox home/i);
  });

  it("error message includes remediation guidance", () => {
    const mounts = [
      {
        hostPath: "/host/config.json",
        sandboxPath: "/opt/foo/config.json",
      },
    ];
    expect(() =>
      processFileMountParents(mounts, sandboxHomedir, fileStatFn),
    ).toThrow(/mount the parent directory instead.*or rebuild/i);
  });

  it("returns empty array for directory mounts", () => {
    const mounts = [
      {
        hostPath: "/host/data",
        sandboxPath: "/home/agent/data",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, dirStatFn);
    expect(result).toEqual([]);
  });

  it("skips mounts whose parent IS /home/agent itself", () => {
    const mounts = [
      {
        hostPath: "/host/.gitconfig",
        sandboxPath: "/home/agent/.gitconfig",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, fileStatFn);
    expect(result).toEqual([]);
  });

  it("deduplicates parent dirs across multiple file mounts", () => {
    const mounts = [
      {
        hostPath: "/host/.codex/auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
      },
      {
        hostPath: "/host/.codex/config.json",
        sandboxPath: "/home/agent/.codex/config.json",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, fileStatFn);
    expect(result).toEqual(["/home/agent/.codex"]);
  });

  it("returns multiple distinct parent dirs", () => {
    const mounts = [
      {
        hostPath: "/host/.codex/auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
      },
      {
        hostPath: "/host/.claude/settings.json",
        sandboxPath: "/home/agent/.claude/settings.json",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, fileStatFn);
    expect(result).toEqual(["/home/agent/.codex", "/home/agent/.claude"]);
  });

  it("skips mounts that cannot be stat'd", () => {
    const throwStatFn = () => {
      throw new Error("ENOENT");
    };
    const mounts = [
      {
        hostPath: "/host/missing",
        sandboxPath: "/home/agent/.codex/missing",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, throwStatFn);
    expect(result).toEqual([]);
  });

  it("handles deeply nested file mounts under /home/agent", () => {
    const mounts = [
      {
        hostPath: "/host/deep.json",
        sandboxPath: "/home/agent/.config/deep/nested/file.json",
      },
    ];
    const result = processFileMountParents(mounts, sandboxHomedir, fileStatFn);
    expect(result).toEqual(["/home/agent/.config/deep/nested"]);
  });
});
