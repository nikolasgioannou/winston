/**
 * Reading the user's Ramp (02441f, docs/design.md §5): transactions,
 * reimbursements, requests, bills and what's waiting on the user, through
 * Ramp's MCP tools by name, normalized for `winston ramp`. Shapes follow what
 * the spike saw and Ramp's agent-tools spec (docs/research/ramp-mcp.md,
 * Verified); parsing is lenient, since Ramp's tools change without notice.
 *
 * Ramp's `external_agent_messages` are dropped: text Ramp addresses to AI
 * agents is outside content, never instructions (§4).
 */
import { z } from "zod";
import {
  ProviderNotFoundError,
  ProviderRefusedError,
  ProviderUnavailableError,
} from "./errors.ts";
import type { McpClient } from "./mcp.ts";

export interface RampPage<T> {
  items: T[];
  /** Ramp's own cursor for the next page, or null at the end. */
  cursor: string | null;
}

/** Whose items a list covers. Employees only have their own (`mine`). */
export type RampScope = "mine" | "all" | "awaiting_me";

export interface RampTransaction {
  providerId: string;
  time: string | null;
  /** As Ramp shows it, e.g. `$12.34`. */
  amount: string;
  /** What was charged in another currency, e.g. `€10.00`, if it was. */
  originalAmount: string | null;
  merchant: string;
  category: string | null;
  spentBy: string | null;
  /** `CLEARED`, `PENDING`, `DECLINED`, … */
  state: string;
  declineReason: string | null;
  memo: string | null;
  trip: string | null;
  fund: string | null;
  /** What Ramp says is missing: `receipt`, `memo`, … */
  missing: string[];
  link: string | null;
}

export interface RampTransactionDetail {
  providerId: string;
  time: string | null;
  /** In the transaction's currency, e.g. `12.34`. */
  amount: string | null;
  merchant: string;
  spentBy: string | null;
  memo: string | null;
  fund: string | null;
  /** Accounting codes, as `Category: Option`. */
  coding: string[];
}

export interface RampReimbursement {
  providerId: string;
  /** When the expense happened. */
  date: string | null;
  submittedAt: string | null;
  amount: string;
  merchant: string | null;
  memo: string | null;
  /** `DRAFT`, `PENDING`, `APPROVED`, `PAID`, `REJECTED`, … */
  status: string;
  coding: string[];
  missing: string[];
  link: string | null;
}

export interface RampRequest {
  providerId: string;
  kind: string | null;
  name: string | null;
  vendor: string | null;
  requester: string | null;
  amount: string | null;
  status: string;
  date: string | null;
  reason: string | null;
}

export interface RampBill {
  providerId: string;
  vendor: string | null;
  amount: string;
  invoice: string | null;
  dueDate: string | null;
  approvalStatus: string | null;
  paymentStatus: string | null;
  pastDue: boolean;
  draft: boolean;
  memo: string | null;
  link: string | null;
}

export interface RampBillDetail extends RampBill {
  description: string | null;
  lineItems: { description: string; amount: string }[];
}

/** One thing in Ramp's "what needs you" feed, with the objects it names. */
export interface RampTask {
  kind: string;
  summary: string;
  objects: { kind: RampObjectKind; providerId: string }[];
}

export interface RampAttentionSection {
  kind: string;
  name: string;
  total: number;
  tasks: RampTask[];
}

export type RampObjectKind =
  "rampTransaction" | "rampReimbursement" | "rampRequest" | "rampBill";

