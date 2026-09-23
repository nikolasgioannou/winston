import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "bun:test";
import type { OwnerTransaction } from "@winston/adapters/database";
import {
  deliverTelegramFile,
  maximumTelegramDocumentBytes,
  type TelegramSendOutcome,
} from "@winston/adapters/telegram";
import type { Artifact } from "@winston/contracts/artifacts";

test("file workers verify before dispatch and preserve uncertain send receipts", async () => {
  const ownerId = randomUUID();
  const id = randomUUID();
  const bytes = Buffer.from("abc");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const artifact: Artifact = {
    id,
    revision: 1,
    state: "ready",
    metadata: {
      name: "fixture.txt",
      mediaType: "text/plain",
      size: 3,
      sha256: hash,
      source: { kind: "workspace", reference: "fixture" },
    },
    object: { id, ownerId, purpose: "artifact", size: 3, sha256: hash },
  };
  const delivery = { id: randomUUID(), token: randomUUID(), artifactId: id, chatId: "123" };
  const events: string[] = [];
  const outcomes: TelegramSendOutcome[] = [];
  let allowed = true;
  let corrupt = false;
  let sendFails = false;
  const repository: OwnerTransaction["telegramFiles"] = {
    find: () => Promise.resolve(undefined),
    enqueue: () => Promise.reject(new Error("Not used")),
    claim: () => {
      events.push("claim");
      return Promise.resolve(delivery);
    },
    dispatch: () => {
      events.push("dispatch");
      return Promise.resolve(allowed);
    },
    settle: (claimed, outcome) => {
      assert.equal(claimed.token, delivery.token);
      outcomes.push(outcome);
      events.push("settle");
      return Promise.resolve(true);
    },
  };
  const database = {
    transaction<Result>(
      owner: string,
      work: (scope: Pick<OwnerTransaction, "telegramFiles">) => Promise<Result>,
    ) {
      assert.equal(owner, ownerId);
      return work({ telegramFiles: repository });
    },
  };
  const read = (owner: string, artifactId: string, limit: number) => {
    assert.equal(owner, ownerId);
    assert.equal(artifactId, id);
    assert.equal(limit, maximumTelegramDocumentBytes);
    events.push("read");
    return corrupt
      ? Promise.reject(new Error("Integrity failure"))
      : Promise.resolve({ artifact, bytes });
  };
  const send = () => {
    events.push("send");
    return sendFails
      ? Promise.reject(new Error("Ambiguous dispatch"))
      : Promise.resolve({ state: "sent" as const, messageId: 77 });
  };
  const signal = new AbortController().signal;
  assert.equal(await deliverTelegramFile(database, ownerId, 1, read, send, signal), "sent");
  assert.deepEqual(events, ["claim", "read", "dispatch", "send", "settle"]);
  events.length = 0;
  allowed = false;
  assert.equal(await deliverTelegramFile(database, ownerId, 1, read, send, signal), "canceled");
  assert.deepEqual(events, ["claim", "read", "dispatch"]);
  events.length = 0;
  corrupt = true;
  assert.equal(await deliverTelegramFile(database, ownerId, 1, read, send, signal), "unavailable");
  assert.deepEqual(events, ["claim", "read", "settle"]);
  assert.equal(outcomes.at(-1)?.state, "rejected");
  corrupt = false;
  allowed = true;
  sendFails = true;
  assert.equal(await deliverTelegramFile(database, ownerId, 1, read, send, signal), "uncertain");
  assert.equal(outcomes.at(-1)?.state, "uncertain");
});
