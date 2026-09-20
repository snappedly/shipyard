import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InitError } from "./errors.js";

export interface CodexAuthPreflightOptions {
  readonly cwd: string;
  readonly interactive: boolean;
  /** Test seam; production uses the user's default ~/.codex directory. */
  readonly authHome?: string;
  /** Test seam; production runs `codex login` in the user's terminal. */
  readonly login?: (cwd: string) => void;
}

export const codexAuthFilePath = (
  authHome = join(homedir(), ".codex"),
): string => join(authHome, "auth.json");

const isRegularFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isMissingCodexCli = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "ENOENT";

// Shipyard mounts auth.json into the sandbox, so make this login use the file
// store without changing the user's permanent Codex configuration.
const codexLoginArgs = [
  "--config",
  'cli_auth_credentials_store="file"',
  "login",
];

const runCodexLogin = (cwd: string): void => {
  try {
    execFileSync("codex", codexLoginArgs, { cwd, stdio: "inherit" });
  } catch (error) {
    if (!isMissingCodexCli(error)) throw error;
    // Shipyard already requires npm. Use npx as a no-global-install fallback
    // when the user has not installed the Codex CLI on the host yet.
    execFileSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      ["--yes", "@openai/codex", ...codexLoginArgs],
      { cwd, stdio: "inherit" },
    );
  }
};

/**
 * Ensure the host has a file-backed Codex ChatGPT login for the generated
 * sandbox mount. The browser/device login remains user-driven; init only
 * starts it when an interactive terminal is available.
 */
export const ensureCodexChatGptAuth = (
  options: CodexAuthPreflightOptions,
): void => {
  const authFile = codexAuthFilePath(options.authHome);
  if (isRegularFile(authFile)) return;

  if (!options.interactive) {
    throw new InitError({
      message:
        "Codex ChatGPT authentication is not ready: ~/.codex/auth.json was not found. Run `codex login` in an interactive terminal, then rerun `shipyard init --codex-auth chatgpt` (non-interactive mode cannot open the login flow).",
    });
  }

  try {
    (options.login ?? runCodexLogin)(options.cwd);
  } catch (error) {
    if (error instanceof InitError) throw error;
    if (isMissingCodexCli(error)) {
      throw new InitError({
        message:
          "The Codex CLI is not installed. Install it with `npm install --global @openai/codex`, run `codex login`, and rerun Shipyard init.",
      });
    }
    throw new InitError({
      message:
        "Codex login failed. Complete `codex login` successfully, then rerun Shipyard init.",
    });
  }

  if (!isRegularFile(authFile)) {
    throw new InitError({
      message:
        'Codex login finished, but ~/.codex/auth.json was not created. Codex may be using an OS keyring or a managed configuration. Set `cli_auth_credentials_store = "file"` in `~/.codex/config.toml`, run `codex login` again, and rerun Shipyard init.',
    });
  }
};
