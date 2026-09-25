/** Result of executing a command inside a sandbox. */
export interface ExecResult {
  /** Collected standard output. */
  readonly stdout: string;
  /** Collected standard error. */
  readonly stderr: string;
  /** Process exit status. */
  readonly exitCode: number;
}

/** Streams supplied when launching an interactive agent process. */
export interface InteractiveExecOptions {
  /** Input stream forwarded to the agent process. */
  readonly stdin: NodeJS.ReadableStream;
  /** Output stream receiving agent standard output. */
  readonly stdout: NodeJS.WritableStream;
  /** Output stream receiving agent standard error. */
  readonly stderr: NodeJS.WritableStream;
  /** Working directory inside Docker. */
  readonly cwd?: string;
  /** Abort signal that terminates the interactive process. */
  readonly signal?: AbortSignal;
}

/** Handle to a running isolated sandbox. Docker implements this contract. */
export interface IsolatedSandboxHandle {
  /** Absolute Git workspace path inside Docker. */
  readonly worktreePath: string;
  /**
   * Execute a command in Docker. Deliver `onLine` as output arrives so idle
   * timeouts and live feedback work; buffered delivery does not satisfy this
   * contract. Pipe `stdin` to the child rather than passing it as an argument.
   */
  exec(
    command: string,
    options?: {
      /** Live output callback. */
      onLine?: (line: string) => void;
      /** Working directory inside Docker. */
      cwd?: string;
      /** Execute as root when supported. */
      sudo?: boolean;
      /** Input piped to the child process. */
      stdin?: string;
      /** Abort signal that terminates the command. */
      signal?: AbortSignal;
      /** Maximum combined output bytes before termination. */
      maxOutputBytes?: number;
    },
  ): Promise<ExecResult>;
  /** Launch an interactive process and terminate it when `signal` aborts. */
  interactiveExec?(
    args: string[],
    options: InteractiveExecOptions,
  ): Promise<{ exitCode: number }>;
  /** Copy a file or directory from the host into Docker. */
  copyIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy a file from Docker to the host. */
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the container. */
  close(): Promise<void>;
}

/** File transfer shape used by agent session storage. */
export interface SessionTransferHandle {
  /** Absolute Git workspace path inside Docker. */
  readonly worktreePath: string;
  /** Run a command in the sandbox. */
  exec: IsolatedSandboxHandle["exec"];
  /** Launch an interactive command when available. */
  interactiveExec?: IsolatedSandboxHandle["interactiveExec"];
  /** Copy one host file into the sandbox. */
  copyFileIn(hostPath: string, sandboxPath: string): Promise<void>;
  /** Copy one sandbox file to the host. */
  copyFileOut(sandboxPath: string, hostPath: string): Promise<void>;
  /** Tear down the sandbox. */
  close(): Promise<void>;
}

/** Inputs to Docker sandbox creation. */
export interface IsolatedCreateOptions {
  /** Original repository path used to derive the image name; never mounted. */
  readonly hostRepoPath?: string;
  /** Environment injected into the Docker container. */
  readonly env: Record<string, string>;
}

/** Configuration for the isolated Docker provider contract. */
export interface IsolatedSandboxProviderConfig {
  /** Human-readable provider name. */
  readonly name: string;
  /** Provider environment merged into sandbox startup. */
  readonly env?: Record<string, string>;
  /** Start a sandbox and return its command and file-transfer handle. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** Docker's isolated filesystem provider contract. */
export interface IsolatedSandboxProvider {
  /** Isolated filesystem discriminator. */
  readonly tag: "isolated";
  /** Human-readable provider name. */
  readonly name: string;
  /** Environment variables injected into Docker. */
  readonly env: Record<string, string>;
  /** Start a sandbox. */
  readonly create: (
    options: IsolatedCreateOptions,
  ) => Promise<IsolatedSandboxHandle>;
}

/** Provider accepted by Shipyard's Docker execution path. */
export type SandboxProvider = IsolatedSandboxProvider;

/** Create a temporary branch and merge its commits back to host HEAD. */
export interface MergeToHeadBranchStrategy {
  /** Branch strategy discriminator. */
  readonly type: "merge-to-head";
}

/** Run on a caller-named branch. */
export interface NamedBranchStrategy {
  /** Branch strategy discriminator. */
  readonly type: "branch";
  /** Branch to create or reuse. */
  readonly branch: string;
  /** Starting ref for a new branch. */
  readonly baseBranch?: string;
}

/** Supported Docker branch strategies. */
export type BranchStrategy = MergeToHeadBranchStrategy | NamedBranchStrategy;

/** Construct the isolated provider contract used by Docker. */
export const createIsolatedSandboxProvider = (
  config: IsolatedSandboxProviderConfig,
): IsolatedSandboxProvider => ({
  tag: "isolated",
  name: config.name,
  env: config.env ?? {},
  create: config.create,
});

/** Adapt Docker file transfer to the agent session storage interface. */
export const toSessionTransferHandle = (
  handle: IsolatedSandboxHandle | SessionTransferHandle | undefined,
): SessionTransferHandle | undefined =>
  handle === undefined
    ? undefined
    : "copyFileIn" in handle
      ? handle
      : {
          worktreePath: handle.worktreePath,
          exec: (command, options) => handle.exec(command, options),
          interactiveExec: handle.interactiveExec?.bind(handle),
          copyFileIn: (source, destination) =>
            handle.copyIn(source, destination),
          copyFileOut: (source, destination) =>
            handle.copyFileOut(source, destination),
          close: () => handle.close(),
        };
