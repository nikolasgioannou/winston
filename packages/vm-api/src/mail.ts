/**
 * The read side of `winston mail` (docs/design.md §11): list and search,
 * get, and downloading attachments. Every route resolves `--account`, checks
 * the `read` capability on the server, and turns provider ids into the CLI's
 * stable ids (`msg_`, `thr_`, `att_`).
 */
import type {
  MailAddress,
  MailFolder,
  MailMessage,
} from "@winston/connectors/mail";
import type { DbOrTx } from "@winston/db/client";
import { refsFor, resolveRef } from "@winston/db/external-refs";
import { connections, users } from "@winston/db/schema";
import { parseTimeFlag } from "@winston/shared/time-flag";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { z } from "zod";
import {
  ApiFailure,
  requireCapability,
  resolveConnection,
  type ConnectionRow,
  type ConnectorDeps,
} from "./connections.ts";
import type { VmApiEnv } from "./env.ts";
import type { VmFiles } from "./files.ts";

export const mailFolders = [
  "inbox",
  "sent",
  "drafts",
  "archive",
  "all",
] as const satisfies readonly MailFolder[];

const flag = z.enum(["true", "false"]).transform((value) => value === "true");

const listQuery = z.object({
  account: z.string().optional(),
  in: z.enum(mailFolders).default("inbox"),
  text: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
  unread: flag.optional(),
  has_attachment: flag.optional(),
  label: z.string().optional(),
  category: z.string().optional(),
  native: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const saveBody = z.object({ path: z.string().startsWith("/home/winston/") });

export interface MessageSummary {
  id: string;
  threadId: string;
  date: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  snippet: string;
  unread: boolean;
  starred: boolean;
  inInbox: boolean;
  labels: string[];
  attachmentCount: number;
}

export interface AttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageDetail extends MessageSummary {
  body: string;
  quotedTextHidden: boolean;
  replyTo: MailAddress[];
  attachments: AttachmentSummary[];
}

const invalid = (error: z.ZodError, hint: string) =>
  new ApiFailure("invalid_request", z.prettifyError(error), hint);

export function mailRoutes({
  db,
  connectors,
  vmFiles,
}: {
  db: DbOrTx;
  connectors: ConnectorDeps | undefined;
  vmFiles: VmFiles | undefined;
}) {
  const need = () => {
    if (!connectors)
      throw new ApiFailure(
        "unavailable",
        "Connected apps aren't available here.",
      );
    return connectors;
  };

  /** The user's time zone: times in and out are in it. */
  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** CLI ids for a page of messages, their threads and attachments. */
  async function ids(
    userId: string,
    connection: ConnectionRow,
    messages: MailMessage[],
  ) {
    const [messageIds, threadIds, attachmentIds] = await Promise.all([
      refsFor(
        db,
        userId,
        connection.id,
        "message",
        messages.map((m) => m.providerId),
      ),
      refsFor(
        db,
        userId,
        connection.id,
        "thread",
        messages.map((m) => m.threadId),
      ),
      refsFor(
        db,
        userId,
        connection.id,
        "attachment",
        messages.flatMap((m) => m.attachments.map((a) => a.providerId)),
      ),
    ]);
    const summary = (message: MailMessage): MessageSummary => ({
      id: messageIds.get(message.providerId) ?? "",
      threadId: threadIds.get(message.threadId) ?? "",
      date: message.date.toISOString(),
      from: message.from,
      to: message.to,
      cc: message.cc,
      subject: message.subject,
      snippet: message.snippet,
      unread: message.unread,
      starred: message.starred,
      inInbox: message.inInbox,
      labels: message.labels,
      attachmentCount: message.attachments.length,
    });
    const attachments = (message: MailMessage): AttachmentSummary[] =>
      message.attachments.map((a) => ({
        id: attachmentIds.get(a.providerId) ?? "",
        filename: a.filename,
        mimeType: a.mimeType,
        size: a.size,
      }));
    return { summary, attachments };
  }

  /** The connection behind a CLI id, checked for reading. */
  async function owned(userId: string, id: string, kinds: string[]) {
    const ref = await resolveRef(db, userId, id);
    if (!ref || !kinds.includes(ref.kind))
      throw new ApiFailure(
        "not_found",
        `There's no ${id}.`,
        "Use an id from winston mail list or search.",
      );
    const [connection] = await db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.id, ref.connectionId),
          eq(connections.userId, userId),
        ),
      );
    if (!connection) throw new ApiFailure("not_found", `There's no ${id}.`);
    requireCapability(connection, "read", need().webPublicUrl);
    return { ref, connection };
  }

  return new Hono<VmApiEnv>()
    .get("/messages", async (c) => {
      const deps = need();
      const parsed = listQuery.safeParse(c.req.query());
      if (!parsed.success)
        throw invalid(
          parsed.error,
          "Run winston mail list --help for the flags.",
        );
      const query = parsed.data;
      const { userId } = c.get("run");
      const connection = await resolveConnection(
        db,
        userId,
        "mail",
        query.account,
      );
      requireCapability(connection, "read", deps.webPublicUrl);
      const timeZone = await timeZoneOf(userId);
      const time = (input: string | undefined) =>
        input === undefined
          ? undefined
          : parseTimeFlag(input, { timeZone, direction: "past" });
      const page = await deps.mail(connection).list(
        {
          folder: query.in,
          text: query.text,
          from: query.from,
          to: query.to,
          subject: query.subject,
          unread: query.unread,
          hasAttachment: query.has_attachment,
          label: query.label,
          category: query.category,
          native: query.native,
          since: time(query.since),
          until: time(query.until),
        },
        { limit: query.limit, cursor: query.cursor },
      );
      const { summary } = await ids(userId, connection, page.items);
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        timeZone,
        messages: page.items.map(summary),
        cursor: page.cursor,
        estimatedTotal: page.estimatedTotal,
      });
    })
    .get("/messages/:id", async (c) => {
      const { userId } = c.get("run");
      const { ref, connection } = await owned(userId, c.req.param("id"), [
        "message",
        "thread",
      ]);
      const mail = need().mail(connection);
      const messages =
        ref.kind === "thread"
          ? (await mail.getThread(ref.providerId)).messages
          : [await mail.getMessage(ref.providerId)];
      const { summary, attachments } = await ids(userId, connection, messages);
      const detail = messages.map((message): MessageDetail => ({
        ...summary(message),
        body: message.body,
        quotedTextHidden: message.quotedTextHidden,
        replyTo: message.replyTo,
        attachments: attachments(message),
      }));
      return c.json({
        account: { id: connection.id, email: connection.externalEmail },
        timeZone: await timeZoneOf(userId),
        kind:
          ref.kind === "thread" ? ("thread" as const) : ("message" as const),
        messages: detail,
      });
    })
    .get("/attachments/:id", async (c) => {
      const { userId } = c.get("run");
      const id = c.req.param("id");
      const { ref, connection } = await owned(userId, id, ["attachment"]);
      const file = await need().mail(connection).getAttachment(ref.providerId);
      return c.json({
        id,
        filename: file.filename,
        mimeType: file.mimeType,
        size: file.data.length,
      });
    })
    .post(
      "/attachments/:id/save",
      validator("json", (value) => {
        const body = saveBody.safeParse(value);
        if (!body.success)
          throw invalid(
            body.error,
            "Save under /home/winston, for example ~/downloads.",
          );
        return body.data;
      }),
      async (c) => {
        const { userId } = c.get("run");
        const id = c.req.param("id");
        const { path } = c.req.valid("json");
        const { ref, connection } = await owned(userId, id, ["attachment"]);
        if (!vmFiles)
          throw new ApiFailure(
            "unavailable",
            "Saving files isn't available here.",
          );
        const file = await need()
          .mail(connection)
          .getAttachment(ref.providerId);
        const { size } = await vmFiles.write(userId, path, file.data);
        return c.json({ id, path, size });
      },
    );
}
