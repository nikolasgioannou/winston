import assert from "node:assert/strict";
import { test } from "bun:test";
import { actionRecordSchema } from "@winston/contracts/actions";
import {
  prepareGmailMutation,
  formatGmailMutationApproval,
  readGmailReplySource,
} from "@winston/adapters/google";

const id = "11111111-1111-4111-8111-111111111111";
const accountId = "22222222-2222-4222-8222-222222222222";
const target = {
  connectionId: accountId,
  calendarId: null,
  operation: "gmail.send" as const,
  connectionRevision: 0,
  preferencesRevision: 0,
  email: "owner@example.com",
  label: "Personal",
};
const source = { ...target, operation: "gmail.read" as const };
const message = {
  from: { email: target.email, name: "Owner" },
  to: [{ email: "to@example.com" }],
  cc: [{ email: "cc@example.com" }],
  bcc: [{ email: "hidden@example.com" }],
  subject: "Exact subject",
  text: "First line\nSecond line",
  html: "<p>Exact HTML</p>",
  reply: null,
  attachments: [],
};

test("Gmail review shows exact recipients and replacement/send consequences", async () => {
  const prepared = await prepareGmailMutation(
    {
      operationId: id,
      preparedAt: "2030-01-01T00:00:00.000Z",
      target,
      intent: {
        kind: "draft.send",
        accountId,
        message,
        draftId: "draft1",
        expectedMessageId: "m1",
      },
      draft: { source, id: "draft1", messageId: "m1" },
    },
    [],
  );
  const action = actionRecordSchema.parse({
    id,
    operationId: id,
    hash: "a".repeat(64),
    intentRevision: 0,
    snapshot: null,
    state: "pending",
    revision: 0,
    expiresAt: "2030-01-01T00:15:00.000Z",
    decisionSource: null,
    dispatchTask: null,
    outcome: null,
    request: {
      key: "review",
      task: { id, revision: 1, generation: 0 },
      authorization: {
        target: { kind: "connection", id: accountId, resource: null },
        operation: "gmail.send",
      },
      arguments: prepared.plan,
    },
  });
  const text = formatGmailMutationApproval(action);
  for (const expected of [
    "Send Gmail draft using this content",
    'Account: "owner@example.com"',
    'From: "owner@example.com" ("Owner")',
    'To: "to@example.com"',
    'Cc: "cc@example.com"',
    'Bcc: "hidden@example.com"',
    'Subject: "Exact subject"',
    'Text: "First line\\nSecond line"',
    'HTML source: "<p>Exact HTML</p>"',
    'Reviewed version: "m1"',
    "full content",
    "simultaneous edit",
    "removes the draft after sending",
    "Attachments:\nNone",
  ])
    assert.ok(text.includes(expected), expected);
  assert.ok(!text.includes("connectionRevision"));
  assert.throws(() => formatGmailMutationApproval({ ...action, operationId: accountId }));
  assert.throws(() =>
    formatGmailMutationApproval({
      ...action,
      request: {
        ...action.request,
        authorization: { ...action.request.authorization, operation: "gmail.draft" },
      },
    }),
  );
});

test("Gmail reply sources decode encoded subjects and reject ambiguous/injected headers", async () => {
  const input = {
    source,
    trust: "untrusted_external_content",
    id: "parent1",
    threadId: "t1",
    headers: [
      { name: "Subject", value: "=?UTF-8?B?5pel5pys6Kqe?=" },
      { name: "Message-ID", value: "<parent@example.com>" },
    ],
  };
  const parsed = await readGmailReplySource(input);
  assert.equal(parsed.subject, "日本語");
  assert.equal(parsed.messageId, "<parent@example.com>");
  for (const headers of [
    [...input.headers, { name: "subject", value: "Other" }],
    [{ name: "Subject", value: "Title\r\nBcc: injected@example.com" }, input.headers[1]],
    [{ name: "Subject", value: "Title" }],
  ])
    await assert.rejects(readGmailReplySource({ ...input, headers }));
});
