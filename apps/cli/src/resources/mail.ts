import type { InferResponseType } from "hono/client";
import { posix } from "node:path";
import { call, type ApiClient } from "../client.ts";
import type { Context, Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import {
  either,
  listFlag,
  resolveText,
  standardFlags,
  textFlag,
  type FlagSpec,
  type FlagValues,
} from "../flags.ts";
import { json, list, record, shortTime } from "../output.ts";

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

type SendResult = InferResponseType<
  ApiClient["v1"]["mail"]["send"]["$post"],
  200
>;
type UpdateResult = InferResponseType<
  ApiClient["v1"]["mail"]["update"]["$post"],
  200
>;
type DeleteResult = InferResponseType<
  ApiClient["v1"]["mail"]["delete"]["$post"],
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

/** The list/search query, flag for flag. */
function query(flags: FlagValues, folder: string, search?: string) {
  if (flags.unread === true && flags.read === true)
    throw CliError.usage("Pick one of --unread and --read.");
  const entries = {
    account: textFlag(flags, "account"),
    in: textFlag(flags, "in") ?? folder,
    text: search,
    from: textFlag(flags, "from"),
    to: textFlag(flags, "to"),
    subject: textFlag(flags, "subject"),
    unread:
      flags.unread === true
        ? "true"
        : flags.read === true
          ? "false"
          : undefined,
    has_attachment: flags["has-attachment"] === true ? "true" : undefined,
    label: textFlag(flags, "label"),
    category: textFlag(flags, "category"),
    native: textFlag(flags, "native"),
    since: textFlag(flags, "since"),
    until: textFlag(flags, "until"),
    limit: typeof flags.limit === "number" ? String(flags.limit) : undefined,
    cursor: textFlag(flags, "cursor"),
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

/** A send's flags shared by send, reply and forward. */
const writeFlags = {
  to: {
    name: "to",
    value: "<address>",
    description: "Recipient (repeat for more)",
    repeatable: true,
  },
  cc: {
    name: "cc",
    value: "<address>",
    description: "Copy (repeat for more)",
    repeatable: true,
  },
  bcc: {
    name: "bcc",
    value: "<address>",
    description: "Blind copy (repeat for more)",
    repeatable: true,
  },
  body: {
    name: "body",
    value: "<text>",
    description: "The message: text, - for stdin, or @path",
    text: true,
  },
  attach: {
    name: "attach",
    value: "<path>",
    description: "Attach a file from the computer (repeat for more)",
    repeatable: true,
  },
  draft: {
    name: "draft",
    description: "Save as a draft (drf_…) instead of sending",
  },
} satisfies Record<string, FlagSpec>;

/** Whatever a write returned, as a line or a preview. */
function showSend(result: SendResult, asJson: boolean) {
  if (asJson) return json(result);
  if ("preview" in result) {
    const p = result.preview;
    return [
      p.draft ? "DRY RUN (no draft saved)" : "DRY RUN (nothing sent)",
      [
        `from: ${p.account}`,
        `to: ${p.to.join(", ")}`,
        p.cc.length ? `cc: ${p.cc.join(", ")}` : undefined,
        p.bcc.length ? `bcc: ${p.bcc.join(", ")}` : undefined,
        `subject: ${p.subject}`,
        p.threadId ? `in ${p.threadId}` : undefined,
      ]
        .filter(Boolean)
        .join("  "),
      p.attachments.length
        ? `attachments: ${p.attachments.join(", ")}`
        : undefined,
      p.body,
    ]
      .filter((line) => line !== undefined)
      .join("\n");
  }
  if ("draft" in result)
    return `Saved draft ${result.draft.id} (${result.draft.messageId} in ${result.draft.threadId}) in ${result.account.email}. Send it with: winston mail send ${result.draft.id}`;
  if ("sent" in result)
    return `Sent ${result.sent.id} in ${result.sent.threadId} from ${result.account.email}.`;
  return json(result);
}

/** Files to attach, as paths on the computer under the home folder. */
const attachPaths = (flags: FlagValues, files: Context["files"]) =>
  listFlag(flags, "attach").map((path) => inHome(path, files));

async function bodyText(
  flags: FlagValues,
  context: Context,
  required: boolean,
) {
  const value = textFlag(flags, "body");
  if (value === undefined) {
    if (required)
      throw CliError.usage(
        "--body is required.",
        "Pass the text, - to read stdin (a heredoc), or @path for a file.",
      );
    return undefined;
  }
  return resolveText(value, context.text);
}

const changeWords = (changes: UpdateResult["changes"]) =>
  [
    changes.read === true
      ? "read"
      : changes.read === false
        ? "unread"
        : undefined,
    changes.starred === true
      ? "starred"
      : changes.starred === false
        ? "unstarred"
        : undefined,
    changes.archived === true
      ? "archived"
      : changes.archived === false
        ? "back in the inbox"
        : undefined,
    ...(changes.addLabels ?? []).map((l) => `+${l}`),
    ...(changes.removeLabels ?? []).map((l) => `-${l}`),
  ]
    .filter(Boolean)
    .join(", ");

export const mail: Resource = {
  name: "mail",
  ids: ["msg", "thr", "att"],
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
      summary:
        "A message, or a whole thread oldest first, with its text; or an attachment's name, type and size",
      usage: "<msg_id|thr_id|att_id>",
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
        if (id.startsWith("att_")) {
          const info = await call<AttachmentInfo>(
            client.v1.mail.attachments[":id"].$get({ param: { id } }),
          );
          return flags.json === true
            ? json(info)
            : `${record(info.id, info.filename, info.mimeType, size(info.size))}\nSave it with: winston mail download ${info.id}`;
        }
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
        const dir = inHome(textFlag(flags, "to") ?? "~/downloads", files);
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
    {
      name: "send",
      summary: "Send a new message, or an existing draft by its drf_ id",
      usage: "[<drf_id>]",
      flags: [
        writeFlags.to,
        writeFlags.cc,
        writeFlags.bcc,
        { name: "subject", value: "<text>", description: "The subject" },
        writeFlags.body,
        writeFlags.attach,
        writeFlags.draft,
        standardFlags.dryRun,
        standardFlags.account,
      ],
      examples: [
        `winston mail send --to dana@example.com --subject "Lease" --body - --dry-run <<'EOF'\nTuesday works.\nEOF`,
        'winston mail send --to dana@example.com --subject "Lease" --body @~/notes/lease.txt --draft',
        "winston mail send drf_01k5…",
      ],
      run: async (context) => {
        const { client, flags, args } = context;
        const dryRun = flags["dry-run"] === true;
        const [draftId] = args;
        if (draftId)
          return showSend(
            await call<SendResult>(
              client.v1.mail.drafts[":id"].send.$post({
                param: { id: draftId },
                json: { dryRun },
              }),
            ),
            flags.json === true,
          );
        const to = listFlag(flags, "to");
        if (to.length === 0)
          throw CliError.usage(
            "Who to? Pass --to (repeat it for more).",
            "To send a saved draft, pass its drf_ id instead.",
          );
        const subject = textFlag(flags, "subject");
        if (subject === undefined)
          throw CliError.usage("--subject is required.");
        return showSend(
          await call<SendResult>(
            client.v1.mail.send.$post({
              json: {
                ...(textFlag(flags, "account")
                  ? { account: textFlag(flags, "account") }
                  : {}),
                to,
                cc: listFlag(flags, "cc"),
                bcc: listFlag(flags, "bcc"),
                subject,
                body: (await bodyText(flags, context, true)) ?? "",
                attach: attachPaths(flags, context.files),
                draft: flags.draft === true,
                dryRun,
              },
            }),
          ),
          flags.json === true,
        );
      },
    },
    {
      name: "reply",
      summary: "Reply to a message (or a thread's latest), in its thread",
      usage: "<msg_id|thr_id>",
      flags: [
        writeFlags.body,
        {
          name: "all",
          description: "Reply to everyone on it, not just the sender",
        },
        writeFlags.attach,
        writeFlags.draft,
        standardFlags.dryRun,
      ],
      examples: [
        "winston mail reply msg_01k5… --body - --dry-run <<'EOF'\nTuesday works. Thanks, Dana.\nEOF",
        'winston mail reply msg_01k5… --all --body "Sounds good." --draft',
      ],
      run: async (context) => {
        const { client, flags, args } = context;
        const [id] = args;
        if (!id) throw CliError.usage("Which message? Pass a msg_ or thr_ id.");
        return showSend(
          await call<SendResult>(
            client.v1.mail.messages[":id"].reply.$post({
              param: { id },
              json: {
                body: (await bodyText(flags, context, true)) ?? "",
                all: flags.all === true,
                attach: attachPaths(flags, context.files),
                draft: flags.draft === true,
                dryRun: flags["dry-run"] === true,
              },
            }),
          ),
          flags.json === true,
        );
      },
    },
    {
      name: "forward",
      summary: "Forward a message with its attachments",
      usage: "<msg_id|thr_id>",
      flags: [
        writeFlags.to,
        writeFlags.cc,
        writeFlags.bcc,
        {
          ...writeFlags.body,
          description: "A note above the forwarded message: text, - or @path",
        },
        writeFlags.attach,
        writeFlags.draft,
        standardFlags.dryRun,
      ],
      examples: [
        'winston mail forward msg_01k5… --to lawyer@example.com --body "See below." --dry-run',
      ],
      run: async (context) => {
        const { client, flags, args } = context;
        const [id] = args;
        if (!id) throw CliError.usage("Which message? Pass a msg_ or thr_ id.");
        const to = listFlag(flags, "to");
        if (to.length === 0)
          throw CliError.usage("Who to? Pass --to (repeat it for more).");
        const body = await bodyText(flags, context, false);
        return showSend(
          await call<SendResult>(
            client.v1.mail.messages[":id"].forward.$post({
              param: { id },
              json: {
                to,
                cc: listFlag(flags, "cc"),
                bcc: listFlag(flags, "bcc"),
                ...(body === undefined ? {} : { body }),
                attach: attachPaths(flags, context.files),
                draft: flags.draft === true,
                dryRun: flags["dry-run"] === true,
              },
            }),
          ),
          flags.json === true,
        );
      },
    },
    {
      name: "update",
      summary: "Mark read or unread, star, archive, or change labels",
      usage: "<msg_id|thr_id>…",
      flags: [
        { name: "read", description: "Mark read" },
        { name: "unread", description: "Mark unread" },
        { name: "star", description: "Star" },
        { name: "unstar", description: "Remove the star" },
        { name: "archive", description: "Archive (out of the inbox)" },
        { name: "inbox", description: "Move back to the inbox" },
        {
          name: "add-label",
          value: "<name>",
          description: "Add a label, creating it if it's new (repeat for more)",
          repeatable: true,
        },
        {
          name: "remove-label",
          value: "<name>",
          description: "Remove a label (repeat for more)",
          repeatable: true,
        },
        standardFlags.dryRun,
      ],
      examples: [
        "winston mail update msg_01k5… msg_01k6… --read --archive",
        'winston mail update thr_01k5… --add-label "Lease" --star',
      ],
      run: async ({ client, flags, args }) => {
        if (args.length === 0)
          throw CliError.usage("Which messages? Pass msg_ or thr_ ids.");
        const read = either(flags, "read", "unread");
        const starred = either(flags, "star", "unstar");
        const archived = either(flags, "archive", "inbox");
        const result = await call<UpdateResult>(
          client.v1.mail.update.$post({
            json: {
              ids: args,
              ...(read === undefined ? {} : { read }),
              ...(starred === undefined ? {} : { starred }),
              ...(archived === undefined ? {} : { archived }),
              addLabels: listFlag(flags, "add-label"),
              removeLabels: listFlag(flags, "remove-label"),
              dryRun: flags["dry-run"] === true,
            },
          }),
        );
        if (flags.json === true) return json(result);
        const what = `${result.updated.join(", ")}: ${changeWords(result.changes)}`;
        return result.dryRun
          ? `DRY RUN (nothing changed)\nWould update ${what}`
          : `Updated ${what}`;
      },
    },
    {
      name: "delete",
      summary:
        "Move messages, threads or drafts to the trash (never deleted for good)",
      usage: "<msg_id|thr_id|drf_id>…",
      flags: [standardFlags.dryRun],
      examples: [
        "winston mail delete msg_01k5…",
        "winston mail delete drf_01k5… --dry-run",
      ],
      run: async ({ client, flags, args }) => {
        if (args.length === 0)
          throw CliError.usage("Which? Pass msg_, thr_ or drf_ ids.");
        const result = await call<DeleteResult>(
          client.v1.mail.delete.$post({
            json: { ids: args, dryRun: flags["dry-run"] === true },
          }),
        );
        if (flags.json === true) return json(result);
        return result.dryRun
          ? `DRY RUN (nothing moved)\nWould move to the trash: ${result.trashed.join(", ")}`
          : `Moved to the trash: ${result.trashed.join(", ")}`;
      },
    },
  ],
};
