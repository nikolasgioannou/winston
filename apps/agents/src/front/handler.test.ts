import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { enqueue } from "@winston/db/queue";
import { inboundItems, jobs, runs, telegramLinks } from "@winston/db/schema";
import { insertUser, testDb, truncateAll } from "@winston/db/testing";
import { frontTurnJob } from "@winston/domain/jobs";
import { createLogger } from "@winston/shared/logger";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { fakeGateway, textReply } from "../model/testing.ts";
import { createWorker } from "../worker.ts";
import { frontTurnHandler } from "./handler.ts";
import { fakeVmClient, testRunTokenSecret } from "../vm/testing.ts";
import { localBlobStore } from "@winston/blobs";

const testBlobs = localBlobStore(`${tmpdir()}/winston-test-blobs`);

// These tests commit for real: turns run on separate workers and connections.
const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const noTimers = { setInterval: () => 0, clearInterval: () => undefined };
const telegram = {
  sendMessage: () => Promise.resolve({ message_id: 1 }),
  sendRichMessage: () => Promise.resolve({ message_id: 1 }),
  sendChatAction: () => Promise.resolve(true),
  sendFiles: () => Promise.resolve([]),
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => truncateAll(db));
afterAll(() => truncateAll(db));

let chatIds = 100;

async function linkedUser() {
  const user = await insertUser(db);
  chatIds += 1;
  await db
    .insert(telegramLinks)
    .values({ userId: user.id, chatId: chatIds, telegramUserId: chatIds });
  return user.id;
}

/** What the webhook does for each message, minus the debounce so tests don't wait. */
async function say(userId: string, text: string) {
  await db.insert(inboundItems).values({
    userId,
    type: "user_message",
    payload: { text, telegramMessageId: Math.floor(Math.random() * 1e9) },
    occurredAt: new Date(),
  });
  await enqueue(db, frontTurnJob.type, {
    userId,
    dedupeKey: frontTurnJob.dedupeKey(userId),
    onDuplicate: "reschedule",
  });
}

/** Workers running the real handler over a slow fake model. */
function startWorkers(count: number, delayMs = 0) {
  const fake = fakeGateway({ replies: [textReply("ok")], delayMs });
  const handler = frontTurnHandler({
    gateway: fake.gateway,
    vm: fakeVmClient().client,
    runTokenSecret: testRunTokenSecret,
    blobs: testBlobs,
    webPublicUrl: "https://runwinston.com",
    telegram,
    timers: noTimers,
  });
  const workers = Array.from({ length: count }, () =>
    createWorker({
      db,
      logger,
      handlers: { [frontTurnJob.type]: handler },
      concurrency: 2,
      idleMs: 10,
    }),
  );
  for (const worker of workers) worker.start();
  return {
    fake,
    stop: () => Promise.all(workers.map((worker) => worker.stop())),
  };
}

/** Waits until no front_turn job is queued or running. */
async function settle() {
  for (let i = 0; i < 300; i += 1) {
    const [pending] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(jobs)
      .where(inArray(jobs.status, ["queued", "running"]));
    if (pending?.count === 0) return;
    await sleep(20);
  }
  throw new Error("jobs didn't settle");
}

async function state(userId: string) {
  const turns = await db.select().from(runs).where(eq(runs.userId, userId));
  const unconsumed = await db
    .select()
    .from(inboundItems)
    .where(
      and(
        eq(inboundItems.userId, userId),
        isNull(inboundItems.consumedByRunId),
      ),
    );
  return { turns: turns.length, unconsumed: unconsumed.length };
}

describe("front_turn serialization", () => {
  test("a burst of 5 messages produces 1 turn", async () => {
    const userId = await linkedUser();
    for (let i = 0; i < 5; i += 1) await say(userId, `message ${String(i)}`);
    const workers = startWorkers(1);
    await settle();
    await workers.stop();
    expect(await state(userId)).toEqual({ turns: 1, unconsumed: 0 });
  });

  test("racing workers never run two turns for a user at once, and leave nothing behind", async () => {
    const userId = await linkedUser();
    // Two due jobs for the same user, which the dedupe key would normally prevent.
    await db.insert(inboundItems).values({
      userId,
      type: "user_message",
      payload: { text: "first", telegramMessageId: 1 },
      occurredAt: new Date(),
    });
    await enqueue(db, frontTurnJob.type, { userId });
    await enqueue(db, frontTurnJob.type, { userId });
    const workers = startWorkers(2, 100);
    // Input arriving mid-turn (once the turn's model call is in flight, not
    // after a fixed wait, which a slow CI runner can outlast): its job finds
    // the lock busy.
    for (let waited = 0; workers.fake.concurrency.current === 0; waited += 5) {
      if (waited > 5_000) throw new Error("the turn never called the model");
      await sleep(5);
    }
    await say(userId, "second");
    await settle();
    await workers.stop();
    expect(workers.fake.concurrency.max).toBe(1);
    // The mid-turn message is steered into the running turn.
    expect(await state(userId)).toEqual({ turns: 1, unconsumed: 0 });
  });

  test("a message just after a turn completes gets a new turn", async () => {
    const userId = await linkedUser();
    const workers = startWorkers(1);
    await say(userId, "one");
    await settle();
    await say(userId, "two");
    await settle();
    await workers.stop();
    expect(await state(userId)).toEqual({ turns: 2, unconsumed: 0 });
  });

  test("different users' turns run in parallel", async () => {
    const [a, b] = [await linkedUser(), await linkedUser()];
    const workers = startWorkers(1, 100);
    await say(a, "hi");
    await say(b, "hi");
    await settle();
    await workers.stop();
    expect(workers.fake.concurrency.max).toBe(2);
    expect(await state(a)).toEqual({ turns: 1, unconsumed: 0 });
    expect(await state(b)).toEqual({ turns: 1, unconsumed: 0 });
  });
});
