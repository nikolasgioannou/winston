/**
 * `winston ramp` (02441f, docs/design.md §11): the user's Ramp, named for its
 * provider (decision #81), one object per resource under it:
 * `winston ramp transactions list`. Read only for now; acting is 944c5b.
 */
import type { InferResponseType } from "hono/client";
import { call, type ApiClient } from "../client.ts";
import type { Resource, Verb } from "../commands.ts";
import { CliError } from "../errors.ts";
import {
  standardFlags,
  textFlag,
  type FlagSpec,
  type FlagValues,
} from "../flags.ts";
import { json, list, record, shortTime } from "../output.ts";

type Ramp = ApiClient["v1"]["ramp"];
type Approvals = InferResponseType<Ramp["approvals"]["$get"], 200>;
type Transactions = InferResponseType<Ramp["transactions"]["$get"], 200>;
type Transaction = InferResponseType<
  Ramp["transactions"][":id"]["$get"],
  200
>["transaction"];
type Reimbursements = InferResponseType<Ramp["reimbursements"]["$get"], 200>;
type Reimbursement = Reimbursements["items"][number];
type Requests = InferResponseType<Ramp["requests"]["$get"], 200>;
type Request = Requests["items"][number];
type Bills = InferResponseType<Ramp["bills"]["$get"], 200>;
type Bill = InferResponseType<Ramp["bills"][":id"]["$get"], 200>["bill"];

const pageFlags: FlagSpec[] = [
  standardFlags.account,
  standardFlags.limit,
  standardFlags.cursor,
];

/** Whose items: the user's own by default; the company's needs a Ramp admin. */
const scopeFlags: FlagSpec[] = [
  {
    name: "company",
    description:
      "Everyone's in the business, not just the user's (Ramp admins only)",
  },
  {
    name: "to-approve",
    description: "Only those waiting for the user's approval",
  },
];

const rangeFlags: FlagSpec[] = [
  {
    ...standardFlags.since,
    description: "On or after this day (in the user's zone)",
  },
  { ...standardFlags.until, description: "On or before this day" },
];

