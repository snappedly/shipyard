import { createHmac, timingSafeEqual } from "node:crypto";

export interface GitHubWebhookSignatureInput {
  readonly body: string | Uint8Array;
  readonly signature?: string;
  readonly secret: string | Uint8Array;
}

const asBytes = (value: string | Uint8Array): Buffer =>
  typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);

/**
 * Verifies GitHub's `X-Hub-Signature-256` value without exposing the secret.
 * Malformed values are compared against a same-sized zero buffer so the final
 * digest comparison always uses the constant-time primitive.
 */
export const verifyGitHubWebhookSignature = (
  input: GitHubWebhookSignatureInput,
): boolean => {
  const expected = createHmac("sha256", asBytes(input.secret))
    .update(asBytes(input.body))
    .digest();
  const signature = input.signature ?? "";
  const prefix = "sha256=";
  const encoded = signature.startsWith(prefix)
    ? signature.slice(prefix.length)
    : "";
  const isHexDigest = /^[0-9a-f]{64}$/i.test(encoded);
  const candidate = isHexDigest
    ? Buffer.from(encoded, "hex")
    : Buffer.alloc(expected.length);

  return timingSafeEqual(expected, candidate) && isHexDigest;
};
