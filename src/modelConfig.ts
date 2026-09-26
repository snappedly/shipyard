/** Reasoning efforts accepted by the built-in agent providers. */
export const REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
export const CODEX_REASONING_EFFORTS = REASONING_EFFORTS;
export type CodexReasoningEffort = ReasoningEffort;

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
 *   SHIPYARD_ROUTINE_REASONING_EFFORT
 *   SHIPYARD_CODEX_STRONG_MODEL
 *   SHIPYARD_STRONG_REASONING_EFFORT
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
  const envName = `SHIPYARD_${role.toUpperCase()}_REASONING_EFFORT`;
  const legacyName = `SHIPYARD_CODEX_${role.toUpperCase()}_REASONING_EFFORT`;
  const sharedValue = process.env[envName]?.trim();
  const value = sharedValue || process.env[legacyName]?.trim();
  if (!value) return DEFAULT_CODEX_MODELS[role].effort;
  if ((REASONING_EFFORTS as readonly string[]).includes(value)) {
    return value as CodexReasoningEffort;
  }
  throw new Error(
    `${sharedValue ? envName : legacyName} must be one of ${REASONING_EFFORTS.join(", ")}; received "${value}"`,
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
