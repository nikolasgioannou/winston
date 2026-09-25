import type { Context } from "hono";
import {
  deviceFileUploadSchema,
  type DeviceFileUpload,
  type DeviceFileUploadResult,
} from "@winston/contracts/artifacts";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export type DeviceFileReceiver = (
  ownerId: string,
  authenticatedDeviceId: string,
  request: DeviceFileUpload,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) => Promise<DeviceFileUploadResult>;

export async function receiveDeviceFileResponse(
  context: Context<HttpEnvironment>,
  receive?: DeviceFileReceiver,
) {
  const body = context.req.raw.body;
  try {
    const identity = context.get("identity");
    if (identity.kind !== "device") throw new RequestError("unauthorized");
    if (!receive) throw new RequestError("unavailable");
    if (context.req.header("content-type") !== "application/octet-stream")
      throw new RequestError("invalid_request");
    const encoded = context.req.header("X-Winston-File");
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded))
      throw new RequestError("invalid_request");
    let request: DeviceFileUpload;
    try {
      request = deviceFileUploadSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
    } catch {
      throw new RequestError("invalid_request");
    }
    if (request.authority.session.deviceId !== identity.deviceId)
      throw new RequestError("forbidden");
    const length = context.req.header("content-length");
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== request.size))
      throw new RequestError("invalid_request");
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(50_000)]);
    let failure: RequestError | undefined;
    async function* chunks() {
      if (!body) {
        if (request.size !== 0) {
          failure = new RequestError("invalid_request");
          throw failure;
        }
        return;
      }
      const reader = body.getReader();
      const abort = () => {
        reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      let size = 0;
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) {
            failure = new RequestError("invalid_request");
            throw failure;
          }
          size += chunk.byteLength;
          if (size > request.size) {
            failure = new RequestError("body_too_large");
            throw failure;
          }
          yield chunk;
        }
        signal.throwIfAborted();
        if (size !== request.size) {
          failure = new RequestError("invalid_request");
          throw failure;
        }
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    const result = await receive(identity.ownerId, identity.deviceId, request, chunks(), signal);
    if (failure) throw failure;
    return context.json(result);
  } finally {
    if (body && !body.locked) await body.cancel().catch(() => {});
  }
}
