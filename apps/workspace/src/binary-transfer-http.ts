import type { WorkspaceIdentity } from "@winston/contracts/workspace";
import type { openWorkspaceInbox } from "./inbox";

export type TransferSlots = { active: number };
type Descriptor = WorkspaceIdentity & { artifactId: string; size: number; sha256: string };

async function readBytes(request: Request, size: number, signal: AbortSignal) {
  if (!request.body) {
    if (size === 0) return new Uint8Array();
    throw new Error("Missing file bytes.");
  }
  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      const value: unknown = chunk.value;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid file bytes.");
      total += value.byteLength;
      if (total > size) throw new Error("Too many file bytes.");
      chunks.push(value);
    }
    if (total !== size) throw new Error("Incomplete file bytes.");
    return Buffer.concat(chunks, total);
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createBinaryTransferHandler<Transfer extends Descriptor>(options: {
  path: string;
  identity: WorkspaceIdentity;
  inbox: ReturnType<typeof openWorkspaceInbox>;
  tokenSchema: { safeParse(input: unknown): { success: true; data: string } | { success: false } };
  transferSchema: { parse(input: unknown): Transfer };
  authorize: (token: string, transfer: Transfer) => Promise<boolean>;
  slots: TransferSlots;
}) {
  return async (request: Request): Promise<Response | null> => {
    if (new URL(request.url).pathname !== options.path) return null;
    const reply = (status: number, value: unknown) =>
      Response.json(value, {
        status,
        headers: { "Cache-Control": "no-store" },
      });
    const deny = async (status: number) => {
      await request.body?.cancel().catch(() => undefined);
      return reply(status, { error: "transfer_unavailable" });
    };
    if (request.method !== "POST") return deny(405);
    const credential = options.tokenSchema.safeParse(
      request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1],
    );
    if (!credential.success) return deny(401);
    let transfer: Transfer;
    try {
      const header = request.headers.get("X-Winston-Transfer");
      if (!header || header.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(header))
        return await deny(400);
      transfer = options.transferSchema.parse(
        JSON.parse(Buffer.from(header, "base64url").toString("utf8")),
      );
    } catch {
      return deny(400);
    }
    if (
      transfer.ownerId !== options.identity.ownerId ||
      transfer.workspaceId !== options.identity.workspaceId
    )
      return deny(403);
    if (options.slots.active >= 2) return deny(503);
    options.slots.active++;
    try {
      if (!(await options.authorize(credential.data, transfer))) return await deny(403);
      const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]);
      const bytes = await readBytes(request, transfer.size, deadline);
      const path = await options.inbox.publish({
        id: transfer.artifactId,
        size: transfer.size,
        sha256: transfer.sha256,
        bytes,
        async authorize() {
          deadline.throwIfAborted();
          const allowed = await options.authorize(credential.data, transfer);
          deadline.throwIfAborted();
          return allowed;
        },
      });
      return reply(200, { path, sha256: transfer.sha256, size: transfer.size });
    } catch {
      await request.body?.cancel().catch(() => undefined);
      return reply(503, { error: "transfer_unavailable" });
    } finally {
      options.slots.active--;
    }
  };
}
