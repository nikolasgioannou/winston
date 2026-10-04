import { describe, expect, test } from "bun:test";
import { splitForwarded } from "./mail-body.ts";
import { attachmentContent, parseMail } from "./mail-parse.ts";

/*
 * Synthetic messages written by hand, shaped like what SES receives: no one's
 * real mail is in the repository.
 */
const crlf = (lines: string[]) => new TextEncoder().encode(lines.join("\r\n"));

const reply = crlf([
  'From: "Dana Scully" <dana@acme.example>',
  "To: ada@runwinston.email, Undisclosed: ;",
  "Cc: Fox <fox@acme.example>",
  "Reply-To: team@acme.example",
  "Subject: Re: Lunch on Friday",
  "Date: Fri, 02 Oct 2026 14:05:00 -0400",
  "Message-ID: <reply-2@acme.example>",
  "In-Reply-To: <first-1@runwinston.email>",
  "References: <start-0@acme.example> <first-1@runwinston.email>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="mixed"',
  "",
  "--mixed",
  'Content-Type: multipart/alternative; boundary="alt"',
  "",
  "--alt",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Friday works.   See you at noon.",
  "",
  "On Thu, Oct 1, 2026 Winston wrote:",
  "> Does Friday work?",
  "--alt",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<p>Friday works. See you at noon.</p>",
  "--alt--",
  "--mixed",
  'Content-Type: application/pdf; name="menu.pdf"',
  'Content-Disposition: attachment; filename="menu.pdf"',
  "Content-Transfer-Encoding: base64",
  "",
  Buffer.from("%PDF-1.4 menu").toString("base64"),
  "--mixed--",
  "",
]);

describe("parseMail", () => {
  test("reads people, threading headers, the readable body and attachments", async () => {
    expect(await parseMail(reply)).toEqual({
      messageIdHeader: "<reply-2@acme.example>",
      inReplyTo: "<first-1@runwinston.email>",
      references: ["<start-0@acme.example>", "<first-1@runwinston.email>"],
      from: { name: "Dana Scully", email: "dana@acme.example" },
      to: [{ name: null, email: "ada@runwinston.email" }],
      cc: [{ name: "Fox", email: "fox@acme.example" }],
      replyTo: [{ name: null, email: "team@acme.example" }],
      subject: "Re: Lunch on Friday",
      date: new Date("2026-10-02T18:05:00Z"),
      body: "Friday works.   See you at noon.",
      quotedTextHidden: true,
      snippet: "Friday works. See you at noon.",
      attachments: [
        {
          providerId: "1",
          filename: "menu.pdf",
          mimeType: "application/pdf",
          size: 13,
        },
      ],
    });
  });

  test("an attachment's bytes come back by its part number", async () => {
    const pdf = await attachmentContent(reply, "1");
    expect(pdf?.filename).toBe("menu.pdf");
    expect(new TextDecoder().decode(pdf?.content)).toBe("%PDF-1.4 menu");
    expect(await attachmentContent(reply, "2")).toBeUndefined();
  });

  test("HTML-only mail in Latin-1 reads as text, and inline images aren't attachments", async () => {
    const latin1 = Buffer.from("<p>Caf\xe9 cr\xe8me</p>", "latin1");
    const raw = new Uint8Array(
      Buffer.concat([
        Buffer.from(
          [
            "From: shop@example.com",
            "To: ada@runwinston.email",
            "Subject: =?utf-8?q?Your_r=C3=A9ceipt?=",
            "Date: not a date",
            "MIME-Version: 1.0",
            'Content-Type: multipart/related; boundary="rel"',
            "",
            "--rel",
            "Content-Type: text/html; charset=iso-8859-1",
            "",
            "",
          ].join("\r\n"),
        ),
        latin1,
        Buffer.from(
          [
            "",
            "--rel",
            "Content-Type: image/png",
            "Content-ID: <logo>",
            "Content-Disposition: inline",
            "Content-Transfer-Encoding: base64",
            "",
            "iVBORw0KGgo=",
            "--rel--",
            "",
          ].join("\r\n"),
        ),
      ]),
    );
    const parsed = await parseMail(raw);
    expect(parsed.subject).toBe("Your réceipt");
    expect(parsed.body).toBe("Café crème");
    expect(parsed.date).toBeNull();
    expect(parsed.messageIdHeader).toBeNull();
    expect(parsed.references).toEqual([]);
    expect(parsed.from).toEqual({ name: null, email: "shop@example.com" });
    expect(parsed.attachments).toEqual([]);
  });
});

describe("splitForwarded", () => {
  test("splits at Gmail's, Apple Mail's and Outlook's markers, or not at all", () => {
    for (const marker of [
      "---------- Forwarded message ---------",
      "Begin forwarded message:",
      "-----Original Message-----",
    ])
      expect(
        splitForwarded(`Can you handle this?\n\n${marker}\nFrom: Sam\nHi`),
      ).toEqual({
        own: "Can you handle this?",
        forwarded: `${marker}\nFrom: Sam\nHi`,
      });
    expect(splitForwarded("Winston, find us a time.")).toEqual({
      own: "Winston, find us a time.",
      forwarded: null,
    });
  });
});
