import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  prepareGmailMutation,
  rebuildGmailMutation,
  readGmailMutationPlan,
  gmailMutationIntent,
} from "@winston/adapters/google";
import type { GmailMutationIntent } from "@winston/contracts/gmail-mutations";

const accountId = "9cbd0d78-55a2-4885-bb6e-c4e112f2c988";
const operationId = "219fb112-6f15-4c18-b282-b0e0c5a205d7";
const target = {
  connectionId: accountId,
  calendarId: null,
  connectionRevision: 2,
  preferencesRevision: 1,
  label: "Personal",
  email: "me@example.com",
  operation: "gmail.send" as const,
};
const source = { ...target, operation: "gmail.read" as const };
const message = {
  from: { email: "me@example.com" },
  to: [{ email: "friend@example.com" }],
  cc: [],
  bcc: [],
  subject: "Plan",
  text: "Exact body",
  html: null,
  reply: null,
  attachments: [],
};
const draft = { source, id: "draft1", messageId: "m1" };
const common = { operationId, preparedAt: "2030-01-01T12:00:00.000Z", target };

for (const kind of ["draft.create", "draft.update", "message.send", "draft.send"] as const) {
  test(`Gmail ${kind} derives the fixed endpoint and exact raw content`, async () => {
    const existing = kind === "draft.update" || kind === "draft.send";
    const intent: GmailMutationIntent = existing
      ? { kind, accountId, message, draftId: draft.id, expectedMessageId: draft.messageId }
      : { kind, accountId, message };
    const input = {
      ...common,
      target: {
        ...target,
        operation: kind.endsWith("send") ? ("gmail.send" as const) : ("gmail.draft" as const),
      },
      intent,
      ...(existing ? { draft } : {}),
    };
    const prepared = await prepareGmailMutation(input, []);
    assert.deepEqual(gmailMutationIntent(prepared.plan), intent);
    assert.deepEqual(readGmailMutationPlan(prepared.plan), prepared.plan);
    assert.equal(
      prepared.plan.path,
      kind === "draft.create"
        ? "drafts"
        : kind === "draft.update"
          ? "drafts/draft1"
          : kind === "draft.send"
            ? "drafts/send"
            : "messages/send",
    );
    assert.equal(prepared.plan.method, kind === "draft.update" ? "PUT" : "POST");
    const rebuilt = await rebuildGmailMutation(prepared.plan, []);
    const expectedMessage = { raw: prepared.raw.toString("base64url") };
    assert.deepEqual(
      rebuilt.body,
      kind === "message.send"
        ? expectedMessage
        : { ...(existing ? { id: "draft1" } : {}), message: expectedMessage },
    );
    for (const change of [
      { path: "messages/delete" },
      { method: "DELETE" },
      { draft: existing ? { ...draft, messageId: "" } : draft },
    ])
      assert.throws(() => readGmailMutationPlan({ ...prepared.plan, ...change }));
    await assert.rejects(
      rebuildGmailMutation(
        {
          ...prepared.plan,
          prepared: { ...prepared.plan.prepared, message: { ...message, text: "unreviewed" } },
        },
        [],
      ),
    );
  });
}

test("Gmail draft plans reject stale or foreign versions and wrong operation authority", async () => {
  const input = {
    ...common,
    intent: {
      kind: "draft.send" as const,
      accountId,
      message,
      draftId: "draft1",
      expectedMessageId: "m1",
    },
    draft,
  };
  for (const changed of [
    { draft: undefined },
    { draft: { ...draft, id: "other" } },
    { draft: { ...draft, messageId: "newer" } },
    { draft: { ...draft, source: { ...source, connectionRevision: 3 } } },
    { draft: { ...draft, source: { ...source, connectionId: operationId } } },
    { target: { ...target, operation: "gmail.draft" as const } },
    { intent: { ...input.intent, accountId: operationId } },
  ])
    await assert.rejects(prepareGmailMutation({ ...input, ...changed } as typeof input, []));
});

test("Gmail replies bind the read source, thread, parent header and matching subject", async () => {
  const reply = {
    sourceMessageId: "parent1",
    threadId: "thread1",
    inReplyTo: "<parent@example.com>",
    references: ["<parent@example.com>"],
  };
  const replySource = {
    source,
    id: "parent1",
    threadId: "thread1",
    messageId: "<parent@example.com>",
    subject: "Plan",
  };
  const input = {
    ...common,
    intent: {
      kind: "message.send" as const,
      accountId,
      message: { ...message, subject: "Re: Plan", reply },
    },
    replySource,
  };
  const prepared = await prepareGmailMutation(input, []);
  const rebuilt = await rebuildGmailMutation(prepared.plan, []);
  assert.equal("threadId" in rebuilt.body && rebuilt.body.threadId, "thread1");
  for (const changed of [
    { id: "wrong" },
    { threadId: "wrong" },
    { messageId: "<wrong@example.com>" },
    { subject: "different subject" },
    { source: { ...source, preferencesRevision: 2 } },
  ])
    await assert.rejects(
      prepareGmailMutation({ ...input, replySource: { ...replySource, ...changed } }, []),
    );
  await assert.rejects(
    prepareGmailMutation(
      { ...common, intent: { kind: "message.send", accountId, message }, replySource },
      [],
    ),
  );
});

test("Gmail preparation captures caller-owned input before asynchronous MIME building", async () => {
  const input = structuredClone({
    ...common,
    intent: {
      kind: "draft.send" as const,
      accountId,
      message,
      draftId: "draft1",
      expectedMessageId: "m1",
    },
    draft,
  });
  const pending = prepareGmailMutation(input, []);
  input.intent.message.text = "Changed while building";
  input.draft.messageId = "newer";
  input.target.email = "other@example.com";
  const result = await pending;
  assert.equal(result.plan.prepared.message.text, "Exact body");
  assert.equal(result.plan.draft?.messageId, "m1");
  assert.equal(result.plan.prepared.target.email, "me@example.com");
  assert.deepEqual((await rebuildGmailMutation(result.plan, [])).plan, result.plan);
});
