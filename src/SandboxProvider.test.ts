import { describe, expect, it, vi } from "vitest";
import {
  createIsolatedSandboxProvider,
  type IsolatedSandboxHandle,
} from "./SandboxProvider.js";

describe("createIsolatedSandboxProvider", () => {
  const makeMockHandle = (): IsolatedSandboxHandle => ({
    worktreePath: "/workspace",
    exec: vi.fn(async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    copyIn: vi.fn(async () => {}),
    copyFileOut: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  });

  it("returns a SandboxProvider with tag 'isolated'", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect(provider.tag).toBe("isolated");
    expect(provider.name).toBe("test-isolated");
  });

  it("does not have a branchStrategy property", () => {
    const provider = createIsolatedSandboxProvider({
      name: "test-isolated",
      create: async () => makeMockHandle(),
    });

    expect("branchStrategy" in provider).toBe(false);
  });
});
