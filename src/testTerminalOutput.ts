import { afterEach, beforeEach, vi } from "vitest";

export const silenceTerminalOutput = () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stdoutWrite = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });
};
