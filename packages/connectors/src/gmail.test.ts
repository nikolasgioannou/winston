import { describe, expect, test } from "bun:test";
import {
  NotSupportedError,
  ProviderNotFoundError,
  ProviderUnavailableError,
} from "./errors.ts";
import {
  gmailQuery,
  gmailReader,
  parseAddresses,
  stripQuotedText,
} from "./gmail.ts";

/*
 * Synthetic Gmail API responses, shaped exactly like the API's (users.messages,
 * users.threads, users.labels): base64url bodies, nested multiparts, headers
 * as name/value pairs. Made up rather than captured, so no one's mail is in
 * the repository.
 */
const b64 = (text: string, encoding: BufferEncoding = "utf8") =>
  Buffer.from(text, encoding).toString("base64url");

const headers = (values: Record<string, string>) =>
  Object.entries(values).map(([name, value]) => ({ name, value }));

const reply = {
  id: "m-reply",
  threadId: "t-lease",
  labelIds: ["INBOX", "UNREAD", "Label_7"],
  snippet: "Tuesday works &amp; I&#39;ll bring the keys",
  internalDate: String(Date.UTC(2026, 8, 25, 20, 2)),
  payload: {
    partId: "",
    mimeType: "multipart/alternative",
    headers: headers({
      From: '"Reyes, Dana" <Dana@Example.com>',
      To: "me@example.com, Sam Lee <sam@example.com>",
      Subject: "Re: Lease renewal",
      "Message-ID": "<abc@mail.example.com>",
      References: "<first@mail.example.com>",
    }),
    parts: [
      {
        partId: "0",
        mimeType: "text/plain",
        headers: headers({ "Content-Type": 'text/plain; charset="UTF-8"' }),
        body: {
          data: b64(
            "Tuesday works & I'll bring the keys.\n\nOn Thu, Sep 24, 2026 at 9:41 AM Me <me@example.com>\nwrote:\n> Does Tuesday work?\n> Thanks",
          ),
        },
      },
      {
        partId: "1",
        mimeType: "text/html",
        headers: headers({ "Content-Type": "text/html; charset=UTF-8" }),
        body: { data: b64("<p>Tuesday works</p>") },
      },
    ],
  },
};

const newsletter = {
  id: "m-news",
  threadId: "t-news",
  labelIds: ["CATEGORY_PROMOTIONS"],
  snippet: "This week",
  internalDate: String(Date.UTC(2026, 8, 24, 12, 0)),
  payload: {
    partId: "",
    mimeType: "multipart/related",
    headers: headers({
      From: "Café Weekly <news@cafe.example>",
      Subject: "This week at the café",
    }),
    parts: [
      {
        partId: "0",
        mimeType: "text/html",
        headers: headers({ "Content-Type": "text/html; charset=ISO-8859-1" }),
        body: {
          data: b64(
            '<html><body><h1>Café news</h1><img src="cid:logo"><p>Read <a href="https://cafe.example/a">the story</a>.</p><style>p{color:red}</style></body></html>',
            "latin1",
          ),
        },
      },
      {
        partId: "1",
        mimeType: "image/png",
        filename: "logo.png",
        headers: headers({
          "Content-Disposition": "inline; filename=logo.png",
          "Content-ID": "<logo>",
        }),
        body: { attachmentId: "ANGjdJ-inline", size: 2048 },
      },
    ],
  },
};

const withPdf = {
  id: "m-pdf",
  threadId: "t-lease",
  labelIds: ["INBOX", "STARRED"],
  snippet: "Lease attached",
  internalDate: String(Date.UTC(2026, 8, 24, 13, 41)),
  payload: {
    partId: "",
    mimeType: "multipart/mixed",
    headers: headers({
      From: "me@example.com",
      To: "Dana@Example.com",
      Subject: "Lease renewal",
    }),
    parts: [
      {
        partId: "0",
        mimeType: "multipart/alternative",
        parts: [
          {
            partId: "0.0",
            mimeType: "text/html",
            body: {
              data: b64(
                '<div>Lease attached.</div><div class="gmail_quote">On Mon someone wrote:<blockquote>old</blockquote></div>',
              ),
            },
          },
        ],
      },
      {
        partId: "1",
        mimeType: "application/pdf",
        filename: "lease.pdf",
        headers: headers({
          "Content-Disposition": 'attachment; filename="lease.pdf"',
        }),
        body: { attachmentId: "ANGjdJ-fetch-1", size: 81_234 },
      },
    ],
  },
};

