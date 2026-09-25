import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  prepareGmailLabelMutation,
  readGmailLabelMutationPlan,
  gmailLabelsMatch,
} from "@winston/adapters/google";

const accountId = "9cbd0d78-55a2-4885-bb6e-c4e112f2c988";
const operationId = "219fb112-6f15-4c18-b282-b0e0c5a205d7";
const target = {
  connectionId: accountId,
  calendarId: null,
  connectionRevision: 2,
  preferencesRevision: 1,
  label: "Personal",
  email: "me@example.com",
  operation: "gmail.modify" as const,
};
const source = { ...target, operation: "gmail.read" as const };
const message = {
  source,
  trust: "untrusted_external_content",
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX", "UNREAD"],
};
const inventory = {
  source,
  trust: "untrusted_external_content",
  labels: [
    { id: "INBOX", name: "INBOX", type: "system" },
    { id: "UNREAD", name: "UNREAD", type: "system" },
    { id: "custom1", name: "Projects", type: "user" },
  ],
};
const intent = {
  accountId,
  messageId: "m1",
  addLabelIds: ["custom1"],
  removeLabelIds: ["INBOX", "UNREAD"],
};

test("Gmail label plans bind one message, account and exact label delta", () => {
  const plan = prepareGmailLabelMutation(operationId, target, intent, message, inventory);
  assert.deepEqual(plan.add, [inventory.labels[2]]);
  assert.deepEqual(plan.remove, inventory.labels.slice(0, 2));
  assert.deepEqual(readGmailLabelMutationPlan(plan), plan);
  assert.equal(gmailLabelsMatch(plan, ["custom1", "STARRED"]), true);
  assert.equal(gmailLabelsMatch(plan, ["custom1", "UNREAD"]), false);
  assert.equal(gmailLabelsMatch(plan, []), false);
  for (const changed of [
    { accountId: operationId },
    { messageId: "other" },
    { addLabelIds: [], removeLabelIds: [] },
    { addLabelIds: ["custom1", "custom1"] },
    { addLabelIds: ["INBOX"] },
    { addLabelIds: ["missing"] },
    ...["TRASH", "SENT", "DRAFT"].flatMap((id) => [
      { addLabelIds: [id] },
      { removeLabelIds: [id] },
    ]),
  ])
    assert.throws(() =>
      prepareGmailLabelMutation(operationId, target, { ...intent, ...changed }, message, inventory),
    );
});

test("Gmail label plans reject unknown state, foreign provenance and managed labels", () => {
  for (const changed of [
    { labelIds: null },
    { labelIds: undefined },
    { labelIds: ["DRAFT"] },
    { labelIds: ["TRASH"] },
    { source: { ...source, connectionId: operationId } },
    { source: { ...source, connectionRevision: 3 } },
    { source: { ...source, preferencesRevision: 2 } },
  ])
    assert.throws(() =>
      prepareGmailLabelMutation(operationId, target, intent, { ...message, ...changed }, inventory),
    );
  assert.throws(() =>
    prepareGmailLabelMutation(operationId, target, intent, message, {
      ...inventory,
      source: { ...source, email: "other@example.com" },
    }),
  );
  assert.throws(() =>
    prepareGmailLabelMutation(operationId, target, intent, message, {
      ...inventory,
      labels: [...inventory.labels, inventory.labels[0]],
    }),
  );
  assert.throws(() =>
    prepareGmailLabelMutation(operationId, target, intent, message, {
      ...inventory,
      labels: inventory.labels.map((label) => ({ ...label, type: "system" })),
    }),
  );
  const plan = prepareGmailLabelMutation(operationId, target, intent, message, inventory);
  assert.throws(() =>
    readGmailLabelMutationPlan({ ...plan, target: { ...target, operation: "gmail.send" } }),
  );
  assert.throws(() => readGmailLabelMutationPlan({ ...plan, add: [...plan.add, ...plan.add] }));
});
