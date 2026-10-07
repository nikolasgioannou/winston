import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";

const account = { id: "acct_1", email: "ada@acme.com" };
const transactions = {
  account,
  timeZone: "America/New_York",
  items: [
    {
      id: "txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
      time: "2026-09-25T20:02:00.000Z",
      amount: "$42.50",
      originalAmount: null,
      merchant: "Uber",
      category: "Taxi",
      spentBy: "Ada Lovelace",
      state: "CLEARED",
      declineReason: null,
      memo: null,
      trip: null,
      fund: "Travel",
      missing: ["receipt"],
      link: null,
    },
  ],
  cursor: "c2",
};
const approvals = {
  account,
  sections: [
    {
      kind: "TRANSACTION_APPROVALS",
      name: "Transaction approvals",
      total: 2,
      tasks: [
        {
          kind: "APPROVE_TRANSACTION",
          summary: "Uber · $42.50",
          ids: ["txn_01k5aaaaaaaaaaaaaaaaaaaaaa"],
        },
      ],
    },
    { kind: "BILL_DRAFTS", name: "Bill drafts", total: 0, tasks: [] },
  ],
};

const answering = (body: unknown) => () => Response.json(body);

describe("winston ramp", () => {
  test("lists its objects, and suggests one for a typo", async () => {
    const help = await cli(["ramp"], answering({}));
    expect(help.code).toBe(0);
    expect(help.out).toContain("transactions");
    expect(help.out).toContain("winston ramp approvals list");

    const typo = await cli(["ramp", "transaction", "list"], answering({}));
    expect(typo.code).toBe(1);
    expect(typo.err).toContain("Did you mean `transactions`?");
  });

  test("transactions list prints a line per transaction in the user's zone, with what's missing", async () => {
    const { code, out, requests } = await cli(
      ["ramp", "transactions", "list", "--to-approve", "--since", "7d"],
      answering(transactions),
    );
    expect(code).toBe(0);
    expect(out).toBe(
      [
        "txn_01k5aaaaaaaaaaaaaaaaaaaaaa · 2026-09-25 16:02 -04:00 · $42.50 · Uber · Ada Lovelace · missing receipt",
        "… more. To see them, use --cursor c2 or narrow with --since, --until or search words.",
      ].join("\n"),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/ramp/transactions");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: "awaiting_me",
      since: "7d",
    });
  });

  test("search needs three characters, as Ramp does", async () => {
    const { code, err } = await cli(
      ["ramp", "transactions", "search", "ub"],
      answering(transactions),
    );
    expect(code).toBe(1);
    expect(err).toContain("at least three characters");
  });

  test("approvals list groups what's waiting by section, skipping empty ones", async () => {
    const { out } = await cli(
      ["ramp", "approvals", "list"],
      answering(approvals),
    );
    expect(out).toBe(
      [
        "Transaction approvals (2)",
        "  - Uber · $42.50 · txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
        "  … 1 more in Ramp.",
      ].join("\n"),
    );
  });

  test("winston get routes a txn_ id to its transaction", async () => {
    const { code, requests } = await cli(
      ["get", "txn_01k5aaaaaaaaaaaaaaaaaaaaaa"],
      answering({
        account,
        timeZone: "UTC",
        transaction: {
          id: "txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
          time: null,
          amount: "42.50",
          merchant: "Uber",
          spentBy: null,
          memo: null,
          fund: null,
          coding: [],
        },
      }),
    );
    expect(code).toBe(0);
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/ramp/transactions/txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
    );
  });
});

describe("winston ramp writes", () => {
  test("a dry run says what would happen and that nothing changed", async () => {
    const { code, out, requests } = await cli(
      [
        "ramp",
        "transactions",
        "approve",
        "txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
        "--dry-run",
      ],
      answering({
        account,
        id: "txn_01k5aaaaaaaaaaaaaaaaaaaaaa",
        decision: "approve",
        note: null,
        about: { what: "Uber 42.50", who: "Ada Lovelace" },
        dryRun: true,
      }),
    );
    expect(code).toBe(0);
    expect(out).toBe(
      "DRY RUN (nothing changed) · would approve Uber 42.50 from Ada Lovelace (txn_01k5aaaaaaaaaaaaaaaaaaaaaa)",
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(
      "/v1/ramp/transactions/txn_01k5aaaaaaaaaaaaaaaaaaaaaa/approve",
    );
    expect(await requests[0]?.json()).toEqual({ dryRun: true });
  });

  test("update needs something to change", async () => {
    const { code, err } = await cli(
      ["ramp", "transactions", "update", "txn_01k5aaaaaaaaaaaaaaaaaaaaaa"],
      answering({}),
    );
    expect(code).toBe(1);
    expect(err).toContain("Pass --memo or --comment.");
  });
});
