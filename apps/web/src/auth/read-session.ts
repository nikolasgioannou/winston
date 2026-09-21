export async function readSession(signal: AbortSignal) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    signal.throwIfAborted();

    try {
      const response = await fetch("/api/owner/session", { signal });

      if (attempt === 0 && [502, 503, 504].includes(response.status)) {
        continue;
      }

      return response;
    } catch (error) {
      if (signal.aborted || attempt === 1) {
        throw error;
      }
    }
  }

  throw new Error("Session check failed.");
}