/** The query string: only flags that were given. */
function query(entries: Record<string, string | undefined>) {
  return Object.fromEntries(
    Object.entries(entries).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const common = (flags: FlagValues) => ({
  account: textFlag(flags, "account"),
  limit: typeof flags.limit === "number" ? String(flags.limit) : undefined,
  cursor: textFlag(flags, "cursor"),
});

function scopeOf(flags: FlagValues) {
  if (flags.company === true && flags["to-approve"] === true)
    throw CliError.usage("Pass --company or --to-approve, not both.");
  return flags.company === true
    ? "all"
    : flags["to-approve"] === true
      ? "awaiting_me"
      : undefined;
}

/** Words to search for, at least three characters (Ramp's minimum). */
function searchWords(args: string[], what: string) {
  const words = args.join(" ").trim();
  if (words.length < 3)
    throw CliError.usage(
      "What to look for? Pass at least three characters.",
      `To see everything, use winston ramp ${what} list.`,
    );
  return words;
}

const missingNote = (missing: string[]) =>
  missing.length > 0
    ? `missing ${missing.join(", ").replaceAll("_", " ")}`
    : undefined;

const getVerb = (
  object: string,
  prefix: string,
  summary: string,
  show: (
    client: ApiClient,
    id: string,
  ) => Promise<{ data: unknown; text: string }>,
): Verb => ({
  name: "get",
  summary,
  usage: `<${prefix}_id>`,
  flags: [],
  examples: [`winston ramp ${object} get ${prefix}_01k5…`],
  run: async ({ client, args, flags }) => {
    const [id] = args;
    if (!id)
      throw CliError.usage(
        `Which one? Pass a ${prefix}_ id.`,
        `winston ramp ${object} list shows them.`,
      );
    const shown = await show(client, id);
    return flags.json === true ? json(shown.data) : shown.text;
  },
});

/** What `get` shows: the data for --json, and its lines. */
const shown = (data: unknown, lines: (string | undefined)[]) => ({
  data,
  text: lines.filter(Boolean).join("\n"),
});

// --- approvals ---

function showApprovals(result: Approvals) {
  const lines = result.sections.flatMap((section) =>
    section.total === 0
      ? []
      : [
          `${section.name} (${String(section.total)})`,
          ...section.tasks.map(
            (task) =>
              `  - ${[task.summary || task.kind.toLowerCase().replaceAll("_", " "), ...task.ids].join(" · ")}`,
          ),
          ...(section.total > section.tasks.length
            ? [
                `  … ${String(section.total - section.tasks.length)} more in Ramp.`,
              ]
            : []),
        ],
  );
  return lines.length > 0
    ? lines.join("\n")
    : "Nothing is waiting on the user in Ramp.";
}

const approvals: Resource = {
  name: "ramp approvals",
  description: "What's waiting on the user in Ramp, as its home page shows it",
  verbs: [
    {
      name: "list",
      summary:
        "Everything waiting on the user: approvals, expenses to complete, items to review, bills",
      flags: [standardFlags.account],
      examples: ["winston ramp approvals list"],
      run: async ({ client, flags }) => {
        const result = await call<Approvals>(
          client.v1.ramp.approvals.$get({
            query: query({ account: textFlag(flags, "account") }),
          }),
        );
        return flags.json === true ? json(result) : showApprovals(result);
      },
    },
  ],
};

// --- transactions ---

const transactionFlags: FlagSpec[] = [
  ...scopeFlags,
  ...rangeFlags,
  {
    name: "state",
    value: "<pending|cleared|declined|all>",
    description: "By state (default: everything but declined)",
  },
  {
    name: "missing",
    description: "Only those missing a receipt, memo or other item",
  },
  ...pageFlags,
];

function transactionQuery(flags: FlagValues, text?: string) {
  return query({
    ...common(flags),
    scope: scopeOf(flags),
    text,
    since: textFlag(flags, "since"),
    until: textFlag(flags, "until"),
    state: textFlag(flags, "state"),
    missing: flags.missing === true ? "true" : undefined,
  });
}

function showTransactions(page: Transactions, flags: FlagValues) {
  if (flags.json === true) return json(page);
  return list(
    page.items.map((t) =>
      record(
        t.id,
        t.time ? shortTime(t.time, page.timeZone) : undefined,
        t.originalAmount ? `${t.amount} (${t.originalAmount})` : t.amount,
        t.merchant,
        t.spentBy,
        t.state === "CLEARED" ? undefined : t.state.toLowerCase(),
        t.memo ? `memo: ${t.memo}` : undefined,
        missingNote(t.missing),
      ),
    ),
    {
      limit: page.items.length || 1,
      ...(page.cursor ? { nextCursor: page.cursor } : {}),
      narrow: "--since, --until or search words",
    },
  );
}

const transactions: Resource = {
  name: "ramp transactions",
  description: "Card transactions",
  ids: ["txn"],
  verbs: [
    {
      name: "list",
      summary: "The user's card transactions, newest first",
      flags: transactionFlags,
      examples: [
        "winston ramp transactions list --since 7d",
        "winston ramp transactions list --missing",
        "winston ramp transactions list --to-approve",
      ],
      run: async ({ client, flags }) =>
        showTransactions(
          await call<Transactions>(
            client.v1.ramp.transactions.$get({
              query: transactionQuery(flags),
            }),
          ),
          flags,
        ),
    },
    {
      name: "search",
      summary:
        "Transactions whose merchant, memo or cardholder matches the words",
      usage: "<text>",
      flags: transactionFlags,
      examples: [
        "winston ramp transactions search uber --since 30d",
        'winston ramp transactions search "delta air" --company',
      ],
      run: async ({ client, flags, args }) =>
        showTransactions(
          await call<Transactions>(
            client.v1.ramp.transactions.$get({
              query: transactionQuery(flags, searchWords(args, "transactions")),
            }),
          ),
          flags,
        ),
    },
    getVerb(
      "transactions",
      "txn",
      "One transaction: amount, merchant, memo, fund and accounting codes",
      async (client, id) => {
        const result = await call<{
          timeZone: string;
          transaction: Transaction;
        }>(client.v1.ramp.transactions[":id"].$get({ param: { id } }));
        const t = result.transaction;
        return shown(result, [
          record(t.id, t.merchant, t.amount ?? undefined),
          t.time ? `When: ${shortTime(t.time, result.timeZone)}` : undefined,
          t.spentBy ? `Spent by: ${t.spentBy}` : undefined,
          `Memo: ${t.memo ?? "(none)"}`,
          t.fund ? `Fund: ${t.fund}` : undefined,
          t.coding.length > 0
            ? `Coding: ${t.coding.join("; ")}`
            : "Coding: (none)",
        ]);
      },
    ),
  ],
};

// --- reimbursements ---

const reimbursementLine = (r: Reimbursement) =>
  record(
    r.id,
    r.date ?? undefined,
    r.amount,
    r.merchant,
    r.status.toLowerCase().replaceAll("_", " "),
    r.memo ? `memo: ${r.memo}` : undefined,
    missingNote(r.missing),
  );

function reimbursementQuery(flags: FlagValues, text?: string) {
  return query({
    ...common(flags),
    scope: scopeOf(flags),
    text,
    since: textFlag(flags, "since"),
    until: textFlag(flags, "until"),
  });
}

function showReimbursements(page: Reimbursements, flags: FlagValues) {
  if (flags.json === true) return json(page);
  return list(page.items.map(reimbursementLine), {
    limit: page.items.length || 1,
    ...(page.cursor ? { nextCursor: page.cursor } : {}),
    narrow: "--since, --until or search words",
  });
}

const reimbursementFlags = [...scopeFlags, ...rangeFlags, ...pageFlags];

const reimbursements: Resource = {
  name: "ramp reimbursements",
  description: "Out-of-pocket expenses paid back through Ramp",
  ids: ["rmb"],
  verbs: [
    {
      name: "list",
      summary:
        "The user's reimbursements, newest first (--since/--until: when created)",
      flags: reimbursementFlags,
      examples: [
        "winston ramp reimbursements list",
        "winston ramp reimbursements list --to-approve",
      ],
      run: async ({ client, flags }) =>
        showReimbursements(
          await call<Reimbursements>(
            client.v1.ramp.reimbursements.$get({
              query: reimbursementQuery(flags),
            }),
          ),
          flags,
        ),
    },
    {
      name: "search",
      summary:
        "Reimbursements whose merchant, memo or person matches the words",
      usage: "<text>",
      flags: reimbursementFlags,
      examples: ["winston ramp reimbursements search mileage"],
      run: async ({ client, flags, args }) =>
        showReimbursements(
          await call<Reimbursements>(
            client.v1.ramp.reimbursements.$get({
              query: reimbursementQuery(
                flags,
                searchWords(args, "reimbursements"),
              ),
            }),
          ),
          flags,
        ),
    },
    getVerb(
      "reimbursements",
      "rmb",
      "One reimbursement: amount, status, memo, coding and what's missing",
      async (client, id) => {
        const result = await call<{ reimbursement: Reimbursement }>(
          client.v1.ramp.reimbursements[":id"].$get({ param: { id } }),
        );
        const r = result.reimbursement;
        return shown(result, [
          reimbursementLine(r),
          r.submittedAt ? `Submitted: ${r.submittedAt}` : "Not submitted yet",
          r.coding.length > 0 ? `Coding: ${r.coding.join("; ")}` : undefined,
          r.link ? `In Ramp: ${r.link}` : undefined,
        ]);
      },
    ),
  ],
};

// --- requests ---

const requestLine = (r: Request) =>
  record(
    r.id,
    r.date ?? undefined,
    r.kind?.toLowerCase().replaceAll("_", " "),
    r.name ?? r.vendor,
    r.requester ? `from ${r.requester}` : undefined,
    r.amount,
    r.status.toLowerCase().replaceAll("_", " "),
  );

const requests: Resource = {
  name: "ramp requests",
  description:
    "Spend requests (purchase orders, funds, travel) waiting for the user's review",
  ids: ["req"],
  verbs: [
    {
      name: "list",
      summary: "Requests waiting for the user's review",
      flags: pageFlags,
      examples: ["winston ramp requests list"],
      run: async ({ client, flags }) => {
        const page = await call<Requests>(
          client.v1.ramp.requests.$get({ query: query(common(flags)) }),
        );
        if (flags.json === true) return json(page);
        return list(page.items.map(requestLine), {
          limit: page.items.length || 1,
          ...(page.cursor ? { nextCursor: page.cursor } : {}),
        });
      },
    },
    getVerb(
      "requests",
      "req",
      "One request: what, who asked, how much, why and its status",
      async (client, id) => {
        const result = await call<{ request: Request }>(
          client.v1.ramp.requests[":id"].$get({ param: { id } }),
        );
        const r = result.request;
        return shown(result, [
          requestLine(r),
          r.reason ? `Reason: ${r.reason}` : undefined,
        ]);
      },
    ),
  ],
};

// --- bills ---

const billLine = (b: Bills["items"][number]) =>
  record(
    b.id,
    b.vendor,
    b.amount,
    b.dueDate ? `due ${b.dueDate}` : undefined,
    b.pastDue ? "past due" : undefined,
    b.draft ? "draft" : undefined,
    b.approvalStatus?.toLowerCase().replaceAll("_", " "),
    b.paymentStatus?.toLowerCase().replaceAll("_", " "),
    b.invoice ? `invoice ${b.invoice}` : undefined,
  );

const bills: Resource = {
  name: "ramp bills",
  description: "Vendor bills (read only: Ramp's MCP can't approve bills)",
  ids: ["bil"],
  verbs: [
    {
      name: "list",
      summary: "Bills, newest first",
      flags: [
        { name: "unpaid", description: "Only bills not yet paid" },
        ...pageFlags,
      ],
      examples: ["winston ramp bills list --unpaid"],
      run: async ({ client, flags }) => {
        const page = await call<Bills>(
          client.v1.ramp.bills.$get({
            query: query({
              ...common(flags),
              unpaid: flags.unpaid === true ? "true" : undefined,
            }),
          }),
        );
        if (flags.json === true) return json(page);
        return list(page.items.map(billLine), {
          limit: page.items.length || 1,
          ...(page.cursor ? { nextCursor: page.cursor } : {}),
        });
      },
    },
    {
      name: "search",
      summary:
        "Bills whose vendor, invoice number or payment id matches the words",
      usage: "<text>",
      flags: [
        { name: "unpaid", description: "Only bills not yet paid" },
        ...pageFlags,
      ],
      examples: ["winston ramp bills search aws"],
      run: async ({ client, flags, args }) => {
        const page = await call<Bills>(
          client.v1.ramp.bills.$get({
            query: query({
              ...common(flags),
              text: searchWords(args, "bills"),
              unpaid: flags.unpaid === true ? "true" : undefined,
            }),
          }),
        );
        if (flags.json === true) return json(page);
        return list(page.items.map(billLine), {
          limit: page.items.length || 1,
          ...(page.cursor ? { nextCursor: page.cursor } : {}),
        });
      },
    },
    getVerb(
      "bills",
      "bil",
      "One bill: vendor, amount, dates, status and line items",
      async (client, id) => {
        const result = await call<{ bill: Bill }>(
          client.v1.ramp.bills[":id"].$get({ param: { id } }),
        );
        const b = result.bill;
        return shown(result, [
          billLine(b),
          b.description ? `Description: ${b.description}` : undefined,
          b.memo ? `Memo: ${b.memo}` : undefined,
          ...b.lineItems
            .slice(0, 20)
            .map((item) => `  - ${item.description} · ${item.amount}`),
          b.lineItems.length > 20
            ? `  … ${String(b.lineItems.length - 20)} more line items. To see them, add --json.`
            : undefined,
          b.link ? `In Ramp: ${b.link}` : undefined,
        ]);
      },
    ),
  ],
};

export const ramp: Resource = {
  name: "ramp",
  description:
    "The user's Ramp: what's waiting on them, transactions, reimbursements, requests and bills",
  verbs: [],
  objects: [approvals, transactions, reimbursements, requests, bills],
};
