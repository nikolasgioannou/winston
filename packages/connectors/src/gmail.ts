/**
 * Gmail's side of `MailProvider` (docs/design.md §3, §11 `winston mail`), over
 * the Gmail REST API with the connection's access token.
 *
 * - **Listing** is `messages.list` with a query (the portable filters
 *   translated by `gmailQuery`, or `--native` as is), then each message's
 *   metadata fetched in parallel, ten at a time. Gmail's batch endpoint would
 *   save round trips, but a page is at most a few dozen messages, each `get`
 *   costs 5 of the 250 quota units a user has per second, and parallel GETs
 *   keep the code plain.
 * - **Bodies** come from the MIME tree: the `text/plain` part when there is
 *   one, otherwise the HTML part converted to text (`html-to-text`). Quoted
 *   replies are hidden where they're marked reliably: Gmail's
 *   `div.gmail_quote`, Apple Mail's `blockquote[type=cite]`, Yahoo's
 *   `div.yahoo_quoted`, and plain-text tails that start "On … wrote:" and
 *   continue with `>` lines.
 * - **Attachments** are parts with a filename, except inline images
 *   (`Content-Disposition: inline` with a `Content-ID`). Gmail's attachment ids
 *   change between fetches, so an attachment is named `<message id>/<part id>`.
 */
import { readableBody } from "./mail-body.ts";
import { composeRaw } from "./mail-compose.ts";
import {
  NotSupportedError,
  ProviderNotFoundError,
  ProviderUnavailableError,
} from "./errors.ts";
import type {
  FullMailMessage,
  MailAddress,
  MailAttachment,
  MailFilter,
  MailFolder,
  MailMessage,
  MailProvider,
  MailThread,
  Page,
} from "./mail.ts";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";
const uploadApi = "https://gmail.googleapis.com/upload/gmail/v1/users/me";
const parallelGets = 10;

export interface GmailOptions {
  address: string;
  /** The connection's access token (googleAccessTokens). */
  accessToken: () => Promise<string>;
  fetch?: typeof fetch;
}

// Gmail's JSON, as far as it's read here.
interface GmailHeader {
  name: string;
  value: string;
}
interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

/** Quotes a query value when it has spaces or quotes of its own. */
const quoted = (value: string) =>
  /[\s"()]/.test(value) ? `"${value.replaceAll('"', "")}"` : value;

/** Where each portable folder is, in Gmail's search syntax. */
const folderQuery: Record<MailFolder, string | null> = {
  inbox: "in:inbox",
  sent: "in:sent",
  drafts: "in:drafts",
  // Gmail's archive: in All Mail, but not the inbox (nor spam or trash, which
  // search leaves out unless asked).
  archive: "-in:inbox -in:drafts",
  all: null,
};

/**
 * The portable filters as a Gmail query (docs/design.md §11, Domain flags).
 * `--native` replaces the structured filters but keeps the folder and time
 * range, so `--in` and `--since` mean the same everywhere.
 */
export function gmailQuery(filter: MailFilter): string {
  const terms: string[] = [];
  const folder = filter.folder ? folderQuery[filter.folder] : null;
  if (folder) terms.push(folder);
  if (filter.native) terms.push(filter.native);
  else {
    if (filter.from) terms.push(`from:${quoted(filter.from)}`);
    if (filter.to) terms.push(`to:${quoted(filter.to)}`);
    if (filter.subject) terms.push(`subject:${quoted(filter.subject)}`);
    if (filter.unread === true) terms.push("is:unread");
    if (filter.unread === false) terms.push("-is:unread");
    if (filter.hasAttachment) terms.push("has:attachment");
    if (filter.label) terms.push(`label:${quoted(filter.label)}`);
    if (filter.category)
      terms.push(`category:${filter.category.toLowerCase()}`);
    if (filter.text) terms.push(filter.text);
  }
  // Seconds since the epoch: Gmail's after/before take them exactly.
  if (filter.since)
    terms.push(`after:${String(Math.floor(filter.since.getTime() / 1000))}`);
  if (filter.until)
    terms.push(`before:${String(Math.ceil(filter.until.getTime() / 1000))}`);
  return terms.join(" ");
}

/** Parses an address list like `"Reyes, Dana" <dana@x.com>, sam@y.com`. */
export function parseAddresses(value: string | undefined): MailAddress[] {
  if (!value) return [];
  const addresses: MailAddress[] = [];
  let current = "";
  let inQuotes = false;
  let depth = 0;
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes;
    if (!inQuotes && char === "<") depth++;
    if (!inQuotes && char === ">") depth--;
    if (char === "," && !inQuotes && depth === 0) {
      addresses.push(...parseOne(current));
      current = "";
    } else current += char;
  }
  addresses.push(...parseOne(current));
  return addresses;
}