const messages: Record<string, unknown> = {
  "m-reply": reply,
  "m-news": newsletter,
  "m-pdf": withPdf,
};

/** Answers Gmail API paths from the fixtures, recording each request. */
function fakeGmail(overrides: Record<string, () => Response> = {}) {
  const requests: string[] = [];
  const fetchImpl = ((input: string, init?: RequestInit) => {
    const url = new URL(input);
    const path = url.pathname.replace("/gmail/v1/users/me", "");
    requests.push(`${path}${url.search}`);
    expect(new Headers(init?.headers).get("Authorization")).toBe(
      "Bearer token-1",
    );
    const override = overrides[path];
    if (override) return Promise.resolve(override());
    const json = (body: unknown) => Promise.resolve(Response.json(body));
    if (path === "/labels")
      return json({
        labels: [
          { id: "INBOX", name: "INBOX", type: "system" },
          { id: "Label_7", name: "Lease stuff", type: "user" },
        ],
      });
    if (path === "/messages") {
      const page = url.searchParams.get("pageToken");
      return json(
        page
          ? { messages: [{ id: "m-news" }], resultSizeEstimate: 3 }
          : {
              messages: [{ id: "m-reply" }, { id: "m-pdf" }],
              nextPageToken: "p2",
              resultSizeEstimate: 3,
            },
      );
    }
    const message = /^\/messages\/([^/]+)$/.exec(path)?.[1];
    if (message) {
      const found = messages[message];
      return found
        ? json(found)
        : Promise.resolve(new Response("{}", { status: 404 }));
    }
    if (path === "/threads/t-lease")
      return json({ id: "t-lease", messages: [reply, withPdf] });
    if (path === "/messages/m-pdf/attachments/ANGjdJ-fetch-1")
      return json({ data: b64("%PDF-1.7 lease"), size: 14 });
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as unknown as typeof fetch;
  return {
    requests,
    gmail: gmailReader({
      address: "me@example.com",
      accessToken: () => Promise.resolve("token-1"),
      fetch: fetchImpl,
    }),
  };
}

describe("gmailQuery", () => {
  test("translates the portable filters", () => {
    expect(
      gmailQuery({
        folder: "inbox",
        from: "Dana Reyes",
        to: "me@example.com",
        subject: "lease",
        unread: true,
        hasAttachment: true,
        label: "Lease stuff",
        category: "Promotions",
        text: "keys",
        since: new Date("2026-09-20T04:00:00Z"),
        until: new Date("2026-09-27T04:00:00.500Z"),
      }),
    ).toBe(
      'in:inbox from:"Dana Reyes" to:me@example.com subject:lease is:unread has:attachment label:"Lease stuff" category:promotions keys after:1789876800 before:1790481601',
    );
  });

  test("folders, read mail, and --native, which keeps the folder and time range", () => {
    expect(gmailQuery({ folder: "archive", unread: false })).toBe(
      "-in:inbox -in:drafts -is:unread",
    );
    expect(gmailQuery({ folder: "all" })).toBe("");
    expect(
      gmailQuery({
        folder: "sent",
        native: "has:drive OR has:document",
        from: "ignored",
        since: new Date(0),
      }),
    ).toBe("in:sent has:drive OR has:document after:0");
  });
});

describe("parsing", () => {
  test("address lists with quoted names, commas inside quotes and bare addresses", () => {
    expect(
      parseAddresses(
        '"Reyes, Dana" <Dana@Example.com>, sam@x.com,  <bo@y.com>',
      ),
    ).toEqual([
      { name: "Reyes, Dana", email: "dana@example.com" },
      { name: null, email: "sam@x.com" },
      { name: null, email: "bo@y.com" },
    ]);
    expect(parseAddresses(undefined)).toEqual([]);
  });

  test("a plain-text reply's quoted tail is hidden only when it's really quoted", () => {
    expect(
      stripQuotedText("Yes.\n\nOn Mon, Sep 1 Dana wrote:\n> Lunch?"),
    ).toEqual({
      text: "Yes.",
      hidden: true,
    });
    const notQuoted = "On Monday the team wrote: a plan.\nIt has steps.";
    expect(stripQuotedText(notQuoted)).toEqual({
      text: notQuoted,
      hidden: false,
    });
  });
});

describe("gmailReader", () => {
  test("lists newest first with flags, user labels by name, attachments, a cursor and the estimate", async () => {
    const { gmail, requests } = fakeGmail();
    const page = await gmail.list(
      { folder: "inbox", unread: true },
      { limit: 2 },
    );
    expect(requests[0]).toBe("/messages?maxResults=2&q=in%3Ainbox+is%3Aunread");
    expect(page.cursor).toBe("p2");
    expect(page.estimatedTotal).toBe(3);
    expect(page.items.map((m) => m.providerId)).toEqual(["m-reply", "m-pdf"]);
    expect(page.items[0]).toMatchObject({
      threadId: "t-lease",
      from: { name: "Reyes, Dana", email: "dana@example.com" },
      to: [
        { name: null, email: "me@example.com" },
        { name: "Sam Lee", email: "sam@example.com" },
      ],
      subject: "Re: Lease renewal",
      snippet: "Tuesday works & I'll bring the keys",
      unread: true,
      starred: false,
      inInbox: true,
      labels: ["Lease stuff"],
      date: new Date(Date.UTC(2026, 8, 25, 20, 2)),
      messageIdHeader: "<abc@mail.example.com>",
    });
    const next = await gmail.list(
      { folder: "inbox" },
      { limit: 2, cursor: "p2" },
    );
    expect(next.cursor).toBeNull();
    expect(next.items.map((m) => m.providerId)).toEqual(["m-news"]);
  });

  test("a body prefers plain text and hides the quoted reply", async () => {
    const { gmail } = fakeGmail();
    const message = await gmail.getMessage("m-reply");
    expect(message.body).toBe("Tuesday works & I'll bring the keys.");
    expect(message.quotedTextHidden).toBe(true);
    expect(message.references).toEqual(["<first@mail.example.com>"]);
  });

  test("HTML-only mail becomes readable text in its own charset, without styles, images or inline images listed", async () => {
    const { gmail } = fakeGmail();
    const message = await gmail.getMessage("m-news");
    expect(message.body).toContain("CAFÉ NEWS");
    expect(message.body).toContain("Read the story [https://cafe.example/a].");
    expect(message.body).not.toContain("color:red");
    expect(message.attachments).toEqual([]);
    expect(message.quotedTextHidden).toBe(false);
  });

  test("attachments are named by message and part, and downloaded with Gmail's current attachment id", async () => {
    const { gmail, requests } = fakeGmail();
    const message = await gmail.getMessage("m-pdf");
    expect(message.body).toBe("Lease attached.");
    expect(message.quotedTextHidden).toBe(true);
    expect(message.attachments).toEqual([
      {
        providerId: "m-pdf/1",
        filename: "lease.pdf",
        mimeType: "application/pdf",
        size: 81_234,
      },
    ]);
    const file = await gmail.getAttachment("m-pdf/1");
    expect(file.filename).toBe("lease.pdf");
    expect(new TextDecoder().decode(file.data)).toBe("%PDF-1.7 lease");
    expect(requests.at(-1)).toBe("/messages/m-pdf/attachments/ANGjdJ-fetch-1");
    expect(gmail.getAttachment("nonsense")).rejects.toBeInstanceOf(
      NotSupportedError,
    );
  });

  test("a thread comes oldest first", async () => {
    const { gmail } = fakeGmail();
    const thread = await gmail.getThread("t-lease");
    expect(thread.messages.map((m) => m.providerId)).toEqual([
      "m-pdf",
      "m-reply",
    ]);
    expect(thread.subject).toBe("Lease renewal");
  });

  test("a missing message is not found; rate limits and outages are worth retrying", () => {
    const { gmail } = fakeGmail({
      "/messages/m-busy": () => new Response("{}", { status: 429 }),
    });
    expect(gmail.getMessage("m-gone")).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
    expect(gmail.getMessage("m-busy")).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});
