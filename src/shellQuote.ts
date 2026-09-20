/** Quote a value for use as one POSIX-shell argument. */
export const shellQuote = (value: string): string => {
  if (value.includes("\0")) {
    throw new Error("Cannot quote a string containing a NUL byte");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
};
