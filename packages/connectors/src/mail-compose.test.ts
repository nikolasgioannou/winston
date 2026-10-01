import { describe, expect, test } from "bun:test";
import type { FullMailMessage } from "./mail.ts";
import { composeRaw, forwardOf, replyTo } from "./mail-compose.ts";

const original: FullMailMessage = {
  providerId: "m-1",
  threadId: "t-1",
  from: { name: "Dana Reyes", email: "dana@example.com" },
  to: [
    { name: null, email: "me@example.com" },
    { name: "Sam Lee", email: "sam@example.com" },
  ],
  cc: [
    { name: null, email: "Dana@Example.com" },
    { name: "Bo", email: "bo@example.com" },
  ],
  subject: "Lease renewal",
  date: new Date("2026-09-25T20:02:00Z"),
  snippet: "",
  unread: false,
  starred: false,
  inInbox: true,
  labels: [],
  attachments: [],
  messageIdHeader: "<abc@mail.example.com>",
  body: "Does Tuesday work?",
  references: ["<first@mail.example.com>"],
  replyTo: [],
  quotedTextHidden: false,
};

/** A composed message with its random multipart boundary made stable. */
const stable = (raw: Uint8Array) =>
  new TextDecoder()
    .decode(raw)
    .replace(/--_NmP-[0-9a-f]+-Part_1/g, "--_NmP-BOUNDARY-Part_1");

describe("composing mail", () => {
  test("a message with a non-ASCII subject, Bcc kept for delivery, threading headers and an attachment", async () => {
    const raw = await composeRaw(
      {
        to: ["Dana Reyes <dana@example.com>"],
        cc: ["sam@example.com"],
        bcc: ["archive@example.com"],
        subject: "Café ☕ plans",
        body: "Tuesday works.\nThanks",
        attachments: [
          {
            filename: "lease.pdf",
            mimeType: "application/pdf",
            data: new TextEncoder().encode("%PDF"),
          },
        ],
        inReplyTo: {
          threadId: "t-1",
          messageIdHeader: "<abc@x>",
          references: ["<first@x>"],
        },
      },
      { messageId: "<sent@winston>", date: new Date("2026-09-26T13:00:00Z") },
    );
    expect(stable(raw)).toBe(
      [
        "To: Dana Reyes <dana@example.com>",
        "Cc: sam@example.com",
        "Bcc: archive@example.com",
        "In-Reply-To: <abc@x>",
        "References: <first@x> <abc@x>",
        "Subject: =?UTF-8?Q?Caf=C3=A9_=E2=98=95_plans?=",
        "Message-ID: <sent@winston>",
        "Date: Sat, 26 Sep 2026 13:00:00 +0000",
        "MIME-Version: 1.0",
        'Content-Type: multipart/mixed; boundary="--_NmP-BOUNDARY-Part_1"',
        "",
        "----_NmP-BOUNDARY-Part_1",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: 7bit",
        "",
        "Tuesday works.",
        "Thanks",
        "----_NmP-BOUNDARY-Part_1",
        "Content-Type: application/pdf; name=lease.pdf",
        "Content-Transfer-Encoding: base64",
        "Content-Disposition: attachment; filename=lease.pdf",
        "",
        "JVBERg==",
        "----_NmP-BOUNDARY-Part_1--",
        "",
      ].join("\r\n"),
    );
  });

  test("a reply goes to the sender, threads, and adds Re: once", () => {
    const reply = replyTo(original, {
      body: "Yes.",
      all: false,
      self: "me@example.com",
    });
    expect(reply).toEqual({
      to: ["Dana Reyes <dana@example.com>"],
      subject: "Re: Lease renewal",
      body: "Yes.",
      inReplyTo: {
        threadId: "t-1",
        messageIdHeader: "<abc@mail.example.com>",
        references: ["<first@mail.example.com>"],
      },
    });
    expect(
      replyTo(
        { ...original, subject: "RE: Lease" },
        { body: "", all: false, self: "me@example.com" },
      ).subject,
    ).toBe("RE: Lease");
  });

  test("reply-all copies everyone else once, never the user", () => {
    const reply = replyTo(original, {
      body: "Yes.",
      all: true,
      self: "ME@example.com",
    });
    expect(reply.to).toEqual(["Dana Reyes <dana@example.com>"]);
    expect(reply.cc).toEqual([
      "Sam Lee <sam@example.com>",
      "Bo <bo@example.com>",
    ]);
  });

  test("Reply-To wins over From; replying to your own message goes to its recipients", () => {
    expect(
      replyTo(
        { ...original, replyTo: [{ name: null, email: "list@example.com" }] },
        { body: "", all: false, self: "me@example.com" },
      ).to,
    ).toEqual(["list@example.com"]);
    expect(
      replyTo(
        { ...original, from: { name: "Me", email: "me@example.com" } },
        { body: "", all: false, self: "me@example.com" },
      ).to,
    ).toEqual(["Sam Lee <sam@example.com>"]);
  });

  test("a forward puts the original under the note, with its attachments", () => {
    const attachments = [
      {
        filename: "lease.pdf",
        mimeType: "application/pdf",
        data: new Uint8Array([1]),
      },
    ];
    const forward = forwardOf(original, {
      to: ["lawyer@example.com"],
      body: "FYI",
      attachments,
      date: "2026-09-25 16:02 -04:00",
    });
    expect(forward.subject).toBe("Fwd: Lease renewal");
    expect(forward.attachments).toBe(attachments);
    expect(forward.body).toBe(
      [
        "FYI",
        "",
        "---------- Forwarded message ---------",
        "From: Dana Reyes <dana@example.com>",
        "Date: 2026-09-25 16:02 -04:00",
        "Subject: Lease renewal",
        "To: me@example.com, Sam Lee <sam@example.com>",
        "Cc: Dana@Example.com, Bo <bo@example.com>",
        "",
        "Does Tuesday work?",
      ].join("\n"),
    );
  });
});
