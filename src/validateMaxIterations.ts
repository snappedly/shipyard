export const validateMaxIterations = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `maxIterations must be a positive safe integer. Received: ${value}`,
    );
  }
};
