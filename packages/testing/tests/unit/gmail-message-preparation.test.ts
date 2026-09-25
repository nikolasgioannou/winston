import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { simpleParser } from "mailparser";
import { prepareGmailMessage, rebuildGmailMessage } from "@winston/adapters/google";
import {
  gmailMessagePreparationSchema,
  type GmailMessagePreparation,
} from "@winston/contracts/gmail-messages";

const operationId = "11111111-1111-4111-8111-111111111111";
const artifactId = "22222222-2222-4222-8222-222222222222";
const data = Buffer.from([0, 1, 2, 127, 128, 255]);
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const preparation: GmailMessagePreparation = {
  operationId,
  preparedAt: "2026-09-25T12:00:00.000Z",
  target: {
    connectionId: "33333333-3333-4333-8333-333333333333",
    calendarId: null,
    operation: "gmail.send",
    connectionRevision: 0,
    preferencesRevision: 0,
    email: "owner@example.com",
    label: "Personal",
  },
  message: {
    from: { email: "owner@example.com", name: "Νικόλας" },
    to: [{ email: "recipient@example.com", name: "Recipient, One" }],
    cc: [{ email: "copy@example.com" }],
    bcc: [{ email: "hidden@example.com" }],
    subject: "Planning — καλημέρα",
    text: "Hello 🌍\nA second line.",
    html: "<p>Hello 🌍</p>",
    reply: {
      sourceMessageId: "source1",
      threadId: "thread1",
      inReplyTo: "<parent@example.com>",
      references: ["<root@example.com>", "<parent@example.com>"],
    },
    attachments: [
      {
        artifactId,
        revision: 2,
        name: "δεδομένα.bin",
        mediaType: "application/octet-stream",
        size: data.length,
        sha256: sha256(data),
      },
    ],
  },
};
const contents = [{ artifactId, revision: 2, bytes: data }];

test("Gmail preparation preserves all approved MIME content, including Bcc and binary attachments", async () => {
  const { plan, raw } = await prepareGmailMessage(preparation, contents);
  assert.equal(plan.mimeSha256, sha256(raw));
  assert.equal(plan.mimeSize, raw.length);
  assert.equal(plan.messageId, `<${operationId}@example.com>`);
  assert.equal(/(?<!\r)\n/.test(raw.toString("utf8")), false);
  const parsed = await simpleParser(raw, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  assert.equal(parsed.from?.value[0]?.address, "owner@example.com");
  assert.equal(parsed.from.value[0].name, "Νικόλας");
  assert.ok(parsed.to && !Array.isArray(parsed.to));
  assert.deepEqual(
    parsed.to.value.map((item) => item.address),
    ["recipient@example.com"],
  );
  assert.ok(parsed.cc && !Array.isArray(parsed.cc));
  assert.deepEqual(
    parsed.cc.value.map((item) => item.address),
    ["copy@example.com"],
  );
  assert.ok(parsed.bcc && !Array.isArray(parsed.bcc));
  assert.deepEqual(
    parsed.bcc.value.map((item) => item.address),
    ["hidden@example.com"],
  );
  assert.equal(parsed.subject, preparation.message.subject);
  assert.equal(parsed.text?.trimEnd(), preparation.message.text);
  assert.equal(parsed.html, preparation.message.html);
  assert.equal(parsed.inReplyTo, "<parent@example.com>");
  assert.deepEqual(parsed.references, ["<root@example.com>", "<parent@example.com>"]);
  assert.equal(parsed.messageId, plan.messageId);
  assert.equal(parsed.date?.toISOString(), preparation.preparedAt);
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0]?.filename, "δεδομένα.bin");
  assert.deepEqual(parsed.attachments[0].content, data);
  assert.deepEqual(await rebuildGmailMessage(plan, contents), raw);
  assert.deepEqual((await prepareGmailMessage(preparation, contents)).raw, raw);
});

test("Gmail prepared bytes cannot change after review", async () => {
  const { plan } = await prepareGmailMessage(preparation, contents);
  for (const changed of [
    { ...plan, message: { ...plan.message, subject: "Changed" } },
    { ...plan, message: { ...plan.message, text: "Changed" } },
    { ...plan, message: { ...plan.message, bcc: [{ email: "other@example.com" }] } },
    { ...plan, messageId: "<forged@example.com>" },
    { ...plan, mimeSha256: "0".repeat(64) },
    { ...plan, mimeSize: plan.mimeSize + 1 },
  ])
    await assert.rejects(rebuildGmailMessage(changed, contents));
  for (const bytes of [
    [],
    [...contents, ...contents],
    [{ ...contents[0], artifactId, revision: 3, bytes: data }],
    [{ artifactId, revision: 2, bytes: Buffer.from([0, 1, 2, 127, 128, 254]) }],
  ])
    await assert.rejects(prepareGmailMessage(preparation, bytes));
});

