import type { InferResponseType } from "hono/client";
import { posix } from "node:path";
import { call, type ApiClient } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { standardFlags, type FlagSpec, type FlagValues } from "../flags.ts";
import { json, list, shortTime } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Page = InferResponseType<ApiClient["v1"]["mail"]["messages"]["$get"], 200>;
type Detail = InferResponseType<
  ApiClient["v1"]["mail"]["messages"][":id"]["$get"],
  200
>;
type Summary = Page["messages"][number];
type Message = Detail["messages"][number];
type AttachmentInfo = InferResponseType<
  ApiClient["v1"]["mail"]["attachments"][":id"]["$get"],
  200
>;
type Saved = InferResponseType<
  ApiClient["v1"]["mail"]["attachments"][":id"]["save"]["$post"],
  200
>;

/** How much of a body `mail get` shows unless asked for all of it. */
export const bodyPreviewChars = 3000;

const filterFlags: FlagSpec[] = [
  { name: "from", value: "<address|name>", description: "Sent by" },
  { name: "to", value: "<address|name>", description: "Sent to" },
  { name: "subject", value: "<text>", description: "Subject contains" },
  { name: "unread", description: "Only unread mail" },
  { name: "read", description: "Only mail that's been read" },
  { name: "has-attachment", description: "Only mail with attachments" },
  { name: "label", value: "<name>", description: "Has this label" },
  {
    name: "category",
    value: "<name>",
    description:
      "In this category (primary, promotions, social, updates, forums)",
  },
  {
    name: "in",
    value: "inbox|sent|drafts|archive|all",
    description: "Where to look (list: inbox, search: all)",
  },
  {
    name: "native",
    value: "<query>",
    description:
      'The provider\'s own search syntax, instead of the filters (Gmail: "from:dana has:attachment")',
  },
  standardFlags.since,
  standardFlags.until,
  standardFlags.limit,
  standardFlags.cursor,
  standardFlags.account,
];

const text = (flags: FlagValues, name: string) =>
  typeof flags[name] === "string" ? flags[name] : undefined;

