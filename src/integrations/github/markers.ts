import { createHash } from "node:crypto";

export const markerPart = (value: string | number): string =>
  encodeURIComponent(String(value));

export const markerText = (marker: string): string =>
  `<!-- shipyard:${marker} -->`;

export const markerHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);