test("Gmail composition captures attachment bytes before asynchronous encoding", async () => {
  const bytes = Buffer.from(data);
  const pending = prepareGmailMessage(preparation, [{ artifactId, revision: 2, bytes }]);
  bytes.fill(0);
  const { raw } = await pending;
  const parsed = await simpleParser(raw);
  assert.deepEqual(parsed.attachments[0]?.content, data);
});

test("Gmail preparation rejects header injection, implicit I/O, and invalid sender or recipient choices", () => {
  const message = preparation.message;
  for (const change of [
    { from: { email: "other@example.com" } },
    { from: { email: "owner@example.com", name: "Owner\r\nBcc: injected@example.com" } },
    { subject: "Subject\r\nBcc: injected@example.com" },
    { to: [{ email: "recipient@example.com\nBcc: injected@example.com" }] },
    { bcc: [{ email: "RECIPIENT@example.com" }] },
    { to: [], cc: [], bcc: [] },
    { raw: "unreviewed MIME" },
    { text: "x".repeat(80_001) },
    { text: { path: "/etc/passwd" } },
    { attachments: [{ ...message.attachments[0], path: "/etc/passwd" }] },
    { attachments: [{ ...message.attachments[0], href: "https://example.com/secret" }] },
    { attachments: [...message.attachments, ...message.attachments] },
    { reply: { ...message.reply, inReplyTo: "<parent@example.com>\r\nX-Forged: yes" } },
    { reply: { ...message.reply, references: ["<unrelated@example.com>"] } },
  ])
    assert.equal(
      gmailMessagePreparationSchema.safeParse({
        ...preparation,
        message: { ...message, ...change },
      }).success,
      false,
    );
  assert.equal(
    gmailMessagePreparationSchema.safeParse({
      ...preparation,
      target: { ...preparation.target, operation: "gmail.read" },
    }).success,
    false,
  );
  assert.equal(
    gmailMessagePreparationSchema.safeParse({
      ...preparation,
      message: { ...message, attachments: [{ ...message.attachments[0], size: 25_000_001 }] },
    }).success,
    false,
  );
});

test("Gmail attachment bytes cannot inject MIME boundaries or additional recipients", async () => {
  const bytes = Buffer.from(
    `\r\n--_NmP-${operationId}-Part_1\r\nBcc: injected@example.com\r\nContent-Type: text/plain\r\n\r\nforged`,
  );
  const attachment = preparation.message.attachments[0];
  assert.ok(attachment);
  const input = {
    ...preparation,
    message: {
      ...preparation.message,
      attachments: [
        { ...attachment, mediaType: "message/rfc822", size: bytes.length, sha256: sha256(bytes) },
      ],
    },
  };
  const { raw } = await prepareGmailMessage(input, [{ artifactId, revision: 2, bytes }]);
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
  assert.ok(parsed.bcc && !Array.isArray(parsed.bcc));
  assert.deepEqual(
    parsed.bcc.value.map((item) => item.address),
    ["hidden@example.com"],
  );
  assert.equal(parsed.attachments.length, 1);
  assert.deepEqual(parsed.attachments[0]?.content, bytes);
});

test("Gmail drafts can be prepared without recipients but never silently sent", async () => {
  const input = {
    ...preparation,
    target: { ...preparation.target, operation: "gmail.draft" as const },
    message: {
      ...preparation.message,
      to: [],
      cc: [],
      bcc: [],
      attachments: [],
      reply: null,
      html: null,
    },
  };
  const { raw, plan } = await prepareGmailMessage(input, []);
  const parsed = await simpleParser(raw);
  assert.equal(parsed.to, undefined);
  assert.equal(parsed.bcc, undefined);
  assert.equal(plan.target.operation, "gmail.draft");
  assert.equal(
    gmailMessagePreparationSchema.safeParse({
      ...input,
      target: { ...input.target, operation: "gmail.send" },
    }).success,
    false,
  );
});
