/** Remove common credentials and control characters from user-facing diagnostics. */
export const sanitizeDiagnostic = (value: string, limit = 600): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/gi, "[REDACTED]")
    .replace(
      /(^|[^A-Za-z0-9])([A-Za-z0-9_.-]*(?:authorization|access[-_]?token|api[-_]?key|token|password|secret|cookie))\s*[:=]\s*(?:bearer|basic|token)\s+[^\s,;]+|(^|[^A-Za-z0-9])([A-Za-z0-9_.-]*(?:authorization|access[-_]?token|api[-_]?key|token|password|secret|cookie))\s*[:=]\s*[^\s,;]+/gi,
      (_match, leading, key, fallbackLeading, fallbackKey) =>
        `${leading ?? fallbackLeading}${key ?? fallbackKey}=[REDACTED]`,
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