export interface RampProvider {
  transactions(
    filter: {
      scope: RampScope;
      text?: string | undefined;
      since?: string | undefined;
      until?: string | undefined;
      state?: "pending" | "cleared" | "declined" | "all" | undefined;
      missing?: boolean | undefined;
    },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<RampPage<RampTransaction>>;
  transaction(providerId: string): Promise<RampTransactionDetail>;
  reimbursements(
    filter: {
      scope: RampScope;
      text?: string | undefined;
      since?: string | undefined;
      until?: string | undefined;
    },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<RampPage<RampReimbursement>>;
  reimbursement(providerId: string): Promise<RampReimbursement>;
  requests(page: {
    limit: number;
    cursor?: string | undefined;
  }): Promise<RampPage<RampRequest>>;
  request(providerId: string): Promise<RampRequest>;
  bills(
    filter: { text?: string | undefined; unpaid?: boolean | undefined },
    page: { limit: number; cursor?: string | undefined },
  ): Promise<RampPage<RampBill>>;
  bill(providerId: string): Promise<RampBillDetail>;
  attention(): Promise<RampAttentionSection[]>;
}

const text = z.string().nullish();
const money = z.union([z.string(), z.number()]).nullish();

/** A money value as text: Ramp sends display strings or plain numbers. */
const amountText = (
  value: string | number | null | undefined,
  currency?: string | null,
) =>
  value === null || value === undefined
    ? ""
    : typeof value === "number"
      ? `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`
      : value;

/** The names of the `missing_*` flags that are set, without the prefix. */
const missingOf = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.entries(value).flatMap(([key, set]) =>
        set === true || (Array.isArray(set) && set.length > 0)
          ? [key.replace(/^missing_/, "")]
          : [],
      )
    : [];

const codingSchema = z
  .array(
    z.looseObject({
      category_name: text,
      option_label: text,
      option_name: text,
    }),
  )
  .nullish();
const codingOf = (value: z.infer<typeof codingSchema>) =>
  (value ?? []).map(
    (c) =>
      `${c.category_name ?? "?"}: ${c.option_label ?? c.option_name ?? "?"}`,
  );

/** A person as Ramp sends one: a name, or an object with names and email. */
const personOf = (value: unknown): string | null => {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  const p = value as Record<string, unknown>;
  const name = [p.first_name, p.last_name].filter(
    (part) => typeof part === "string",
  );
  if (name.length > 0) return name.join(" ");
  for (const key of ["name", "full_name", "email"])
    if (typeof p[key] === "string") return p[key];
  return null;
};

const transactionSchema = z.looseObject({
  transaction_uuid: z.string(),
  transaction_time: text,
  amount: money,
  original_amount: money,
  original_currency: text,
  merchant_name: text,
  merchant_category: text,
  spent_by_user: text,
  state: text,
  decline_reason: text,
  reason_or_justification: text,
  trip_name: text,
  spend_allocation_name: text,
  missing_items: z.unknown().optional(),
  transaction_link: text,
});

const reimbursementSchema = z.looseObject({
  uuid: z.string(),
  transaction_date: text,
  submitted_at: text,
  amount: money,
  currency: text,
  merchant_name: text,
  memo: text,
  status: text,
  tracking_category_selections: codingSchema,
  missing_items: z.unknown().optional(),
  reimbursement_link: text,
});

const billSchema = z.looseObject({
  id: z.string(),
  vendor_name: text,
  amount: money,
  currency: text,
  invoice_number: text,
  due_date: text,
  approval_status: text,
  payment_status: text,
  is_past_due: z.boolean().nullish(),
  is_draft: z.boolean().nullish(),
  memo: text,
  bill_url: text,
});

const toBill = (b: z.infer<typeof billSchema>): RampBill => ({
  providerId: b.id,
  vendor: b.vendor_name ?? null,
  amount: amountText(b.amount, b.currency),
  invoice: b.invoice_number ?? null,
  dueDate: b.due_date ?? null,
  approvalStatus: b.approval_status ?? null,
  paymentStatus: b.payment_status ?? null,
  pastDue: b.is_past_due === true,
  draft: b.is_draft === true,
  memo: b.memo ?? null,
  link: b.bill_url ?? null,
});

/** Keys in a feed task's context that name an object, by kind. */
const objectKeys: Record<string, RampObjectKind> = {
  transaction_uuid: "rampTransaction",
  transaction_id: "rampTransaction",
  reimbursement_uuid: "rampReimbursement",
  reimbursement_id: "rampReimbursement",
  bill_id: "rampBill",
  bill_uuid: "rampBill",
  request_uuid: "rampRequest",
  unified_request_id: "rampRequest",
  spend_request_uuid: "rampRequest",
};

/** Words worth showing from a feed task's context, in this order. */
const summaryKeys = [
  "title",
  "display_title",
  "name",
  "merchant_name",
  "vendor_name",
  "user_name",
  "requester_name",
  "amount",
  "display_amount",
  "description",
  "subtitle",
];

function taskOf(task: {
  task_type?: string | null | undefined;
  context?: unknown;
}): RampTask {
  const context =
    task.context && typeof task.context === "object"
      ? (task.context as Record<string, unknown>)
      : {};
  const flat: Record<string, unknown> = {};
  const walk = (value: Record<string, unknown>, depth: number) => {
    for (const [key, inner] of Object.entries(value)) {
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        if (depth < 2) walk(inner as Record<string, unknown>, depth + 1);
      } else if (!(key in flat)) flat[key] = inner;
    }
  };
  walk(context, 0);
  const summary = summaryKeys
    .flatMap((key) =>
      typeof flat[key] === "string" || typeof flat[key] === "number"
        ? [String(flat[key])]
        : [],
    )
    .slice(0, 4)
    .join(" · ");
  const objects = Object.entries(objectKeys).flatMap(([key, kind]) =>
    typeof flat[key] === "string" ? [{ kind, providerId: flat[key] }] : [],
  );
  return {
    kind: task.task_type ?? "TASK",
    summary,
    objects: objects.filter(
      (o, i) => objects.findIndex((p) => p.kind === o.kind) === i,
    ),
  };
}

/**
 * Ramp's tools answer their own errors inside a successful result (the
 * spike): `{ error: true, status_code, message }`. They become connector
 * errors here.
 */
function parsed(tool: string, raw: string): unknown {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new ProviderRefusedError(`${tool}: ${raw.slice(0, 300)}`);
  }
  if (
    body &&
    typeof body === "object" &&
    (body as { error?: unknown }).error === true
  ) {
    const { status_code: status, message } = body as {
      status_code?: number;
      message?: string;
    };
    const said = message ?? "Ramp refused the request.";
    if (/not found|not visible/i.test(said))
      throw new ProviderNotFoundError(said);
    if (status === 429 || (status !== undefined && status >= 500))
      throw new ProviderUnavailableError(`Ramp: ${said}`);
    if (status === 403)
      throw new ProviderRefusedError(
        `Ramp: ${said}`,
        "The user's Ramp role doesn't allow this; an admin's does.",
      );
    if (/more than 100 rows/i.test(said))
      throw new ProviderRefusedError(
        `Ramp: ${said}`,
        "Narrow it: a shorter --since/--until range, or search text.",
      );
    throw new ProviderRefusedError(`Ramp: ${said}`);
  }
  return body;
}

