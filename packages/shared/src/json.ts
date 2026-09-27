/**
 * JSON with object keys sorted at every level, so key order never changes the
 * bytes. Array order is kept. `undefined` renders as `null`.
 */
export function canonicalJson(value: unknown) {
  return JSON.stringify(value ?? null, (_key, nested: unknown) =>
    nested !== null && typeof nested === "object" && !Array.isArray(nested)
      ? Object.fromEntries(
          Object.entries(nested).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : nested,
  );
}
