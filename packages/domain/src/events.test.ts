import { describe, expect, test } from "bun:test";
import {
  eventCatalog,
  eventDefinition,
  filterFields,
  parseEventPayload,
  payloadFields,
} from "./events.ts";

const received = {
  messageId: "msg_01a",
  threadId: "thr_01a",
  account: "me@example.com",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [{ name: null, email: "me@example.com" }],
  cc: [],
  subject: "Lease",
  snippet: "Tuesday works",
  date: "2026-10-01T14:00:00.000Z",
  labels: [],
  category: "primary",
  unread: true,
  hasAttachments: false,
  isReplyToUser: true,
};

describe("event catalog", () => {
  test("every event has a unique, well-formed name, a description and a schema", () => {
    const types = eventCatalog.map((event) => event.type);
    expect(new Set(types).size).toBe(types.length);
    for (const event of eventCatalog) {
      expect(event.type).toMatch(
        /^(user_message|user_email|[a-z]+(\.[a-z_]+)+)$/,
      );
      expect(event.description).toMatch(/^[A-Z].*\.$/);
      expect(typeof event.payload.safeParse).toBe("function");
      expect(payloadFields(event)).toBeInstanceOf(Array);
    }
  });

  test("filters are known fields, used only by subscribable events, from their own domain's vocabulary", () => {
    const mail = [
      "from",
      "to",
      "subject",
      "unread",
      "has-attachment",
      "label",
      "category",
      "is-reply-to-user",
    ];
    for (const event of eventCatalog) {
      for (const filter of event.filters)
        expect(filterFields).toHaveProperty(filter);
      if (event.delivery === "always") expect(event.filters).toEqual([]);
      if (event.domain === "mail")
        for (const filter of event.filters) expect(mail).toContain(filter);
      if (event.domain === "calendar")
        for (const filter of event.filters) expect(mail).not.toContain(filter);
    }
    expect(eventDefinition("calendar.event.starting")).toMatchObject({
      abstraction: true,
      lead: true,
      scope: "event",
    });
    expect(eventDefinition("mail.message.received")?.scope).toBe("thread");
  });

  test("payloads are checked: unknown types and malformed data are refused", () => {
    expect(parseEventPayload("mail.message.received", received)).toEqual(
      received,
    );
    expect(() =>
      parseEventPayload("mail.message.received", {
        ...received,
        unread: "yes",
      }),
    ).toThrow("doesn't match the catalog");
    expect(() => parseEventPayload("mail.message.deleted", {})).toThrow(
      "Not a catalog event",
    );
    expect(
      payloadFields(
        eventDefinition("system.settings.changed") ?? eventCatalog[0],
      ).map((f) => f.name),
    ).toEqual(["field", "old", "new", "source"]);
  });
});
