import { describe, expect, test } from "bun:test";
import { cli } from "../testing.ts";

const id = "hist_01k5x9q8f3e2d1c0b9a8z7y6x5";
const item = {
  id,
  kind: "message",
  at: "2026-07-14T23:00:00.000Z",
  envelope:
    '<system_event type="user_message">\n  <sent_at>Tue, Jul 14, 2026, 7:00 PM</sent_at>\n  <text>Book Zuni</text>\n</system_event>',
};

describe("winston history", () => {
  test("search sends the words and filters, and prints each item as its envelope under its id", async () => {
    const { out, requests } = await cli(
      [
        "history",
        "search",
        "zuni",
        "café",
        "--type",
        "message",
        "--since",
        "30d",
      ],
      () => Response.json({ items: [item], nextCursor: "MTA" }),
    );
    const url = new URL(requests[0]?.url ?? "");
    expect(url.pathname).toBe("/v1/history/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: "zuni café",
      type: "message",
      since: "30d",
    });
    expect(out).toContain(`${id}\n<system_event type="user_message">`);
    expect(out).toContain("--cursor MTA");
  });

  test("winston get routes hist_ ids to history get; a bad --type is a usage error", async () => {
    const { out, requests } = await cli(["get", id], () =>
      Response.json({ id, items: [item] }),
    );
    expect(new URL(requests[0]?.url ?? "").pathname).toBe(`/v1/history/${id}`);
    expect(out).toContain("<text>Book Zuni</text>");
    const bad = await cli(["history", "search", "x", "--type", "mail"], () =>
      Response.json({}),
    );
    expect(bad.requests).toEqual([]);
  });
});
