import {
  gmailDraftSearchSchema,
  gmailDraftPageSchema,
  gmailDraftSchema,
  gmailMessageRequestSchema,
  type GmailDraftSearch,
  type GmailMessageRequest,
} from "@winston/contracts/gmail";
import { createGoogleReadRequest, type GoogleReadOptions } from "./read-request";
import { GmailReadError } from "./gmail";
import { readGmailMessage } from "./gmail-mime";

export function createGmailDraftReader(options: GoogleReadOptions) {
  const request = createGoogleReadRequest(options, {
    service: "gmail",
    error: (kind) => new GmailReadError(kind),
  });
  return {
    async drafts(ownerId: string, input: GmailDraftSearch, signal: AbortSignal) {
      const parsed = gmailDraftSearchSchema.parse(input);
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
      const result = await request(ownerId, parsed.target, "drafts", query, signal);
      const page = gmailDraftPageSchema.parse(result.data);
      if (page.drafts.length > parsed.limit) throw new GmailReadError("unavailable");
      return {
        source: result.source,
        drafts: page.drafts,
        cursor: page.nextPageToken
          ? {
              kind: "drafts" as const,
              connectionId: result.source.connectionId,
              query: parsed.query,
              pageToken: page.nextPageToken,
            }
          : null,
      };
    },
    async draft(ownerId: string, input: GmailMessageRequest, signal: AbortSignal) {
      const parsed = gmailMessageRequestSchema.parse(input);
      const result = await request(
        ownerId,
        parsed.target,
        `drafts/${encodeURIComponent(parsed.id)}`,
        new URLSearchParams({ format: "full" }),
        signal,
      );
      const draft = gmailDraftSchema.parse(result.data);
      if (draft.id !== parsed.id) throw new GmailReadError("unavailable");
      return {
        source: result.source,
        trust: "untrusted_external_content" as const,
        id: draft.id,
        message: readGmailMessage(draft.message, result.source),
      };
    },
  };
}