function parseOne(raw: string): MailAddress[] {
  const text = raw.trim();
  if (!text) return [];
  const angle = /^(.*)<([^>]+)>\s*$/.exec(text);
  if (angle) {
    const name = (angle[1] ?? "")
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    return [
      { name: name || null, email: (angle[2] ?? "").trim().toLowerCase() },
    ];
  }
  return [{ name: null, email: text.replace(/^"(.*)"$/, "$1").toLowerCase() }];
}

const header = (part: GmailPart | undefined, name: string) =>
  part?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
    ?.value;

/** Gmail's base64url body data, decoded in the part's charset. */
function decodeBody(part: GmailPart): string {
  const data = part.body?.data;
  if (!data) return "";
  const bytes = Buffer.from(data, "base64url");
  const charset =
    /charset="?([^";\s]+)"?/i.exec(header(part, "Content-Type") ?? "")?.[1] ??
    "utf-8";
  try {
    // Any WHATWG encoding label; an unknown one throws.
    return new TextDecoder(
      charset as ConstructorParameters<typeof TextDecoder>[0],
    ).decode(bytes);
  } catch {
    // An unknown charset label: UTF-8 is the best guess.
    return new TextDecoder().decode(bytes);
  }
}

/** Every leaf part, depth first (the order the sender wrote them). */
function leaves(part: GmailPart | undefined): GmailPart[] {
  if (!part) return [];
  if (part.parts?.length) return part.parts.flatMap(leaves);
  return [part];
}

function isAttachment(part: GmailPart) {
  if (!part.filename) return false;
  const disposition = (header(part, "Content-Disposition") ?? "").toLowerCase();
  const inlineImage =
    disposition.startsWith("inline") &&
    header(part, "Content-ID") !== undefined;
  return !inlineImage;
}

function attachmentsOf(message: GmailMessage): MailAttachment[] {
  return leaves(message.payload)
    .filter(isAttachment)
    .map((part) => ({
      providerId: `${message.id}/${part.partId ?? ""}`,
      filename: part.filename ?? "attachment",
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
    }));
}

/** The readable body: plain text if there is some, else the HTML as text. */
function bodyOf(message: GmailMessage) {
  const parts = leaves(message.payload).filter((part) => !isAttachment(part));
  const plain = parts.find((part) => part.mimeType === "text/plain");
  const html = parts.find((part) => part.mimeType === "text/html");
  return readableBody(
    plain ? decodeBody(plain) : undefined,
    html ? decodeBody(html) : undefined,
  );
}

/** Gmail's snippets come HTML-escaped. */
const unescapeSnippet = (snippet: string) =>
  snippet
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    );

