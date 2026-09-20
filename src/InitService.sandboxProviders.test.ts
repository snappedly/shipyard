import { describe, expect, it } from "vitest";
import { listSandboxProviders, getSandboxProvider } from "./InitService.js";

describe("Sandbox provider registry", () => {
  it("offers Docker as the local scaffold provider", () => {
    expect(listSandboxProviders().map((provider) => provider.name)).toEqual([
      "docker",
    ]);
  });

  it("getSandboxProvider returns docker entry", () => {
    const provider = getSandboxProvider("docker");
    expect(provider).toBeDefined();
    expect(provider!.containerfileName).toBe("Dockerfile");
    expect(provider!.cliNamespace).toBe("docker");
  });

  it("getSandboxProvider returns undefined for unknown provider", () => {
    expect(getSandboxProvider("nonexistent")).toBeUndefined();
  });
});
