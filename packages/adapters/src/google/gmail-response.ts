export async function readGmailResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing Gmail response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("Invalid Gmail response.");
      size += chunk.length;
      if (size > 64_000) throw new Error("Gmail receipt exceeds limit.");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
