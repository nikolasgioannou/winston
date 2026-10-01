/**
 * Gmail's side of `MailReader` (docs/design.md §3, §11 `winston mail`), over
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
import { compile } from "html-to-text";
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
  MailReader,
  MailThread,
  Page,
} from "./mail.ts";

const api = "https://gmail.googleapis.com/gmail/v1/users/me";
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

const htmlToText = compile({
  wordwrap: false,
  selectors: [
    { selector: "img", format: "skip" },
    { selector: "a", options: { hideLinkHrefIfSameAsText: true } },
    // Quoted earlier messages, as each client marks them.
    { selector: "div.gmail_quote", format: "skip" },
    { selector: "blockquote[type=cite]", format: "skip" },
    { selector: "div.yahoo_quoted", format: "skip" },
  ],
});

const quoteMarkers =
  /class=["'][^"']*\b(gmail_quote|yahoo_quoted)\b|<blockquote[^>]*type=["']?cite/i;

/**
 * Hides a plain-text reply's quoted tail: from an "On … wrote:" line (which
 * mail clients sometimes wrap over two lines) when `>` lines follow it.
 */
export function stripQuotedText(text: string): {
  text: string;
  hidden: boolean;
} {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const joined = `${line} ${lines[i + 1] ?? ""}`;
    const intro = /^On .+wrote:\s*$/.test(line)
      ? 1
      : /^On .+wrote:\s*$/.test(joined)
        ? 2
        : 0;
    if (!intro) continue;
    const rest = lines.slice(i + intro).filter((l) => l.trim() !== "");
    if (rest.length > 0 && rest.every((l) => l.startsWith(">")))
      return { text: lines.slice(0, i).join("\n").trimEnd(), hidden: true };
  }
  return { text, hidden: false };
}

/** The readable body: plain text if there is some, else the HTML as text. */
function bodyOf(message: GmailMessage): {
  body: string;
  quotedTextHidden: boolean;
} {
  const parts = leaves(message.payload).filter((part) => !isAttachment(part));
  const plain = parts.find((part) => part.mimeType === "text/plain");
  if (plain) {
    const { text, hidden } = stripQuotedText(decodeBody(plain));
    return { body: text.trim(), quotedTextHidden: hidden };
  }
  const html = parts.find((part) => part.mimeType === "text/html");
  if (!html) return { body: "", quotedTextHidden: false };
  const source = decodeBody(html);
  return {
    body: htmlToText(source).trim(),
    quotedTextHidden: quoteMarkers.test(source),
  };
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

export function gmailReader({
  address,
  accessToken,
  fetch: send = fetch,
}: GmailOptions): MailReader {
  async function call<T>(path: string): Promise<T> {
    const response = await send(`${api}${path}`, {
      headers: { Authorization: `Bearer ${await accessToken()}` },
    });
    if (response.status === 404)
      throw new ProviderNotFoundError(
        "Gmail has no such message or thread (it may have been deleted).",
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
    return (await response.json()) as T;
  }

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
  };
}
