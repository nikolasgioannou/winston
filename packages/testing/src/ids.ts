export function createTestIds(prefix = "test"): () => string {
  let sequence = 0;

  return () => {
    sequence += 1;

    return `${prefix}-${sequence.toString().padStart(4, "0")}`;
  };
}
