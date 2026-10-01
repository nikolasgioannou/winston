import { describe, expect, test } from "bun:test";
import { toApiFailure } from "@winston/vm-api/connections";
import { eventRoutes } from "@winston/vm-api/events";
import { Hono } from "hono";
import { cli } from "../testing.ts";

/** The real catalog route, with the API's error mapping. */
const backend = new Hono().route("/v1/events", eventRoutes());
backend.onError((error, c) => {
  const failure = toApiFailure(error, undefined);
  if (!failure) throw error;
  return c.json(failure.body, failure.status);
});
const catalogApi = (request: Request) => {
  const url = new URL(request.url);
  return backend.request(`${url.pathname}${url.search}`);
};

describe("winston events", () => {
  test("catalog <domain> lists each event with its filters and data, from the catalog itself", async () => {
    const { out } = await cli(["events", "catalog", "mail"], catalogApi);
    expect(out).toMatchInlineSnapshot(`
      "mail.message.received  (subscribable; --scope one thread)
        A new message arrived in the inbox, not sent by the user.
        Filters: --from <address|name>, --to <address|name>, --subject <text>, --unread, --has-attachment, --label <name>, --category <name>, --is-reply-to-user
        Data: messageId, threadId, account, from, to, cc, subject, snippet, date, labels, category, unread, hasAttachments, isReplyToUser

      mail.message.sent  (subscribable; --scope one thread)
        The user sent a message, from any app (so Winston sees they already replied).
        Filters: --to <address|name>, --subject <text>, --has-attachment
        Data: messageId, threadId, account, from, to, cc, subject, snippet, date

      mail.message.labels_changed  (subscribable; --scope one thread)
        A message was read or marked unread, starred, archived or labeled.
        Filters: --label <name>
        Data: messageId, threadId, account, added, removed"
    `);
  });

  test("an unknown domain is a usage error naming the domains", async () => {
    const { code, err } = await cli(["events", "catalog", "fax"], catalogApi);
    expect(code).toBe(1);
    expect(err).toContain(
      "The domains are conversation, task, system, mail, calendar.",
    );
  });
});
