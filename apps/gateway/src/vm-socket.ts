import type { DbOrTx } from "@winston/db/client";
import { vms } from "@winston/db/schema";
import { applyVmEvent } from "@winston/db/vm-state";
import {
  newFrameId,
  parseFrame,
  vmToGatewayFrame,
  type GatewayToVmFrame,
} from "@winston/domain/frames";
import type { Logger } from "@winston/shared/logger";
import { generateToken, hashToken } from "@winston/shared/tokens";
import { and, eq, or, sql } from "drizzle-orm";
import type { Execs } from "./execs.ts";
import type { FileTransfers } from "./files.ts";

/** What a VM connection carries once authenticated. */
export interface VmSocketData {
  vmId: string;
  /** Set when the VM connected with its one-time registration token. */
  registrationHash?: string;
}

/** Close code when a registration token was used in the meantime. */
export const registrationUsedCloseCode = 4401;

/**
 * Authenticates a connecting VM from `Authorization: Bearer <token>`. Tokens
 * are random, so they're looked up by their SHA-256. A registration token
 * only counts while its VM is registering.
 */
export async function authenticateVm(
  db: DbOrTx,
  authorization: string | null,
): Promise<VmSocketData | undefined> {
  const token = authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return undefined;
  const hash = hashToken(token);
  const [vm] = await db
    .select({ id: vms.id, state: vms.state, tokenHash: vms.tokenHash })
    .from(vms)
    .where(or(eq(vms.tokenHash, hash), eq(vms.registrationTokenHash, hash)));
  if (!vm) return undefined;
  if (vm.tokenHash === hash) return { vmId: vm.id };
  return vm.state === "registering"
    ? { vmId: vm.id, registrationHash: hash }
    : undefined;
}

/**
 * Exchanges a registration token for the long-lived VM token (docs/design.md
 * §15). One conditional update both stores the new token's hash and burns
 * the registration token, so a token registers exactly once, even in a race.
 * Returns the raw VM token, or undefined if the registration token is spent.
 */
export async function register(
  db: DbOrTx,
  vmId: string,
  registrationHash: string,
) {
  const vmToken = generateToken();
  const [updated] = await db
    .update(vms)
    .set({ tokenHash: hashToken(vmToken), registrationTokenHash: null })
    .where(
      and(eq(vms.id, vmId), eq(vms.registrationTokenHash, registrationHash)),
    )
    .returning({ id: vms.id });
  return updated ? vmToken : undefined;
}

/** Handles one frame from a VM. Returns the frames to send back. */
export async function handleVmFrame(
  {
    db,
    logger,
    execs,
    files,
  }: { db: DbOrTx; logger: Logger; execs: Execs; files: FileTransfers },
  vmId: string,
  text: string,
): Promise<GatewayToVmFrame[]> {
  const parsed = parseFrame(vmToGatewayFrame, text);
  if (!parsed.ok)
    return [
      {
        id: newFrameId(),
        type: "error",
        code: "invalid_frame",
        message: parsed.error,
      },
    ];
  const frame = parsed.frame;
  if (execs.handle(vmId, frame) || files.handle(vmId, frame)) return [];

  switch (frame.type) {
    case "hello": {
      const [vm] = await db
        .update(vms)
        .set({
          cliVersion: frame.cliVersion,
          winstondVersion: frame.winstondVersion,
          lastSeenAt: sql`now()`,
        })
        .where(eq(vms.id, vmId))
        .returning({ state: vms.state });
      if (vm?.state === "registering")
        await applyVmEvent(db, vmId, "registered");
      else if (vm?.state === "unhealthy")
        await applyVmEvent(db, vmId, "recovered");
      logger.info(
        {
          vmId,
          cliVersion: frame.cliVersion,
          winstondVersion: frame.winstondVersion,
        },
        "VM said hello",
      );
      return [];
    }
    case "ping": {
      const [vm] = await db
        .update(vms)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(vms.id, vmId))
        .returning({ state: vms.state });
      if (vm?.state === "unhealthy") await applyVmEvent(db, vmId, "recovered");
      return [{ id: newFrameId(), type: "pong", replyTo: frame.id }];
    }
    case "pong":
      return [];
    case "exec.output":
    case "exec.exit":
    case "exec.result":
    case "file.chunk":
    case "file.done":
    case "file.error":
      // Handled by the exec and file registries above.
      return [];
    case "error":
      logger.warn(
        { vmId, code: frame.code, message: frame.message },
        "VM reported an error",
      );
      return [];
  }
}
