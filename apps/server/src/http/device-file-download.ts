import type { Context } from "hono";
import {
  deviceFileDownloadSchema,
  type DeviceFileDownload,
} from "@winston/contracts/device-file-writes";
import type { DeviceFileSource } from "@winston/contracts/devices";
import type { HttpEnvironment } from "./app";
import { parseJson, RequestError } from "./errors";

export type DeviceFileDownloader = (
  ownerId: string,
  authenticatedDeviceId: string,
  request: DeviceFileDownload,
  signal: AbortSignal,
) => Promise<{ source: DeviceFileSource; body: ReadableStream<Uint8Array> } | null>;

export async function downloadDeviceFileResponse(
  context: Context<HttpEnvironment>,
  download?: DeviceFileDownloader,
) {
  const identity = context.get("identity");
  if (identity.kind !== "device") throw new RequestError("unauthorized");
  if (!download) throw new RequestError("unavailable");
  const request = await parseJson(context, deviceFileDownloadSchema);
  if (request.authority.session.deviceId !== identity.deviceId) throw new RequestError("forbidden");
  const result = await download(
    identity.ownerId,
    identity.deviceId,
    request,
    context.req.raw.signal,
  );
  if (!result) throw new RequestError("forbidden");
  return new Response(result.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(result.source.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Winston-File": Buffer.from(JSON.stringify({ version: 1, source: result.source })).toString(
        "base64url",
      ),
    },
  });
}
