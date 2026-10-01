/**
 * Test helpers for the VM-facing API's connector routes: a recording fake
 * mail provider and a request helper with a run token.
 */
import type {
  FullMailMessage,
  MailChanges,
  MailFilter,
  MailProvider,
  OutgoingMail,
} from "@winston/connectors/mail";
import type { DbOrTx } from "@winston/db/client";
import { mintRunToken } from "@winston/domain/run-token";
import { createVmApi } from "./index.ts";

export const testSecret = "vm-api-test-secret-0123456789abcdef";

export const fakeMessage = (
  id: string,
  overrides: Partial<FullMailMessage> = {},
): FullMailMessage => ({
  providerId: id,
  threadId: "t-1",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: `Subject ${id}`,
  date: new Date("2026-09-25T20:02:00Z"),
  snippet: "snippet",
  unread: true,
  starred: false,
  inInbox: true,
  labels: [],
  attachments: [],
  messageIdHeader: `<${id}@mail.example.com>`,
  body: `Body of ${id}`,
  references: [],
  replyTo: [],
  quotedTextHidden: false,
  ...overrides,
});

export const withAttachment = fakeMessage("m-1", {
  attachments: [
    {
      providerId: "m-1/1",
      filename: "lease.pdf",
      mimeType: "application/pdf",
      size: 10,
    },
  ],
});

/** A mail provider that records what it's asked to do. */
export function fakeMail() {
  const filters: MailFilter[] = [];
  const sent: OutgoingMail[] = [];
  const drafted: OutgoingMail[] = [];
  const modified: {
    target: { messages?: string[]; threads?: string[] };
    changes: MailChanges;
  }[] = [];
  const trashed: {
    messages?: string[];
    threads?: string[];
    drafts?: string[];
  }[] = [];
  const draftsSent: string[] = [];
  const provider: MailProvider = {
    address: "me@example.com",
    list: (filter, page) => {
      filters.push(filter);
      return Promise.resolve({
        items: [withAttachment, fakeMessage("m-2")].slice(0, page.limit),
        cursor: "next-page",
        estimatedTotal: 7,
      });
    },
    getMessage: (id) =>
      Promise.resolve(id === "m-1" ? withAttachment : fakeMessage(id)),
    getThread: (id) =>
      Promise.resolve({
        providerId: id,
        subject: "Lease",
        messages: [fakeMessage("m-1"), fakeMessage("m-2")],
      }),
    getAttachment: () =>
      Promise.resolve({
        filename: "lease.pdf",
        mimeType: "application/pdf",
        data: new Uint8Array([1, 2, 3]),
      }),
    send: (mail) => {
      sent.push(mail);
      return Promise.resolve({
        messageId: "m-sent",
        threadId: mail.inReplyTo?.threadId ?? "t-new",
      });
    },
    createDraft: (mail) => {
      drafted.push(mail);
      return Promise.resolve({
        draftId: "r-1",
        messageId: "m-draft",
        threadId: "t-new",
      });
    },
    sendDraft: (id) => {
      draftsSent.push(id);
      return Promise.resolve({ messageId: "m-sent", threadId: "t-new" });
    },
    getDraft: () => Promise.resolve(fakeMessage("m-draft")),
    modify: (target, changes) => {
      modified.push({ target, changes });
      return Promise.resolve();
    },
    trash: (target) => {
      trashed.push(target);
      return Promise.resolve();
    },
  };
  return { provider, filters, sent, drafted, modified, trashed, draftsSent };
}

/** The API over `tx` with the fake provider and VM files; `as(userId)` makes calls. */
export function setupApi(
  tx: DbOrTx,
  vmFileContents: Record<string, string> = {},
) {
  const mail = fakeMail();
  const written: { userId: string; path: string; bytes: Uint8Array }[] = [];
  const app = createVmApi({
    db: tx,
    runTokenSecret: testSecret,
    connectors: {
      webPublicUrl: "https://runwinston.com",
      mail: () => mail.provider,
    },
    vmFiles: {
      read: (_userId, path) => {
        const contents = vmFileContents[path];
        return contents === undefined
          ? Promise.reject(new Error(`No file ${path}`))
          : Promise.resolve(new TextEncoder().encode(contents));
      },
      write: (userId, path, bytes) => {
        written.push({ userId, path, bytes });
        return Promise.resolve({ size: bytes.length });
      },
    },
  });
  const as = (userId: string, runId = "run_1") => {
    const token = mintRunToken(
      testSecret,
      { runId, userId, kind: "front" },
      60_000,
    );
    return (path: string, init: { method?: string; body?: unknown } = {}) =>
      app.request(
        path,
        {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(init.body === undefined
            ? {}
            : { body: JSON.stringify(init.body) }),
        },
        { vmUserId: userId },
      );
  };
  return { as, mail, written };
}
