import {
  gmailAttachmentRequestSchema,
  gmailListPageSchema,
  gmailMessageRequestSchema,
  gmailMessageSchema,
  gmailPartBodySchema,
  gmailSearchSchema,
  gmailThreadSchema,
  type GmailAttachmentRequest,
  type GmailMessageRequest,
  type GmailSearch,
} from "@winston/contracts/gmail";
import {
  createGoogleReadRequest,
  GoogleReadError,
  type GoogleReadFailure,
  type GoogleReadOptions,
} from "./read-request";
import { attachmentMetadata, decodeGmailBody, gmailParts, readGmailMessage } from "./gmail-mime";

export class GmailReadError extends GoogleReadError {
  constructor(kind: GoogleReadFailure) {
    super(kind, "Gmail");
  }
}

export function createGmailReader(options: GoogleReadOptions) {
  const request = createGoogleReadRequest(options, {
    service: "gmail",
    error: (kind) => new GmailReadError(kind),
  });

  async function message(ownerId: string, input: GmailMessageRequest, signal: AbortSignal) {
    const parsed = gmailMessageRequestSchema.parse(input);
    const result = await request(
      ownerId,
      parsed.target,
      `messages/${encodeURIComponent(parsed.id)}`,
      new URLSearchParams({ format: "full" }),
      signal,
    );
    const data = gmailMessageSchema.parse(result.data);
    if (data.id !== parsed.id) throw new GmailReadError("unavailable");
    return { ...result, data };
  }

  return {
    async search(ownerId: string, input: GmailSearch, signal: AbortSignal) {
      const parsed = gmailSearchSchema.parse(input);
      if (
        parsed.cursor &&
        (parsed.cursor.connectionId !== parsed.target.connectionId ||
          parsed.cursor.query !== parsed.query)
      )
        throw new GmailReadError("stale");
      const query = new URLSearchParams({
        q: parsed.query,
        maxResults: String(parsed.limit),
        includeSpamTrash: "false",
      });
      if (parsed.cursor) query.set("pageToken", parsed.cursor.pageToken);
      const result = await request(ownerId, parsed.target, "messages", query, signal);
      const page = gmailListPageSchema.parse(result.data);
      if (page.messages.length > parsed.limit) throw new GmailReadError("unavailable");
      return {
        source: result.source,
        messages: page.messages,
        cursor: page.nextPageToken
          ? {
              connectionId: result.source.connectionId,
              query: parsed.query,
              pageToken: page.nextPageToken,
            }
          : null,
      };
    },
    async message(ownerId: string, input: GmailMessageRequest, signal: AbortSignal) {
      const result = await message(ownerId, input, signal);
      return readGmailMessage(result.data, result.source);
    },
    async thread(ownerId: string, input: GmailMessageRequest, signal: AbortSignal) {
      const parsed = gmailMessageRequestSchema.parse(input);
      const result = await request(
        ownerId,
        parsed.target,
        `threads/${encodeURIComponent(parsed.id)}`,
        new URLSearchParams({ format: "full" }),
        signal,
      );
      const thread = gmailThreadSchema.parse(result.data);
      if (thread.id !== parsed.id || thread.messages.some((entry) => entry.threadId !== thread.id))
        throw new GmailReadError("unavailable");
      return {
        source: result.source,
        id: thread.id,
        messages: thread.messages
          .slice(0, 20)
          .map((entry) => readGmailMessage(entry, result.source)),
        truncated: thread.messages.length > 20,
        messageIds: thread.messages.map((entry) => entry.id),
      };
    },
    async attachment(ownerId: string, input: GmailAttachmentRequest, signal: AbortSignal) {
      const parsed = gmailAttachmentRequestSchema.parse(input);
      const result = await message(ownerId, { id: parsed.id, target: parsed.target }, signal);
      const part = gmailParts(result.data.payload).find((entry) => entry.partId === parsed.partId);
      if (!part || part.parts.length) throw new GmailReadError("unavailable");
      const body = part.body.attachmentId
        ? gmailPartBodySchema.parse(
            (
              await request(
                ownerId,
                parsed.target,
                `messages/${encodeURIComponent(parsed.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
                new URLSearchParams(),
                signal,
              )
            ).data,
          )
        : part.body;
      if (body.size !== part.body.size) throw new GmailReadError("unavailable");
      const bytes = decodeGmailBody(body.data ?? "", body.size);
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (signal.aborted) {
            controller.error(new GmailReadError("unavailable"));
            return;
          }
          if (offset === bytes.length) {
            controller.close();
            return;
          }
          const end = Math.min(bytes.length, offset + 64 * 1024);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      });
      return {
        source: result.source,
        metadata: attachmentMetadata(result.source, parsed.id, part),
        stream,
      };
    },
  };
}
