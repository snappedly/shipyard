/** Parse the documented fallback issue links from one GitHub issue body. */
export const issueReferences = (body: string, field: string): number[] => {
  const line = body
    .split(/\r?\n/)
    .find((entry) =>
      entry.toLowerCase().startsWith(`shipyard-${field.toLowerCase()}:`),
    );
  if (line === undefined) return [];
  const value = line.slice(line.indexOf(":") + 1).trim();
  if (!/^(?:#\d+)(?:[\s,]+#\d+)*$/.test(value)) {
    throw new Error(`Invalid Shipyard-${field} issue references`);
  }
  return [
    ...new Set([...value.matchAll(/#(\d+)/g)].map((match) => Number(match[1]))),
  ];
};
