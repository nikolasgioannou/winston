import type { Context } from "hono";
import type { z } from "zod";

const errors = {
  invalid_request: { status: 400, message: "The request is invalid." },
  unauthorized: { status: 401, message: "Authentication is required." },
  forbidden: { status: 403, message: "This credential cannot access this route." },
  not_found: { status: 404, message: "The route does not exist." },
  body_too_large: { status: 413, message: "The request body is too large." },
  unsupported_media_type: { status: 415, message: "A JSON request body is required." },
  unavailable: { status: 503, message: "The service is not ready." },
  internal_error: { status: 500, message: "The request could not be completed." },
} as const;

export class RequestError extends Error {
  constructor(readonly code: keyof typeof errors) {
    super(errors[code].message);
  }
}

export function errorResponse(code: keyof typeof errors, requestId: string) {
  return Response.json(
    { error: { code, message: errors[code].message, requestId } },
    {
      status: errors[code].status,
      headers: { "X-Request-ID": requestId, "Cache-Control": "no-store" },
    },
  );
}

export async function parseJson<Output>(context: Context, schema: z.ZodType<Output>) {
  const mediaType = context.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase();

  if (mediaType !== "application/json") {
    throw new RequestError("unsupported_media_type");
  }

  let value: unknown;

  try {
    value = await context.req.json<unknown>();
  } catch {
    throw new RequestError("invalid_request");
  }

  const result = schema.safeParse(value);

  if (!result.success) {
    throw new RequestError("invalid_request");
  }

  return result.data;
}
