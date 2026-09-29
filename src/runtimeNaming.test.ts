import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold, getAgent, type ScaffoldOptions } from "./InitService.js";
import { generateTempBranchName } from "./WorktreeManager.js";
import { defaultImageName } from "./sandboxes/docker.js";

const makeDir = () => mkdtemp(join(tmpdir(), "shipyard-v1-runtime-naming-"));

const defaultOptions: ScaffoldOptions = {
  agent: getAgent("claude-code")!,
  model: "claude-opus-4-8",
};

const runScaffold = (repoDir: string, options?: Partial<ScaffoldOptions>) =>
  Effect.runPromise(
    scaffold(repoDir, { ...defaultOptions, ...options }).pipe(
      Effect.provide(NodeFileSystem.layer),
    ),
  );

describe("Shipyard V1 runtime naming", () => {
  it("uses Shipyard V1 names for generated branches and images", () => {
    expect(generateTempBranchName()).toMatch(
      /^shipyard-v1\/\d{8}-\d{6}-[0-9a-f]{6}$/,
    );
    expect(defaultImageName("/home/user/my-repo")).toBe("shipyard-v1:my-repo");
  });

  it("scaffolds a fresh repository under .shipyard-v1", async () => {
    const dir = await makeDir();

    await runScaffold(dir);

    const selector = await readFile(
      join(dir, ".shipyard-v1", "select-issues.mjs"),
      "utf8",
    );
    expect(selector).toContain('labels.includes("shipyard-v1")');
  });
});
