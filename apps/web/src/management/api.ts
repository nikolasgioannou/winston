export class OwnerApiError extends Error {
  constructor(readonly status: number) {
    super("The request could not be completed.");
  }
}

export async function ownerJson<T>(
  path: `/api/owner/${string}`,
  schema: { parse(value: unknown): T },
  options: { signal?: AbortSignal; method?: "POST" | "PUT"; body?: unknown } = {},
) {
  const timeout = AbortSignal.timeout(10_000);
  const response = await fetch(path, {
    signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
    ...(options.method ? { method: options.method } : {}),
    ...(options.body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(options.body),
        }),
  });
  if (!response.ok) throw new OwnerApiError(response.status);
  return schema.parse(await response.json());
}
