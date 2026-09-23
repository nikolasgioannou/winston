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
import type { ResolvedTarget } from "@winston/contracts/connection-targets";
import type { createDatabase } from "../database";
import type { GoogleConnections } from "./index";
import { createConnectionTargets } from "./targets";
import { sameResolvedTarget } from "./target-resolution";
import { attachmentMetadata, decodeGmailBody, gmailParts, readGmailMessage } from "./gmail-mime";

export class GmailReadError extends Error {
  constructor(
    readonly kind: "denied" | "approval_required" | "stale" | "unavailable" | "too_large",
  ) {
    super(`Gmail read ${kind}.`);
  }
}

async function boundedJson(response: Response) {
  const limit = 40 * 1024 * 1024;
  if (!response.body) throw new GmailReadError("unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size <= limit) {
      const next = await reader.read();
      if (next.done) break;
      const chunk: unknown = next.value;
      if (!(chunk instanceof Uint8Array)) throw new GmailReadError("unavailable");
      size += chunk.length;
      if (size > limit) throw new GmailReadError("too_large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createGmailReader(options: {
  database: ReturnType<typeof createDatabase>;
  google: Pick<GoogleConnections, "list" | "calendars" | "access" | "rejected">;
  fetch?: (url: URL, init: RequestInit) => Promise<Response>;
}) {
  const { database, google } = options;
  const targets = createConnectionTargets(database, google);

  async function request(
    ownerId: string,
    target: ResolvedTarget,
    path: string,
    query: URLSearchParams,
    signal: AbortSignal,
  ) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const selected = await targets.resolve(
      ownerId,
      {
        operation: "gmail.read",
        ...(target.task
          ? { task: target.task }
          : {
              explicit: { connectionId: target.connectionId, calendarId: null },
            }),
      },
      deadline,
    );
    if (selected.status !== "resolved" || !sameResolvedTarget(selected.target, target))
      throw new GmailReadError("stale");
    const action = {
      target: { kind: "connection" as const, id: target.connectionId, resource: null },
      operation: "gmail.read" as const,
    };
    const initial = await database.transaction(ownerId, (scope) =>
      scope.authorization.evaluate(action),
    );
    if (initial.decision === "ask") throw new GmailReadError("approval_required");
    if (initial.decision !== "allow" || !initial.snapshot) throw new GmailReadError("denied");
    const access = await google.access(ownerId, target.connectionId, deadline);
    const allowed = await database.transaction(ownerId, async (scope) => {
      const policy = await scope.authorization.evaluate(action, initial.snapshot ?? undefined);
      const credential = await scope.credentials.find(target.connectionId);
      const preferences = await scope.connectionTargets.preferences();
      const currentTask = await scope.connectionTargets.currentTask({
        operation: "gmail.read",
        ...(target.task ? { task: target.task } : {}),
      });
      return (
        policy.decision === "allow" &&
        credential?.revision === access.revision &&
        preferences.revision === target.preferencesRevision &&
        currentTask
      );
    });
    if (!allowed) throw new GmailReadError("stale");
    deadline.throwIfAborted();
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`);
    url.search = query.toString();
    try {
      const response = await (options.fetch ?? fetch)(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${access.grant.accessToken}` },
        redirect: "error",
        cache: "no-store",
        signal: deadline,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 401)
          await google.rejected(ownerId, target.connectionId, access.revision);
        throw new GmailReadError("unavailable");
      }
      const data = await boundedJson(response);
      return { source: selected.target, data };
    } catch (error) {
      if (error instanceof GmailReadError) throw error;
      // Provider errors can contain credentials or message content; do not propagate them.
      throw new GmailReadError("unavailable");
    }
  }

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
