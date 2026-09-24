import { describe, expect, it, vi } from "vitest";
import { resolvePlannerBranch } from "./templates/parallel-planner/planner-branch.mjs";

const existingPlannerBranch = "shipyard/planner/20260920-210724-7707b7";

describe("resolvePlannerBranch", () => {
  it("keeps the standard branch when no local ref conflicts", async () => {
    await expect(
      resolvePlannerBranch(["main", "shipyard/issue-42"]),
    ).resolves.toBe("shipyard/planner");
  });

  it("offers and selects a stable sibling branch when a nested ref conflicts", async () => {
    const ask = vi.fn(async () => "");

    await expect(
      resolvePlannerBranch([existingPlannerBranch], {
        isInteractive: true,
        ask,
        checkedOutBranches: [],
        mergedBranches: [],
      }),
    ).resolves.toBe("shipyard/planner-2");
    expect(ask).toHaveBeenCalledWith(
      expect.stringContaining("shipyard/planner-2"),
    );
  });

  it("does not change branches when the user declines the alternate", async () => {
    const ask = vi.fn(async () => "n");

    await expect(
      resolvePlannerBranch([existingPlannerBranch], {
        isInteractive: true,
        ask,
        checkedOutBranches: [],
        mergedBranches: [],
      }),
    ).rejects.toThrow(/No branches were changed/);
  });

  it("suggests the stable alternate when prompting is unavailable", async () => {
    await expect(
      resolvePlannerBranch([existingPlannerBranch], { isInteractive: false }),
    ).rejects.toThrow(/shipyard\/planner-2/);
  });

  it("reuses the previously selected alternate without asking again", async () => {
    const ask = vi.fn(async () => "n");

    await expect(
      resolvePlannerBranch([existingPlannerBranch, "shipyard/planner-2"], {
        isInteractive: true,
        ask,
      }),
    ).resolves.toBe("shipyard/planner-2");
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps reusing the selected suffix if an earlier suffix becomes free", async () => {
    const ask = vi.fn(async () => "n");

    await expect(
      resolvePlannerBranch(
        [
          existingPlannerBranch,
          "shipyard/planner-2/old-run",
          "shipyard/planner-3",
        ],
        { isInteractive: true, ask },
      ),
    ).resolves.toBe("shipyard/planner-3");
    expect(ask).not.toHaveBeenCalled();
  });

  it("skips alternates that also conflict with existing refs", async () => {
    const ask = vi.fn(async () => "y");

    await expect(
      resolvePlannerBranch(
        [
          existingPlannerBranch,
          "shipyard/planner-2/old-run",
          "shipyard-planner-2/old-run",
        ],
        {
          isInteractive: true,
          ask,
          checkedOutBranches: [],
          mergedBranches: [],
        },
      ),
    ).resolves.toBe("shipyard/planner-3");
  });

  it("uses a top-level alternate when the shipyard namespace itself is taken", async () => {
    const ask = vi.fn(async () => "y");

    await expect(
      resolvePlannerBranch(["shipyard"], {
        isInteractive: true,
        ask,
        checkedOutBranches: [],
        mergedBranches: [],
      }),
    ).resolves.toBe("shipyard-planner-2");
  });

  it("deletes conflicting refs only when requested and safe", async () => {
    const ask = vi.fn(async () => "d");
    const deleteBranches = vi.fn();

    await expect(
      resolvePlannerBranch([existingPlannerBranch], {
        isInteractive: true,
        ask,
        checkedOutBranches: [],
        mergedBranches: [existingPlannerBranch],
        deleteBranches,
      }),
    ).resolves.toBe("shipyard/planner");
    expect(deleteBranches).toHaveBeenCalledWith([existingPlannerBranch]);
  });

  it("refuses to delete a conflicting ref checked out in a worktree", async () => {
    const ask = vi.fn(async () => "d");
    const deleteBranches = vi.fn();

    await expect(
      resolvePlannerBranch([existingPlannerBranch], {
        isInteractive: true,
        ask,
        checkedOutBranches: [existingPlannerBranch],
        mergedBranches: [existingPlannerBranch],
        deleteBranches,
      }),
    ).rejects.toThrow(/checked out in a worktree/);
    expect(deleteBranches).not.toHaveBeenCalled();
  });

  it("refuses to delete a conflicting ref with unmerged commits", async () => {
    const ask = vi.fn(async () => "d");
    const deleteBranches = vi.fn();

    await expect(
      resolvePlannerBranch([existingPlannerBranch], {
        isInteractive: true,
        ask,
        checkedOutBranches: [],
        mergedBranches: [],
        deleteBranches,
      }),
    ).rejects.toThrow(/commits not merged into HEAD/);
    expect(deleteBranches).not.toHaveBeenCalled();
  });
});
