import type { OwnerTransaction } from "../database";
import type { createArtifactReader } from "./read";
import { workspaceRuntimeSchema } from "@winston/contracts/workspace-runtime";

export async function stageInboxFile(
  database: {
    transaction<Result>(
      ownerId: string,
      work: (scope: Pick<OwnerTransaction, "inboxTransfers">) => Promise<Result>,
    ): Promise<Result>;
  },
  ownerId: string,
  botId: number,
  read: ReturnType<typeof createArtifactReader>,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const claim = await database.transaction(ownerId, ({ inboxTransfers }) =>
    inboxTransfers.claim(botId),
  );
  if (!claim) return "idle";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  try {
    const { transfer, token } = claim;
    const file = await read(ownerId, transfer.artifactId, 20_000_000, deadline);
    if (
      !file ||
      file.artifact.metadata.sha256 !== transfer.sha256 ||
      file.bytes.length !== transfer.size
    )
      throw new Error("Incoming artifact unavailable.");
    const current = await database.transaction(ownerId, ({ inboxTransfers }) =>
      inboxTransfers.authenticate(token),
    );
    if (!current) return "canceled";
    const origin = workspaceRuntimeSchema.shape.origin.parse(claim.origin);
    const response = await fetch(new URL("/v1/inbox", origin), {
      method: "POST",
      redirect: "error",
      credentials: "omit",
      signal: deadline,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
        "X-Winston-Transfer": Buffer.from(JSON.stringify(transfer)).toString("base64url"),
      },
      body: file.bytes,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Workspace intake unavailable.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Missing staging receipt.");
    let result: unknown;
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const value: unknown = chunk.value;
        if (!(value instanceof Uint8Array)) throw new Error("Invalid staging receipt.");
        size += value.byteLength;
        if (size > 4096) throw new Error("Invalid staging receipt.");
        chunks.push(value);
      }
      result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (
      !result ||
      typeof result !== "object" ||
      !("path" in result) ||
      result.path !== `/data/inbox/${transfer.artifactId}` ||
      !("sha256" in result) ||
      result.sha256 !== transfer.sha256 ||
      !("size" in result) ||
      result.size !== transfer.size
    )
      throw new Error("Invalid staging receipt.");
    deadline.throwIfAborted();
    const completed = await database.transaction(ownerId, ({ inboxTransfers }) =>
      inboxTransfers.complete(token),
    );
    return completed ? "staged" : "canceled";
  } catch {
    await database.transaction(ownerId, ({ inboxTransfers }) => inboxTransfers.retry(claim.token));
    return "retry";
  }
}
