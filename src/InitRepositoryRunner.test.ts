import { describe, expect, it } from "vitest";
import { repositoryRunnerNextSteps } from "./InitRepositoryRunner.js";

describe("repository runner next steps", () => {
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
