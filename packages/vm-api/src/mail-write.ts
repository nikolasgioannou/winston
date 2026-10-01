/**
 * The write side of `winston mail` (docs/design.md §11, §5 Permissions):
 * send, reply, forward (each as a draft with `draft`), sending a draft,
 * update and delete. Each checks its capability on the server (`send`;
 * `draft` for drafts; `modify_labels` for update and delete), and every real
 * write goes through the audit log. `dryRun` returns exactly what would be
 * sent or changed and touches nothing, after the same checks, so a disabled
 * capability shows up before the user is asked to confirm.
 */
import { forwardOf, replyTo } from "@winston/connectors/mail-compose";
import type {
  FullMailMessage,
  MailChanges,
  OutgoingMail,
} from "@winston/connectors/mail";
import { audited } from "@winston/db/audit";
import type { DbOrTx } from "@winston/db/client";
import {
  refFor,
  resolveRef,
  type ExternalRef,
} from "@winston/db/external-refs";
import { connections, users } from "@winston/db/schema";
import { formatInTimeZone } from "@winston/shared/time";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import { basename } from "node:path";
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

const vmPath = z.string().startsWith("/home/winston/");
const addresses = z.array(z.string().min(3)).max(100);

const sendBody = z.object({
  account: z.string().optional(),
  to: addresses.min(1, "needs at least one --to"),
  cc: addresses.default([]),
  bcc: addresses.default([]),
  subject: z.string(),
  body: z.string(),
  attach: z.array(vmPath).max(20).default([]),
  draft: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const replyBody = z.object({
  body: z.string(),
  all: z.boolean().default(false),
  attach: z.array(vmPath).max(20).default([]),
  draft: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const forwardBody = z.object({
  to: addresses.min(1, "needs at least one --to"),
  cc: addresses.default([]),
  bcc: addresses.default([]),
  body: z.string().optional(),
  attach: z.array(vmPath).max(20).default([]),
  draft: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

const dryRunBody = z.object({ dryRun: z.boolean().default(false) });

const ids = z.array(z.string().min(1)).min(1, "needs at least one id").max(100);

const updateBody = z.object({
  ids,
  read: z.boolean().optional(),
  starred: z.boolean().optional(),
  archived: z.boolean().optional(),
  addLabels: z.array(z.string().min(1)).default([]),
  removeLabels: z.array(z.string().min(1)).default([]),
  dryRun: z.boolean().default(false),
});

const deleteBody = z.object({ ids, dryRun: z.boolean().default(false) });

/** A JSON body checked against `schema`, failing as `invalid_request`. */
const body = <T extends z.ZodType>(schema: T, hint: string) =>
  validator("json", (value) => {
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new ApiFailure(
        "invalid_request",
        z.prettifyError(parsed.error),
        hint,
      );
    return parsed.data;
  });

/** What a send would do, as a dry run shows it. */
export interface MailPreview {
  dryRun: true;
  draft: boolean;
  account: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
  attachments: string[];
  threadId: string | null;
}

export function mailWriteRoutes({
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

  /** Files from the VM, attached by name; the type follows the extension. */
  async function attachments(userId: string, paths: string[]) {
    if (paths.length === 0) return [];
    if (!vmFiles)
      throw new ApiFailure(
        "unavailable",
        "Attaching files isn't available here.",
      );
    return Promise.all(
      paths.map(async (path) => ({
        filename: basename(path),
        mimeType:
          Bun.file(path).type.split(";")[0] ?? "application/octet-stream",
        data: await vmFiles.read(userId, path),
      })),
    );
  }

  /** A CLI id's provider object and connection, checked for `capability`. */
  async function target(
    userId: string,
    id: string,
    kinds: ExternalRef["kind"][],
    capability: Parameters<typeof requireCapability>[1],
  ) {
    const ref = await resolveRef(db, userId, id);
    if (!ref || !kinds.includes(ref.kind))
      throw new ApiFailure(
        "not_found",
        `There's no ${id}.`,
        "Use an id from winston mail list, search or get.",
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
    requireCapability(connection, capability, need().webPublicUrl);
    return { ref, connection };
  }

  const preview = (
    connection: ConnectionRow,
    mail: OutgoingMail,
    draft: boolean,
    threadId: string | null,
  ): MailPreview => ({
    dryRun: true,
    draft,
    account: connection.externalEmail,
    to: mail.to,
    cc: mail.cc ?? [],
    bcc: mail.bcc ?? [],
    subject: mail.subject,
    body: mail.body,
    attachments: (mail.attachments ?? []).map((a) => a.filename),
    threadId,
  });

  /** Sends or drafts `mail`, on record; returns the CLI ids of what was made. */
  async function deliver(
    userId: string,
    runId: string,
    connection: ConnectionRow,
    mail: OutgoingMail,
    draft: boolean,
    action: string,
    targetRef: string | undefined,
  ) {
    const provider = need().mail(connection);
    const entry = {
      userId,
      runId,
      connectionId: connection.id,
      targetRef,
      request: {
        to: mail.to,
        cc: mail.cc ?? [],
        bcc: mail.bcc ?? [],
        subject: mail.subject,
        body: mail.body,
        attachments: (mail.attachments ?? []).map((a) => a.filename),
      },
    };
    const recipients = [...mail.to, ...(mail.cc ?? [])].join(", ");
    if (draft) {
      const made = await audited(
        db,
        {
          ...entry,
          action: "mail.draft",
          summary: `Drafted to ${recipients}: ${mail.subject}`,
        },
        () => provider.createDraft(mail),
        (result) => result.messageId,
      );
      return {
        draft: {
          id: await refFor(db, userId, connection.id, "draft", made.draftId),
          messageId: await refFor(
            db,
            userId,
            connection.id,
            "message",
            made.messageId,
          ),
          threadId: await refFor(
            db,
            userId,
            connection.id,
            "thread",
            made.threadId,
          ),
        },
      };
    }
    const sent = await audited(
      db,
      { ...entry, action, summary: `Sent to ${recipients}: ${mail.subject}` },
      () => provider.send(mail),
      (result) => result.messageId,
    );
    return {
      sent: {
        id: await refFor(db, userId, connection.id, "message", sent.messageId),
        threadId: await refFor(
          db,
          userId,
          connection.id,
          "thread",
          sent.threadId,
        ),
      },
    };
  }

  const account = (connection: ConnectionRow) => ({
    id: connection.id,
    email: connection.externalEmail,
  });

  /** The original of a reply or forward: a message, or a thread's latest message. */
  async function originalOf(
    connection: ConnectionRow,
    ref: ExternalRef,
  ): Promise<FullMailMessage> {
    const provider = need().mail(connection);
    if (ref.kind === "message") return provider.getMessage(ref.providerId);
    const thread = await provider.getThread(ref.providerId);
    const latest = thread.messages.at(-1);
    if (!latest)
      throw new ApiFailure("not_found", "That thread has no messages.");
    return latest;
  }

  const timeZoneOf = async (userId: string) =>
    (
      await db
        .select({ timeZone: users.timezone })
        .from(users)
        .where(eq(users.id, userId))
    )[0]?.timeZone ?? "UTC";

  /** Messages, threads and drafts by connection, for update and delete. */
  async function grouped(
    userId: string,
    list: string[],
    kinds: ExternalRef["kind"][],
  ) {
    const groups = new Map<
      string,
      { connection: ConnectionRow; refs: ExternalRef[] }
    >();
    for (const id of list) {
      const { ref, connection } = await target(
        userId,
        id,
        kinds,
        "modify_labels",
      );
      const group = groups.get(connection.id) ?? { connection, refs: [] };
      group.refs.push(ref);
      groups.set(connection.id, group);
    }
    return [...groups.values()];
  }

  const byKind = (refs: ExternalRef[], kind: ExternalRef["kind"]) =>
    refs.filter((r) => r.kind === kind).map((r) => r.providerId);

  return new Hono<VmApiEnv>()
    .post(
      "/send",
      body(sendBody, "Run winston mail send --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const connection = await resolveConnection(
          db,
          userId,
          "mail",
          input.account,
        );
        requireCapability(
          connection,
          input.draft ? "draft" : "send",
          need().webPublicUrl,
        );
        const mail: OutgoingMail = {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          subject: input.subject,
          body: input.body,
          attachments: await attachments(userId, input.attach),
        };
        if (input.dryRun)
          return c.json({
            account: account(connection),
            preview: preview(connection, mail, input.draft, null),
          });
        return c.json({
          account: account(connection),
          ...(await deliver(
            userId,
            runId,
            connection,
            mail,
            input.draft,
            "mail.send",
            undefined,
          )),
        });
      },
    )
    .post(
      "/drafts/:id/send",
      body(dryRunBody, "Pass a drf_ id."),
      async (c) => {
        const { dryRun } = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        const { ref, connection } = await target(userId, id, ["draft"], "send");
        const provider = need().mail(connection);
        if (dryRun) {
          const draft = await provider.getDraft(ref.providerId);
          return c.json({
            account: account(connection),
            preview: {
              ...preview(
                connection,
                {
                  to: draft.to.map((a) => a.email),
                  cc: draft.cc.map((a) => a.email),
                  subject: draft.subject,
                  body: draft.body,
                  attachments: draft.attachments.map((a) => ({
                    filename: a.filename,
                    mimeType: a.mimeType,
                    data: new Uint8Array(),
                  })),
                },
                false,
                await refFor(
                  db,
                  userId,
                  connection.id,
                  "thread",
                  draft.threadId,
                ),
              ),
            },
          });
        }
        const sent = await audited(
          db,
          {
            userId,
            runId,
            connectionId: connection.id,
            action: "mail.send_draft",
            targetRef: id,
            summary: `Sent draft ${id}`,
            request: { draft: id },
          },
          () => provider.sendDraft(ref.providerId),
          (result) => result.messageId,
        );
        return c.json({
          account: account(connection),
          sent: {
            id: await refFor(
              db,
              userId,
              connection.id,
              "message",
              sent.messageId,
            ),
            threadId: await refFor(
              db,
              userId,
              connection.id,
              "thread",
              sent.threadId,
            ),
          },
        });
      },
    )
    .post(
      "/messages/:id/reply",
      body(replyBody, "Run winston mail reply --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        const { ref, connection } = await target(
          userId,
          id,
          ["message", "thread"],
          input.draft ? "draft" : "send",
        );
        const original = await originalOf(connection, ref);
        const mail: OutgoingMail = {
          ...replyTo(original, {
            body: input.body,
            all: input.all,
            self: connection.externalEmail,
          }),
          attachments: await attachments(userId, input.attach),
        };
        if (mail.to.length === 0)
          throw new ApiFailure(
            "invalid_request",
            "There's no one to reply to.",
            "Use winston mail send with --to instead.",
          );
        const threadId = await refFor(
          db,
          userId,
          connection.id,
          "thread",
          original.threadId,
        );
        if (input.dryRun)
          return c.json({
            account: account(connection),
            preview: preview(connection, mail, input.draft, threadId),
          });
        return c.json({
          account: account(connection),
          ...(await deliver(
            userId,
            runId,
            connection,
            mail,
            input.draft,
            "mail.reply",
            id,
          )),
        });
      },
    )
    .post(
      "/messages/:id/forward",
      body(forwardBody, "Run winston mail forward --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const id = c.req.param("id");
        const { ref, connection } = await target(
          userId,
          id,
          ["message", "thread"],
          input.draft ? "draft" : "send",
        );
        const original = await originalOf(connection, ref);
        const provider = need().mail(connection);
        // The original's attachments go along, plus any added ones.
        const kept = input.dryRun
          ? original.attachments.map((a) => ({
              filename: a.filename,
              mimeType: a.mimeType,
              data: new Uint8Array(),
            }))
          : await Promise.all(
              original.attachments.map((a) =>
                provider.getAttachment(a.providerId),
              ),
            );
        const mail = forwardOf(original, {
          to: input.to,
          cc: input.cc,
          bcc: input.bcc,
          body: input.body,
          attachments: [...kept, ...(await attachments(userId, input.attach))],
          date: formatInTimeZone(original.date, await timeZoneOf(userId)),
        });
        const threadId = await refFor(
          db,
          userId,
          connection.id,
          "thread",
          original.threadId,
        );
        if (input.dryRun)
          return c.json({
            account: account(connection),
            preview: preview(connection, mail, input.draft, threadId),
          });
        return c.json({
          account: account(connection),
          ...(await deliver(
            userId,
            runId,
            connection,
            mail,
            input.draft,
            "mail.forward",
            id,
          )),
        });
      },
    )
    .post(
      "/update",
      body(updateBody, "Run winston mail update --help for the flags."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const changes: MailChanges = {
          read: input.read,
          starred: input.starred,
          archived: input.archived,
          addLabels: input.addLabels,
          removeLabels: input.removeLabels,
        };
        const nothing =
          input.read === undefined &&
          input.starred === undefined &&
          input.archived === undefined &&
          input.addLabels.length === 0 &&
          input.removeLabels.length === 0;
        if (nothing)
          throw new ApiFailure(
            "invalid_request",
            "Nothing to change.",
            "Pass --read, --archive, --star, --add-label and so on.",
          );
        const groups = await grouped(userId, input.ids, ["message", "thread"]);
        if (!input.dryRun)
          for (const { connection, refs } of groups)
            await audited(
              db,
              {
                userId,
                runId,
                connectionId: connection.id,
                action: "mail.update",
                targetRef: refs.map((r) => r.id).join(" "),
                summary: `Updated ${String(refs.length)} in ${connection.externalEmail}`,
                request: { ids: refs.map((r) => r.id), ...changes },
              },
              () =>
                need()
                  .mail(connection)
                  .modify(
                    {
                      messages: byKind(refs, "message"),
                      threads: byKind(refs, "thread"),
                    },
                    changes,
                  ),
            );
        return c.json({ dryRun: input.dryRun, updated: input.ids, changes });
      },
    )
    .post(
      "/delete",
      body(deleteBody, "Pass msg_, thr_ or drf_ ids."),
      async (c) => {
        const input = c.req.valid("json");
        const { userId, runId } = c.get("run");
        const groups = await grouped(userId, input.ids, [
          "message",
          "thread",
          "draft",
        ]);
        if (!input.dryRun)
          for (const { connection, refs } of groups)
            await audited(
              db,
              {
                userId,
                runId,
                connectionId: connection.id,
                action: "mail.delete",
                targetRef: refs.map((r) => r.id).join(" "),
                summary: `Moved ${String(refs.length)} to the trash in ${connection.externalEmail}`,
                request: { ids: refs.map((r) => r.id) },
              },
              () =>
                need()
                  .mail(connection)
                  .trash({
                    messages: byKind(refs, "message"),
                    threads: byKind(refs, "thread"),
                    drafts: byKind(refs, "draft"),
                  }),
            );
        return c.json({ dryRun: input.dryRun, trashed: input.ids });
      },
    );
}
