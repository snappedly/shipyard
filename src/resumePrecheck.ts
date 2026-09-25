import type { AgentProvider } from "./AgentProvider.js";

/**
 * Fail-fast validation that a resumable agent session exists on the host before
 * launching the agent. Throws a descriptive error when the session is missing.
 *
 * Shipyard transfers sessions from Docker into the host store keyed on the
 * host repository directory, so the file must exist at that encoded location.
 */
export const assertResumeSessionExists = async (params: {
  readonly provider: AgentProvider;
  readonly hostRepoDir: string;
  readonly resumeSession: string;
}): Promise<void> => {
  const { provider, hostRepoDir, resumeSession } = params;

  if (!provider.sessionStorage) {
    throw new Error(`${provider.name} does not support resumeSession`);
  }

  const exists = await provider.sessionStorage.existsOnHost(
    hostRepoDir,
    resumeSession,
  );
  if (!exists) {
    const sessionPath = provider.sessionStorage.hostSessionFilePath(
      hostRepoDir,
      resumeSession,
    );
    throw new Error(
      sessionPath
        ? `resumeSession "${resumeSession}" not found: expected session file at ${sessionPath}`
        : `resumeSession "${resumeSession}" not found`,
    );
  }
};
