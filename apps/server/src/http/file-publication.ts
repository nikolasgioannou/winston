import type { Context } from "hono";
import { filePublicationSchema, type FilePublication } from "@winston/contracts/artifacts";
import type { ServiceRequest } from "@winston/contracts/capabilities";
import type { CliResult } from "@winston/contracts/cli";
import type { HttpEnvironment } from "./app";
import { RequestError } from "./errors";

export type FilePublisher = (
  credential: ServiceRequest,
  request: FilePublication,
  source: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
) => Promise<CliResult>;

export async function publishFileResponse(
  context: Context<HttpEnvironment>,
  credential: ServiceRequest,
  publish?: FilePublisher,
) {
  const body = context.req.raw.body;
  try {
    if (!publish)
      return context.json({
        version: 1,
        status: "unavailable",
        message: "File publication is not configured.",
      });
    if (context.req.header("content-type") !== "application/octet-stream")
      throw new RequestError("invalid_request");
    const encoded = context.req.header("X-Winston-File");
    if (!encoded || encoded.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(encoded))
      throw new RequestError("invalid_request");
    let metadata: FilePublication;
    try {
      metadata = filePublicationSchema.parse(
        JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
      );
    } catch {
      throw new RequestError("invalid_request");
    }
    const length = context.req.header("content-length");
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== metadata.size))
      throw new RequestError("invalid_request");
    const signal = AbortSignal.any([context.req.raw.signal, AbortSignal.timeout(50_000)]);
    async function* chunks() {
      if (!body) return;
      const reader = body.getReader();
      let size = 0;
      const abort = () => {
        reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        for (;;) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) break;
          const chunk: unknown = next.value;
          if (!(chunk instanceof Uint8Array)) throw new RequestError("invalid_request");
          size += chunk.byteLength;
          if (size > metadata.size) throw new RequestError("body_too_large");
          yield chunk;
        }
        if (size !== metadata.size) throw new RequestError("invalid_request");
      } finally {
        signal.removeEventListener("abort", abort);
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
    return context.json(await publish(credential, metadata, chunks(), signal));
  } finally {
    if (body && !body.locked) await body.cancel().catch(() => {});
  }
}
