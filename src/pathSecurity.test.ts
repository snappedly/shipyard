import { describe, expect, it } from "vitest";
import {
  assertSafeRelativePath,
  resolveSafeRelativePath,
} from "./pathSecurity.js";

describe("path security helpers", () => {
  it("keeps ordinary nested paths under their root", () => {
    expect(resolveSafeRelativePath("/repo", "config/app.json")).toBe(
      "/repo/config/app.json",
    );
  });

  it.each(["../outside", "nested/../../outside", "/absolute", "C:\\outside"])(
    "rejects escaping path %s",
    (path) => {
      expect(() => assertSafeRelativePath(path)).toThrow();
      expect(() => resolveSafeRelativePath("/repo", path)).toThrow();
    },
  );
});
