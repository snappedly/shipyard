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

  it("redacts bearer values and environment-style API key names", () => {
    const result = sanitizeDiagnostic(
      "token=Bearer token-secret OPENAI_API_KEY=openai-secret ANTHROPIC_API_KEY=anthropic-secret",
    );

    expect(result).toBe(
      "token=[REDACTED] OPENAI_API_KEY=[REDACTED] ANTHROPIC_API_KEY=[REDACTED]",
    );
    expect(result).not.toContain("token-secret");
    expect(result).not.toContain("openai-secret");
    expect(result).not.toContain("anthropic-secret");
  });
});
