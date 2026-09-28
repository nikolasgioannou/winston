/**
 * The run token (docs/design.md §15): set as `WINSTON_RUN_TOKEN` for every
 * `bash` command, so CLI calls from that command are attributed to their
 * run. It's signed with the backend's secret, short-lived, and only accepted
 * over that VM's websocket, so it's useless if exfiltrated.
 */
import { signPayload, verifySignedPayload } from "@winston/shared/signed";

export type RunKind = "front" | "background";

export interface RunToken {
  runId: string;
  userId: string;
  kind: RunKind;
  /** Expiry, in milliseconds since the epoch. */
  exp: number;
}

export function mintRunToken(
  secret: string,
  run: { runId: string; userId: string; kind: RunKind },
  ttlMs: number,
  now = Date.now(),
) {
  const token: RunToken = { ...run, exp: now + ttlMs };
  return signPayload(token, secret);
}

export function verifyRunToken(
  secret: string,
  token: string,
  now = Date.now(),
) {
  const payload = verifySignedPayload(token, secret, now);
  if (
    typeof payload?.runId !== "string" ||
    typeof payload.userId !== "string" ||
    (payload.kind !== "front" && payload.kind !== "background")
  )
    return undefined;
  return payload as unknown as RunToken;
}
