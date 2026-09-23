/** Remove common credentials and control characters from user-facing diagnostics. */
export const sanitizeDiagnostic = (value: string, limit = 600): string =>
  value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/(?:gh[pousr]|github_pat)_[A-Za-z0-9_]+/gi, "[REDACTED]")
    .replace(
      /\b(authorization)\s*[:=]\s*(?:[A-Za-z][A-Za-z0-9_-]*\s+)?[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(
      /\b(access[-_]?token|api[-_]?key|token|password|secret|cookie)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED]",
    )
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
