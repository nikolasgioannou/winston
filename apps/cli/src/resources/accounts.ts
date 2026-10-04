import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource } from "../commands.ts";
import { CliError } from "../errors.ts";
import { json, list } from "../output.ts";

/** Typed by the API itself (Hono RPC), so a change there breaks the build here. */
type Accounts = InferResponseType<ApiClient["v1"]["accounts"]["$get"], 200>;
type Detail = InferResponseType<
  ApiClient["v1"]["accounts"][":id"]["$get"],
  200
>;
type Account = Detail["accounts"][number];
type ConnectLink = InferResponseType<
  ApiClient["v1"]["accounts"]["connect"][":domain"]["$get"],
  200
>;

const providerNames = {
  gmail: "Gmail",
  google_calendar: "Google Calendar",
  winston: "Winston's own",
};
const statusWords = {
  ok: "ok",
  expiring: "auth expiring",
  expired: "auth expired",
  disconnected: "disconnected",
};

/** What `connect mail` says about Winston's own address, which isn't a Google account. */
function mailboxLines(mailbox: ConnectLink["winstonMailbox"]) {
  if (!mailbox) return [];
  if (mailbox.status === "never")
    return [
      `You have no email address of your own yet. The user can give you one at ${mailbox.url}`,
    ];
  return [
    mailbox.status === "on"
      ? `Your own address is ${mailbox.address ?? ""} (not a Google account; use it with --account).`
      : `Your own address, ${mailbox.address ?? ""}, is turned off. The user can turn it on at ${mailbox.url}`,
  ];
}

const pad = (rows: string[][]) => {
  const widths = rows[0]?.map((_, i) =>
    Math.max(...rows.map((row) => row[i]?.length ?? 0)),
  );
  return rows.map((row) =>
    row
      .map((cell, i) =>
        i < row.length - 1 ? cell.padEnd(widths?.[i] ?? 0) : cell,
      )
      .join("  ")
      .trimEnd(),
  );
};

function showAccount(account: Account) {
  const lines = [
    `${account.id} · ${account.email} · ${providerNames[account.provider]} (${account.domain}) · ${statusWords[account.status]}`,
    "Permissions:",
    ...pad(
      account.capabilities.map((c) => [
        `  ${c.name}`,
        c.granted ? (c.on ? "on" : "off") : "not granted",
        c.description,
      ]),
    ),
  ];
  const links = account.links;
  if (links) {
    if (account.status === "expired" || account.status === "expiring")
      lines.push(
        `Access ${account.status === "expired" ? "has expired" : "expires soon"}; the user can reconnect with one tap: ${links.reconnect}`,
      );
    if (account.capabilities.some((c) => c.granted && !c.on))
      lines.push(`The user turns permissions on or off at ${links.settings}`);
    if (account.capabilities.some((c) => !c.granted))
      lines.push(
        `"Not granted" was left unticked on Google's screen; the user can reconnect to allow it: ${links.reconnect}`,
      );
  }
  if (account.calendars) {
    lines.push("Calendars:");
    for (const c of account.calendars)
      lines.push(
        `  ${c.name}${c.name === c.id ? "" : ` (${c.id})`}: ${[
          c.primary ? "primary" : undefined,
          c.writable ? "can add events" : "read only",
        ]
          .filter(Boolean)
          .join(", ")}`,
      );
  } else if (account.calendarsNote)
    lines.push(`Calendars: ${account.calendarsNote}`);
  lines.push("Notes:", ...account.notes.map((note) => `  - ${note}`));
  return lines.join("\n");
}

export const accounts: Resource = {
  name: "accounts",
  description:
    "The user's connected mail and calendar accounts, and what you may do with each",
  ids: ["acct"],
  verbs: [
    {
      name: "list",
      summary: "Connected accounts: id, type, provider, address, status",
      flags: [],
      examples: ["winston accounts list"],
      run: async ({ client, flags }) => {
        const result = await call<Accounts>(client.v1.accounts.$get());
        if (flags.json === true) return json(result);
        return list(
          pad(
            result.accounts.map((a) => [
              a.id,
              a.domain,
              providerNames[a.provider],
              a.email,
              statusWords[a.status],
            ]),
          ),
          { limit: result.accounts.length || 1 },
        ).replace(
          /^Nothing found\.$/,
          "No accounts are connected. winston accounts connect mail (or calendar) gives a link to send the user.",
        );
      },
    },
    {
      name: "connect",
      summary:
        "A link to send the user that starts connecting a Google account's mail or calendar",
      usage: "<mail|calendar>",
      flags: [],
      examples: [
        "winston accounts connect calendar",
        "winston accounts connect mail",
      ],
      run: async ({ client, flags, args }) => {
        const [domain] = args;
        if (domain !== "mail" && domain !== "calendar")
          throw CliError.usage(
            "Connect what? Pass mail or calendar.",
            "Mail and calendar are separate connections, each with its own link.",
          );
        const result = await call<ConnectLink>(
          client.v1.accounts.connect[":domain"].$get({ param: { domain } }),
        );
        if (flags.json === true) return json(result);
        const other = domain === "mail" ? "calendar" : "mail";
        return [
          `Send the user this link to connect a Google account's ${domain}:`,
          `  ${result.url}`,
          `It connects ${domain} only; ${other} is a separate connection with its own link (winston accounts connect ${other}). It goes straight to Google's sign-in (signing in to Winston first if needed), and you'll get system.app.connected when it's done.`,
          result.connected.length > 0
            ? `Already connected for ${domain}: ${result.connected.join(", ")}.`
            : `No ${domain} account is connected yet.`,
          ...mailboxLines(result.winstonMailbox),
        ].join("\n");
      },
    },
    {
      name: "get",
      summary:
        "One account (both, if an address has mail and calendar): permissions, calendars, provider notes",
      usage: "<acct_id|email>",
      flags: [],
      examples: [
        "winston accounts get me@example.com",
        "winston accounts get acct_01k5…",
      ],
      run: async ({ client, flags, args }) => {
        const [id] = args;
        if (!id)
          throw CliError.usage(
            "Which account? Pass an acct_ id or an address.",
            "winston accounts list shows them.",
          );
        const result = await call<Detail>(
          client.v1.accounts[":id"].$get({ param: { id } }),
        );
        if (flags.json === true) return json(result);
        return result.accounts.map(showAccount).join("\n\n");
      },
    },
  ],
};