export function gmailProvider({
  address,
  accessToken,
  fetch: send = fetch,
}: GmailOptions): MailProvider {
  async function call<T>(
    path: string,
    init: {
      method?: string;
      body?: string | Blob;
      contentType?: string;
      base?: string;
    } = {},
  ): Promise<T> {
    const response = await send(`${init.base ?? api}${path}`, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(init.contentType ? { "Content-Type": init.contentType } : {}),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    if (response.status === 404)
      throw new ProviderNotFoundError(
        "Gmail has no such message, thread or draft (it may have been deleted).",
      );
    if (response.status === 429 || response.status >= 500)
      throw new ProviderUnavailableError(
        `Gmail is busy (${String(response.status)}).`,
      );
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      throw new Error(
        `Gmail said ${String(response.status)}: ${body.error?.message ?? "no details"}`,
      );
    }
    // Some writes (trash of a thread, batchModify) answer with nothing.
    const text = await response.text();
    return (text ? JSON.parse(text) : {}) as T;
  }

  const post = <T>(path: string, body: unknown) =>
    call<T>(path, {
      method: "POST",
      body: JSON.stringify(body),
      contentType: "application/json",
    });

  /**
   * Uploads a raw message with JSON metadata (multipart upload), which takes
   * messages up to Gmail's size limit, attachments included.
   */
  const upload = <T>(path: string, metadata: unknown, raw: Uint8Array) => {
    const boundary = `winston-${crypto.randomUUID()}`;
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
      raw,
      `\r\n--${boundary}--`,
    ]);
    return call<T>(`${path}?uploadType=multipart`, {
      method: "POST",
      base: uploadApi,
      body,
      contentType: `multipart/related; boundary=${boundary}`,
    });
  };

  let labelNames: Promise<Map<string, string>> | undefined;
  /** User labels' names by id (system labels like INBOX are flags instead). */
  const labels = () =>
    (labelNames ??= call<{
      labels?: { id: string; name: string; type?: string }[];
    }>("/labels").then(
      ({ labels = [] }) =>
        new Map(
          labels
            .filter((label) => label.type === "user")
            .map((label) => [label.id, label.name]),
        ),
    ));

  /** A label's id by name; `create` makes a missing user label (decided: adding a new label creates it, as Gmail does). */
  async function labelId(name: string, create: boolean) {
    const system: Record<string, string> = {
      inbox: "INBOX",
      starred: "STARRED",
      unread: "UNREAD",
      important: "IMPORTANT",
    };
    const builtIn = system[name.toLowerCase()];
    if (builtIn) return builtIn;
    for (const [id, label] of await labels())
      if (label.toLowerCase() === name.toLowerCase()) return id;
    if (!create) return undefined;
    const made = await post<{ id: string; name: string }>("/labels", {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    });
    (await labels()).set(made.id, made.name);
    return made.id;
  }

  async function toMessage(message: GmailMessage): Promise<MailMessage> {
    const names = await labels();
    const ids = message.labelIds ?? [];
    const payload = message.payload;
    const date = header(payload, "Date");
    return {
      providerId: message.id,
      threadId: message.threadId,
      from: parseAddresses(header(payload, "From"))[0] ?? null,
      to: parseAddresses(header(payload, "To")),
      cc: parseAddresses(header(payload, "Cc")),
      subject: header(payload, "Subject") ?? "",
      date: message.internalDate
        ? new Date(Number(message.internalDate))
        : new Date(date ?? Date.now()),
      snippet: unescapeSnippet(message.snippet ?? ""),
      unread: ids.includes("UNREAD"),
      starred: ids.includes("STARRED"),
      inInbox: ids.includes("INBOX"),
      labels: ids.flatMap((id) => names.get(id) ?? []),
      attachments: attachmentsOf(message),
      messageIdHeader: header(payload, "Message-ID") ?? null,
    };
  }

  async function toFull(message: GmailMessage): Promise<FullMailMessage> {
    const { body, quotedTextHidden } = bodyOf(message);
    return {
      ...(await toMessage(message)),
      body,
      quotedTextHidden,
      references: (header(message.payload, "References") ?? "")
        .split(/\s+/)
        .filter(Boolean),
      replyTo: parseAddresses(header(message.payload, "Reply-To")),
    };
  }

  const metadata = (id: string) =>
    call<GmailMessage>(
      `/messages/${encodeURIComponent(id)}?format=metadata` +
        ["From", "To", "Cc", "Subject", "Date", "Message-ID"]
          .map((name) => `&metadataHeaders=${name}`)
          .join(""),
    );

  return {
    address,

    async list(filter, { limit, cursor }) {
      const params = new URLSearchParams({ maxResults: String(limit) });
      const q = gmailQuery(filter);
      if (q) params.set("q", q);
      if (cursor) params.set("pageToken", cursor);
      const page = await call<{
        messages?: { id: string }[];
        nextPageToken?: string;
        resultSizeEstimate?: number;
      }>(`/messages?${params.toString()}`);
      const ids = (page.messages ?? []).map((m) => m.id);
      const items: MailMessage[] = [];
      for (let at = 0; at < ids.length; at += parallelGets) {
        const batch = await Promise.all(
          ids.slice(at, at + parallelGets).map(metadata),
        );
        items.push(...(await Promise.all(batch.map(toMessage))));
      }
      return {
        items,
        cursor: page.nextPageToken ?? null,
        estimatedTotal: page.resultSizeEstimate ?? null,
      } satisfies Page<MailMessage>;
    },

    async getMessage(messageId) {
      return toFull(
        await call<GmailMessage>(
          `/messages/${encodeURIComponent(messageId)}?format=full`,
        ),
      );
    },

    async getThread(threadId): Promise<MailThread> {
      const thread = await call<{ id: string; messages?: GmailMessage[] }>(
        `/threads/${encodeURIComponent(threadId)}?format=full`,
      );
      const messages = await Promise.all((thread.messages ?? []).map(toFull));
      messages.sort((a, b) => a.date.getTime() - b.date.getTime());
      return {
        providerId: thread.id,
        subject: messages[0]?.subject ?? "",
        messages,
      };
    },

    async getAttachment(attachmentId) {
      const [messageId, partId] = attachmentId.split("/");
      if (!messageId || partId === undefined)
        throw new NotSupportedError(
          `${attachmentId} isn't a Gmail attachment.`,
        );
      const message = await call<GmailMessage>(
        `/messages/${encodeURIComponent(messageId)}?format=full`,
      );
      const part = leaves(message.payload).find((p) => p.partId === partId);
      if (!part)
        throw new ProviderNotFoundError(
          "That attachment is no longer in its message.",
        );
      const data = part.body?.attachmentId
        ? (
            await call<{ data: string }>(
              `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(part.body.attachmentId)}`,
            )
          ).data
        : (part.body?.data ?? "");
      return {
        // Gmail sends "" for a part without a name.
        filename:
          part.filename?.trim() === ""
            ? "attachment"
            : (part.filename ?? "attachment"),
        mimeType: part.mimeType ?? "application/octet-stream",
        data: new Uint8Array(Buffer.from(data, "base64url")),
      };
    },

    async send(mail) {
      const sent = await upload<{ id: string; threadId: string }>(
        "/messages/send",
        mail.inReplyTo ? { threadId: mail.inReplyTo.threadId } : {},
        await composeRaw(mail),
      );
      return { messageId: sent.id, threadId: sent.threadId };
    },

    async createDraft(mail) {
      const draft = await upload<{
        id: string;
        message: { id: string; threadId: string };
      }>(
        "/drafts",
        {
          message: mail.inReplyTo ? { threadId: mail.inReplyTo.threadId } : {},
        },
        await composeRaw(mail),
      );
      return {
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
      };
    },

    async sendDraft(draftId) {
      const sent = await post<{ id: string; threadId: string }>(
        "/drafts/send",
        { id: draftId },
      );
      return { messageId: sent.id, threadId: sent.threadId };
    },

    async getDraft(draftId) {
      const draft = await call<{ message: GmailMessage }>(
        `/drafts/${encodeURIComponent(draftId)}?format=full`,
      );
      return toFull(draft.message);
    },

    async modify(target, changes) {
      const add: string[] = [];
      const remove: string[] = [];
      if (changes.read === true) remove.push("UNREAD");
      if (changes.read === false) add.push("UNREAD");
      if (changes.starred === true) add.push("STARRED");
      if (changes.starred === false) remove.push("STARRED");
      if (changes.archived === true) remove.push("INBOX");
      if (changes.archived === false) add.push("INBOX");
      for (const name of changes.addLabels ?? [])
        add.push((await labelId(name, true)) ?? name);
      for (const name of changes.removeLabels ?? []) {
        const id = await labelId(name, false);
        // Removing a label that doesn't exist changes nothing.
        if (id) remove.push(id);
      }
      const labelChanges = {
        ...(add.length ? { addLabelIds: add } : {}),
        ...(remove.length ? { removeLabelIds: remove } : {}),
      };
      if (!add.length && !remove.length) return;
      if (target.messages?.length)
        await post("/messages/batchModify", {
          ids: target.messages,
          ...labelChanges,
        });
      for (const thread of target.threads ?? [])
        await post(
          `/threads/${encodeURIComponent(thread)}/modify`,
          labelChanges,
        );
    },

    async trash(target) {
      for (const message of target.messages ?? [])
        await post(`/messages/${encodeURIComponent(message)}/trash`, {});
      for (const thread of target.threads ?? [])
        await post(`/threads/${encodeURIComponent(thread)}/trash`, {});
      // drafts.delete is permanent; trashing the draft's message isn't.
      for (const draft of target.drafts ?? []) {
        const { message } = await call<{ message: { id: string } }>(
          `/drafts/${encodeURIComponent(draft)}?format=minimal`,
        );
        await post(`/messages/${encodeURIComponent(message.id)}/trash`, {});
      }
    },
  };
}
