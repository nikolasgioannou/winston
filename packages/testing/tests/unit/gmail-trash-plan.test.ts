import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  prepareGmailTrash,
  readGmailTrashPlan,
  gmailTrashStateMatches,
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
  operation: "gmail.trash" as const,
};
const source = { ...target, operation: "gmail.read" as const };
const message = {
  source,
  trust: "untrusted_external_content",
  id: "m1",
  threadId: "t1",
  labelIds: ["INBOX"],
};

test("Trash plans bind inspected state and a dedicated operation without implying an inbox restore", () => {
  for (const kind of ["message.trash", "message.restore"] as const) {
    const intent = { kind, accountId, messageId: "m1" };
    const snapshot = { ...message, labelIds: kind === "message.trash" ? ["INBOX"] : ["TRASH"] };
    const plan = prepareGmailTrash(operationId, target, intent, snapshot);
    assert.deepEqual(readGmailTrashPlan(plan), plan);
    assert.equal(gmailTrashStateMatches(plan, kind === "message.trash" ? ["TRASH"] : []), true);
    assert.equal(gmailTrashStateMatches(plan, snapshot.labelIds), false);
    assert.equal(gmailTrashStateMatches(plan, ["DRAFT", "TRASH"]), false);
    for (const change of [
      { labelIds: undefined },
      { labelIds: null },
      { labelIds: ["DRAFT"] },
      { labelIds: kind === "message.trash" ? ["TRASH"] : [] },
      { source: { ...source, connectionId: operationId } },
      { source: { ...source, connectionRevision: 3 } },
    ])
      assert.throws(() =>
        prepareGmailTrash(operationId, target, intent, { ...snapshot, ...change }),
      );
    assert.throws(() =>
      prepareGmailTrash(operationId, target, { ...intent, messageId: "other" }, snapshot),
    );
    assert.throws(() =>
      readGmailTrashPlan({ ...plan, target: { ...target, operation: "gmail.modify" } }),
    );
    assert.throws(() => readGmailTrashPlan({ ...plan, kind: "message.delete" }));
  }
});
