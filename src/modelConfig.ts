/** Reasoning efforts accepted by the Codex CLI. */
export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** A model identifier plus the reasoning policy used for that model role. */
export interface CodexModelConfig {
  readonly model: string;
  readonly effort: CodexReasoningEffort;
}

/**
 * Default values for Shipyard's built-in Codex roles.
 *
 * Runtime environment variables override these defaults:
 *   SHIPYARD_CODEX_ROUTINE_MODEL
 *   SHIPYARD_CODEX_ROUTINE_REASONING_EFFORT
 *   SHIPYARD_CODEX_STRONG_MODEL
 *   SHIPYARD_CODEX_STRONG_REASONING_EFFORT
 *
 * Keep the defaults here so runtime providers, generated templates, and the
 * repository workflows all use the same role definitions.
 */
const DEFAULT_CODEX_MODELS = {
  routine: { model: "gpt-5.6-luna", effort: "max" },
  strong: { model: "gpt-5.6-sol", effort: "max" },
} as const satisfies Record<string, CodexModelConfig>;

const readModel = (role: keyof typeof DEFAULT_CODEX_MODELS): string =>
  process.env[`SHIPYARD_CODEX_${role.toUpperCase()}_MODEL`]?.trim() ||
  DEFAULT_CODEX_MODELS[role].model;

const readEffort = (
  role: keyof typeof DEFAULT_CODEX_MODELS,
): CodexReasoningEffort => {
  const envName = `SHIPYARD_CODEX_${role.toUpperCase()}_REASONING_EFFORT`;
  const value = process.env[envName]?.trim();
  if (!value) return DEFAULT_CODEX_MODELS[role].effort;
  if ((CODEX_REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as CodexReasoningEffort;
  }
  throw new Error(
    `${envName} must be one of ${CODEX_REASONING_EFFORTS.join(", ")}; received "${value}"`,
  );
};

export const CODEX_MODELS = {
  routine: {
    model: readModel("routine"),
    effort: readEffort("routine"),
  },
  strong: {
    model: readModel("strong"),
    effort: readEffort("strong"),
  },
} as const satisfies Record<string, CodexModelConfig>;
