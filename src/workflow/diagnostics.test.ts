import { describe, expect, it } from "vitest";
import { sanitizeDiagnostic } from "./diagnostics.js";

describe("diagnostic sanitization", () => {
  it("redacts authorization schemes and secret values", () => {
    const result = sanitizeDiagnostic(
      "Authorization: Bearer bearer-secret token=access-secret password=private",
    );

    expect(result).toContain("Authorization=[REDACTED]");
    expect(result).toContain("token=[REDACTED]");
    expect(result).toContain("password=[REDACTED]");
    expect(result).not.toContain("Bearer");
    expect(result).not.toContain("bearer-secret");
    expect(result).not.toContain("access-secret");
    expect(result).not.toContain("private");
    expect(result).not.toContain("$1");
  });
});
