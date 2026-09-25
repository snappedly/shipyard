import { describe, expect, it, vi } from "vitest";
import {
  initializeRepositoryRunner,
  repositoryRunnerNextSteps,
} from "./InitRepositoryRunner.js";

describe("repository runner initialization", () => {
  it("defaults to declining installation outside an interactive terminal", async () => {
    const install = vi.fn();

    const result = await initializeRepositoryRunner({
      interactive: false,
      install,
    });

    expect(result).toEqual({ status: "declined" });
    expect(install).not.toHaveBeenCalled();
  });

  it("offers interactive installation with Yes as the default", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const install = vi.fn();

    const result = await initializeRepositoryRunner({
      interactive: true,
      confirm,
      install,
    });

    expect(confirm).toHaveBeenCalledWith({
      message:
        "Install a foreground repository runner for labelled GitHub issues?",
      initialValue: true,
    });
    expect(result).toEqual({ status: "declined" });
    expect(install).not.toHaveBeenCalled();
  });

  it("delegates accepted installation to the standalone installer", async () => {
    const installed = {
      name: "shipyard-widget-macbook",
      repository: "owner/widget",
      version: "2.999.0",
      runnerDir: "/repo/.shipyard/runner",
    };
    const install = vi.fn().mockResolvedValue(installed);

    const result = await initializeRepositoryRunner({
      interactive: false,
      requested: true,
      install,
    });

    expect(result).toEqual({ status: "installed", result: installed });
    expect(install).toHaveBeenCalledOnce();
  });

  it("reports installation failure without rejecting the completed scaffold", async () => {
    const install = vi
      .fn()
      .mockRejectedValue(new Error("GitHub denied access"));

    const result = await initializeRepositoryRunner({
      interactive: false,
      requested: true,
      install,
    });

    expect(result).toEqual({
      status: "failed",
      message: "GitHub denied access",
    });
  });

  it("describes workflow activation and every foreground lifecycle command", () => {
    const nextSteps = repositoryRunnerNextSteps().join("\n");

    expect(nextSteps).toContain(".github/workflows/shipyard-wake.yml");
    expect(nextSteps).toContain("committed and pushed");
    expect(nextSteps).toContain("npx shipyard runner start");
    expect(nextSteps).toContain("npx shipyard runner status");
    expect(nextSteps).toContain("npx shipyard runner stop");
    expect(nextSteps).toContain("npx shipyard runner remove");
  });
});