/** The list/search query, flag for flag. */
function query(flags: FlagValues, folder: string, search?: string) {
  if (flags.unread === true && flags.read === true)
    throw CliError.usage("Pick one of --unread and --read.");
  const entries = {
    account: text(flags, "account"),
    in: text(flags, "in") ?? folder,
    text: search,
    from: text(flags, "from"),
    to: text(flags, "to"),
    subject: text(flags, "subject"),
    unread:
      flags.unread === true
        ? "true"
        : flags.read === true
          ? "false"
          : undefined,
    has_attachment: flags["has-attachment"] === true ? "true" : undefined,
    label: text(flags, "label"),
    category: text(flags, "category"),
    native: text(flags, "native"),
    since: text(flags, "since"),
    until: text(flags, "until"),
    limit: typeof flags.limit === "number" ? String(flags.limit) : undefined,
    cursor: text(flags, "cursor"),
  };
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const address = (a: { name: string | null; email: string } | null) =>
  a ? (a.name ? `${a.name} <${a.email}>` : a.email) : "(no sender)";

const size = (bytes: number) =>
  bytes < 1024
    ? `${String(bytes)} B`
    : bytes < 1024 * 1024
      ? `${String(Math.round(bytes / 1024))} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** What a message is, in brackets: `[inbox, unread, 📎]`. */
function tags(message: Summary) {
  const all = [
    message.inInbox ? "inbox" : undefined,
    message.unread ? "unread" : undefined,
    message.starred ? "starred" : undefined,
    ...message.labels,
    message.attachmentCount > 0 ? "📎" : undefined,
  ].filter(Boolean);
  return all.length > 0 ? `[${all.join(", ")}]` : "";
}

/** One line per message, as §11 shows it. */
export const messageLine = (message: Summary, timeZone: string) =>
  [
    message.id,
    shortTime(message.date, timeZone),
    address(message.from),
    message.subject || "(no subject)",
    tags(message),
    message.threadId,
  ]
    .filter(Boolean)
    .join("  ");

function showPage(page: Page, flags: FlagValues) {
  if (flags.json === true) return json(page);
  return list(
    page.messages.map((message) => messageLine(message, page.timeZone)),
    {
      limit: page.messages.length || 1,
      ...(page.cursor ? { nextCursor: page.cursor } : {}),
      narrow: "--since, --from or --unread",
    },
  );
}

function showMessage(message: Message, timeZone: string, full: boolean) {
  const lines = [
    `${message.id} · ${message.threadId}`,
    `From: ${address(message.from)}`,
    message.to.length > 0
      ? `To: ${message.to.map(address).join(", ")}`
      : undefined,
    message.cc.length > 0
      ? `Cc: ${message.cc.map(address).join(", ")}`
      : undefined,
    message.replyTo.length > 0
      ? `Reply-To: ${message.replyTo.map(address).join(", ")}`
      : undefined,
    `Date: ${shortTime(message.date, timeZone)}`,
    `Subject: ${message.subject || "(no subject)"}`,
    tags(message) ? `Tags: ${tags(message).slice(1, -1)}` : undefined,
    ...message.attachments.map(
      (a) =>
        `Attachment: ${a.id} ${a.filename} (${a.mimeType}, ${size(a.size)})`,
    ),
    "",
  ].filter((line) => line !== undefined);
  const body = message.body || "(no text)";
  if (!full && body.length > bodyPreviewChars) {
    lines.push(body.slice(0, bodyPreviewChars).trimEnd());
    lines.push(
      `… ${String(body.length - bodyPreviewChars)} more characters. To see them, add --full.`,
    );
  } else lines.push(body);
  if (message.quotedTextHidden) lines.push("[Quoted earlier messages hidden.]");
  return lines.join("\n");
}

function showDetail(detail: Detail, flags: FlagValues) {
  if (flags.json === true) return json(detail);
  const full = flags.full === true;
  if (detail.kind === "message" && detail.messages[0])
    return showMessage(detail.messages[0], detail.timeZone, full);
  const [first] = detail.messages;
  return [
    `${first?.threadId ?? ""} · ${first?.subject ?? ""} · ${String(detail.messages.length)} messages, oldest first`,
    ...detail.messages.map(
      (message, i) =>
        `\n── ${String(i + 1)}/${String(detail.messages.length)} ──\n${showMessage(message, detail.timeZone, full)}`,
    ),
  ].join("\n");
}

/** A path on the VM: `~` and relative paths resolved, kept inside the home. */
function inHome(path: string, files: Context["files"]) {
  const resolved = posix.resolve(
    files.cwd,
    path.startsWith("~") ? posix.join(files.home, path.slice(1)) : path,
  );
  if (!resolved.startsWith(`${files.home}/`) && resolved !== files.home)
    throw CliError.usage(
      `${path} is outside ${files.home}.`,
      "Save downloads under your home folder, e.g. --to ~/downloads.",
    );
  return resolved;
}

/** A name in `dir` that isn't taken: lease.pdf, then lease (2).pdf, … */
async function freePath(
  dir: string,
  filename: string,
  files: Context["files"],
) {
  const safe = posix.basename(filename.replaceAll("\\", "/")) || "attachment";
  const ext = posix.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  for (let n = 1; ; n += 1) {
    const candidate = posix.join(
      dir,
      n === 1 ? safe : `${stem} (${String(n)})${ext}`,
    );
    if (!(await files.exists(candidate))) return candidate;
  }
}

export const mail: Resource = {
  name: "mail",
  description:
    "Email in the user's connected accounts: list, search, read, download",
  verbs: [
    {
      name: "list",
      summary:
        "Recent mail, newest first (the inbox unless --in says otherwise)",
      flags: filterFlags,
      examples: [
        "winston mail list --unread",
        "winston mail list --in sent --since 3d --account work@acme.com",
        "winston mail list --from dana --has-attachment --limit 5",
      ],
      run: async ({ client, flags }) =>
        showPage(
          await call<Page>(
            client.v1.mail.messages.$get({ query: query(flags, "inbox") }),
          ),
          flags,
        ),
    },
    {
      name: "search",
      summary: "Search all mail by keywords and filters, newest first",
      usage: "[<text>]",
      flags: filterFlags,
      examples: [
        "winston mail search lease --from dana",
        'winston mail search "board deck" --since 2w --has-attachment',
        'winston mail search --native "from:dana has:drive"',
      ],
      run: async ({ client, flags, args }) => {
        const words = args.join(" ").trim();
        return showPage(
          await call<Page>(
            client.v1.mail.messages.$get({
              query: query(flags, "all", words || undefined),
            }),
          ),
          flags,
        );
      },
    },
    {
      name: "get",
      summary: "A message, or a whole thread oldest first, with its text",
      usage: "<msg_id|thr_id>",
      flags: [
        {
          name: "full",
          description: `The whole body (by default each message stops after ${String(bodyPreviewChars)} characters)`,
        },
      ],
      examples: [
        "winston mail get msg_01k5…",
        "winston mail get thr_01k5… --full",
      ],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id)
          throw CliError.usage(
            "Which message? Pass a msg_ or thr_ id.",
            "Get ids from winston mail list or search.",
          );
        return showDetail(
          await call<Detail>(
            client.v1.mail.messages[":id"].$get({ param: { id } }),
          ),
          flags,
        );
      },
    },
    {
      name: "download",
      summary:
        "Save attachments to the computer (default ~/downloads); prints the paths",
      usage: "<att_id>…",
      flags: [
        {
          name: "to",
          value: "<dir>",
          description: "Where to save them (default ~/downloads)",
        },
      ],
      examples: [
        "winston mail download att_01k5…",
        "winston mail download att_01k5… att_01k6… --to ~/notes/lease",
      ],
      run: async ({ client, flags, args, files }) => {
        if (args.length === 0)
          throw CliError.usage(
            "Which attachments? Pass att_ ids.",
            "winston mail get <msg_id> lists a message's attachments.",
          );
        const dir = inHome(text(flags, "to") ?? "~/downloads", files);
        const saved: Saved[] = [];
        for (const id of args) {
          const info = await call<AttachmentInfo>(
            client.v1.mail.attachments[":id"].$get({ param: { id } }),
          );
          const path = await freePath(dir, info.filename, files);
          saved.push(
            await call<Saved>(
              client.v1.mail.attachments[":id"].save.$post({
                param: { id },
                json: { path },
              }),
            ),
          );
        }
        return flags.json === true
          ? json(saved)
          : saved
              .map((s) => `${s.id}  ${s.path}  (${size(s.size)})`)
              .join("\n");
      },
    },
  ],
};