const scopes = {
  transactions: {
    mine: "my_transactions",
    all: "all_transactions_across_entire_business",
    awaiting_me: "transactions_awaiting_my_approval",
  },
  reimbursements: {
    mine: "my_reimbursements",
    all: "all_reimbursements",
    awaiting_me: "reimbursements_awaiting_my_approval",
  },
} as const;

/** `client` is a session with Ramp's MCP server for one connection. */
export function rampProvider({ client }: { client: McpClient }): RampProvider {
  const call = async <T>(
    tool: string,
    rationale: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
  ) => {
    const body = parsed(
      tool,
      await client.callTool(tool, {
        rationale: `Winston, the user's assistant: ${rationale}`,
        ...args,
      }),
    );
    const result = schema.safeParse(body);
    if (!result.success)
      throw new ProviderRefusedError(
        `${tool} answered in a shape Winston doesn't know: ${z.prettifyError(result.error).slice(0, 300)}`,
      );
    return result.data;
  };
  const defined = (args: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

  const toReimbursement = (
    r: z.infer<typeof reimbursementSchema>,
  ): RampReimbursement => ({
    providerId: r.uuid,
    date: r.transaction_date ?? null,
    submittedAt: r.submitted_at ?? null,
    amount: amountText(r.amount, r.currency),
    merchant: r.merchant_name ?? null,
    memo: r.memo ?? null,
    status: r.status ?? "UNKNOWN",
    coding: codingOf(r.tracking_category_selections),
    missing: missingOf(r.missing_items),
    link: r.reimbursement_link ?? null,
  });

  return {
    async transactions(filter, page) {
      const body = await call(
        "ramp_get_transactions",
        "list the user's transactions they asked about.",
        defined({
          transactions_to_retrieve: scopes.transactions[filter.scope],
          reason_memo_merchant_or_user_name_text_search: filter.text,
          from_date: filter.since,
          to_date: filter.until,
          state: filter.state,
          only_missing_items: filter.missing,
          page_size: page.limit,
          next_page_cursor: page.cursor,
        }),
        z.looseObject({
          transactions: z.array(transactionSchema).default([]),
          next_page_cursor: text,
        }),
      );
      return {
        items: body.transactions.map((t) => ({
          providerId: t.transaction_uuid,
          time: t.transaction_time ?? null,
          amount: amountText(t.amount),
          originalAmount:
            t.original_amount === null || t.original_amount === undefined
              ? null
              : amountText(t.original_amount, t.original_currency),
          merchant: t.merchant_name ?? "",
          category: t.merchant_category ?? null,
          spentBy: t.spent_by_user ?? null,
          state: t.state ?? "UNKNOWN",
          declineReason: t.decline_reason ?? null,
          memo: t.reason_or_justification ?? null,
          trip: t.trip_name ?? null,
          fund: t.spend_allocation_name ?? null,
          missing: missingOf(t.missing_items),
          link: t.transaction_link ?? null,
        })),
        cursor: body.next_page_cursor ?? null,
      };
    },

    async transaction(providerId) {
      const t = await call(
        "ramp_get_full_transaction_metadata",
        "show one transaction the user asked about.",
        { id: providerId },
        z.looseObject({
          id: text,
          created_at: text,
          amount_cents: z.number().nullish(),
          merchant_name: text,
          user_name: text,
          memo: text,
          fund_name: text,
          tracking_categories: codingSchema,
        }),
      );
      return {
        providerId,
        time: t.created_at ?? null,
        amount:
          t.amount_cents === null || t.amount_cents === undefined
            ? null
            : (t.amount_cents / 100).toFixed(2),
        merchant: t.merchant_name ?? "",
        spentBy: t.user_name ?? null,
        memo: t.memo ?? null,
        fund: t.fund_name ?? null,
        coding: codingOf(t.tracking_categories),
      };
    },

    async reimbursements(filter, page) {
      const body = await call(
        "ramp_get_reimbursements",
        "list the user's reimbursements they asked about.",
        defined({
          reimbursements_to_retrieve: scopes.reimbursements[filter.scope],
          search_string: filter.text,
          from_date: filter.since,
          to_date: filter.until,
          page_size: page.limit,
          next_page_cursor: page.cursor,
        }),
        z.looseObject({
          reimbursements: z.array(reimbursementSchema).default([]),
          next_page_cursor: text,
        }),
      );
      return {
        items: body.reimbursements.map(toReimbursement),
        cursor: body.next_page_cursor ?? null,
      };
    },

    async reimbursement(providerId) {
      const body = await call(
        "ramp_get_reimbursements",
        "show one reimbursement the user asked about.",
        { reimbursement_uuids: [providerId], page_size: 1 },
        z.looseObject({
          reimbursements: z.array(reimbursementSchema).default([]),
        }),
      );
      const [found] = body.reimbursements;
      if (!found) throw new ProviderNotFoundError("No such reimbursement.");
      return toReimbursement(found);
    },

    async requests(page) {
      const body = await call(
        "ramp_get_requests_to_review",
        "list requests waiting on the user.",
        defined({
          thoughts:
            "The user wants the spend requests (purchase orders, funds, travel) waiting for their review.",
          page_size: page.limit,
          start: page.cursor,
        }),
        z.looseObject({
          requests: z
            .array(
              z.looseObject({
                request_uuid: text,
                spend_request_uuid: text,
                vendor_name: text,
                requester: z.unknown().optional(),
                status: text,
                request_date: text,
                details: z.unknown().optional(),
              }),
            )
            .default([]),
          next_page_cursor: text,
        }),
      );
      return {
        items: body.requests.flatMap((r) => {
          const id = r.request_uuid ?? r.spend_request_uuid;
          if (!id) return [];
          const details =
            r.details && typeof r.details === "object"
              ? (r.details as Record<string, unknown>)
              : {};
          const pick = (key: string) =>
            typeof details[key] === "string" || typeof details[key] === "number"
              ? String(details[key])
              : null;
          return [
            {
              providerId: id,
              kind: pick("request_type") ?? pick("type"),
              name: pick("request_name") ?? pick("name"),
              vendor: r.vendor_name ?? null,
              requester: personOf(r.requester),
              amount: pick("amount"),
              status: r.status ?? "UNKNOWN",
              date: r.request_date ?? null,
              reason: pick("reason"),
            },
          ];
        }),
        cursor: body.next_page_cursor ?? null,
      };
    },

    async request(providerId) {
      const r = await call(
        "ramp_get_unified_request_details",
        "show one request the user asked about.",
        { unified_request_id: providerId },
        z.looseObject({
          request_uuid: text,
          request_name: text,
          request_type: text,
          status: text,
          amount: money,
          reason: text,
          requester_name: text,
          requester_email: text,
          submitted_date: text,
        }),
      );
      return {
        providerId,
        kind: r.request_type ?? null,
        name: r.request_name ?? null,
        vendor: null,
        requester: r.requester_name ?? r.requester_email ?? null,
        amount:
          r.amount === null || r.amount === undefined
            ? null
            : amountText(r.amount),
        status: r.status ?? "UNKNOWN",
        date: r.submitted_date ?? null,
        reason: r.reason ?? null,
      };
    },

    async bills(filter, page) {
      const body = await call(
        "ramp_list_bills",
        "list bills the user asked about.",
        defined({
          query: filter.text,
          include_paid: filter.unpaid ? false : undefined,
          limit: Math.min(page.limit, 50),
          page_cursor: page.cursor,
        }),
        z.looseObject({
          bills: z.array(billSchema).default([]),
          next_page_cursor: text,
        }),
      );
      return {
        items: body.bills.map(toBill),
        cursor: body.next_page_cursor ?? null,
      };
    },

    async bill(providerId) {
      const b = await call(
        "ramp_get_bill_details",
        "show one bill the user asked about.",
        { bill_id: providerId },
        billSchema.extend({
          id: z.string().default(providerId),
          description: text,
          line_items: z
            .array(z.looseObject({ description: text, amount: money }))
            .nullish(),
        }),
      );
      return {
        ...toBill(b),
        description: b.description ?? null,
        lineItems: (b.line_items ?? []).map((item) => ({
          description: item.description ?? "",
          amount: amountText(item.amount, b.currency),
        })),
      };
    },

    async attention() {
      const body = await call(
        "ramp_get_attention_feed",
        "see what's waiting on the user in Ramp.",
        {},
        z.looseObject({
          sections: z
            .array(
              z.looseObject({
                section_type: text,
                display_name: text,
                total_count: z.number().nullish(),
                items: z
                  .array(
                    z.looseObject({
                      task_type: text,
                      context: z.unknown().optional(),
                    }),
                  )
                  .nullish(),
              }),
            )
            .default([]),
        }),
      );
      return body.sections.map((s) => ({
        kind: s.section_type ?? "SECTION",
        name: s.display_name ?? s.section_type ?? "",
        total: s.total_count ?? s.items?.length ?? 0,
        tasks: (s.items ?? []).map(taskOf),
      }));
    },
  };
}
