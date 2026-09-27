import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  jobs,
  outboundMessages,
  runs,
  telegramLinks,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import { eq } from "drizzle-orm";
import type { UserMessagePayload } from "@winston/domain/inbound";
import { frontTurnJob } from "@winston/domain/jobs";
import type { Update } from "grammy/types";
import { createApp } from "../app.ts";
import { unlinkedChatReply } from "../telegram/handle-update.ts";
import { testDeps, testWebhookSecret } from "../testing.ts";

const db = await testDb();
const chatId = 5_550_001;
const sentAt = 1_790_000_000;
let nextUpdateId = 1_000;

/** A text message update from the linked chat; `message` overrides its fields. */
function textUpdate(message: Record<string, unknown> = {}): Update {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message: {
      message_id: nextUpdateId,
      date: sentAt,
      chat: { id: chatId, type: "private", first_name: "Ada" },
      from: { id: chatId, is_bot: false, first_name: "Ada" },
      text: "hello",
      ...message,
    },
  };
}

/** Runs `fn` with the app, a linked user and a clean slate, all rolled back afterwards. */
async function withApp(
  fn: (context: {
    tx: DbOrTx;
    userId: string;
    post: (update: Update, secret?: string) => Promise<Response>;
    sent: { chatId: number; text: string }[];
  }) => Promise<void>,
) {
  await inRollback(db, async (tx) => {
    const { deps, sent } = testDeps(tx);
    const app = createApp(deps);
    const user = await insertUser(tx);
    await tx
      .insert(telegramLinks)
      .values({ userId: user.id, chatId, telegramUserId: chatId });
    const post = async (update: Update, secret = testWebhookSecret) =>
      app.request("/webhooks/telegram", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": secret,
        },
        body: JSON.stringify(update),
      });
    await fn({ tx, userId: user.id, post, sent });
  });
}

const itemsFor = (tx: DbOrTx, userId: string) =>
  tx.select().from(inboundItems).where(eq(inboundItems.userId, userId));
const jobsFor = (tx: DbOrTx, userId: string) =>
  tx.select().from(jobs).where(eq(jobs.userId, userId));

describe("POST /webhooks/telegram", () => {
  test("rejects a missing or wrong secret without processing", async () => {
    await withApp(async ({ tx, userId, post }) => {
      expect((await post(textUpdate(), "")).status).toBe(401);
      expect((await post(textUpdate(), "wrong")).status).toBe(401);
      expect(await itemsFor(tx, userId)).toEqual([]);
    });
  });

  test("stores a text message and queues a debounced front-of-house turn", async () => {
    await withApp(async ({ tx, userId, post }) => {
      const update = textUpdate({ text: "book dinner" });
      expect((await post(update)).status).toBe(200);

      const [item] = await itemsFor(tx, userId);
      expect(item).toMatchObject({
        type: "user_message",
        payload: { text: "book dinner", telegramMessageId: nextUpdateId },
        sourceRef: `telegram:123456:${String(update.update_id)}`,
        occurredAt: new Date(sentAt * 1000),
      });
      const [job] = await jobsFor(tx, userId);
      expect(job).toMatchObject({
        type: frontTurnJob.type,
        status: "queued",
        dedupeKey: frontTurnJob.dedupeKey(userId),
      });
      // Measured by the database's clock, so allow for slight skew from ours.
      const delay = (job?.runAt.getTime() ?? 0) - Date.now();
      expect(delay).toBeGreaterThan(500);
      expect(delay).toBeLessThan(2_500);
    });
  });

  test("records what a reply replies to", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await post(textUpdate({ reply_to_message: { message_id: 42 } }));
      const [item] = await itemsFor(tx, userId);
      expect(item?.payload).toMatchObject({ replyToTelegramMessageId: 42 });
    });
  });

  test("records who originally sent a forwarded message", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await post(
        textUpdate({
          forward_origin: {
            type: "user",
            date: sentAt - 60,
            sender_user: {
              id: 9,
              is_bot: false,
              first_name: "Grace",
              last_name: "Hopper",
              username: "grace",
            },
          },
        }),
      );
      await post(
        textUpdate({
          forward_origin: {
            type: "hidden_user",
            date: sentAt - 60,
            sender_user_name: "Someone Private",
          },
        }),
      );
      const origins = (await itemsFor(tx, userId)).map(
        (item) => (item.payload as UserMessagePayload).forwardedFrom,
      );
      const originalSentAt = new Date((sentAt - 60) * 1000).toISOString();
      expect(origins).toEqual([
        {
          kind: "user",
          name: "Grace Hopper",
          username: "grace",
          sentAt: originalSentAt,
        },
        {
          kind: "hidden_user",
          name: "Someone Private",
          sentAt: originalSentAt,
        },
      ]);
    });
  });

  test("ignores group chats entirely", async () => {
    await withApp(async ({ tx, userId, post, sent }) => {
      const update = textUpdate({
        chat: { id: -100, type: "group", title: "Friends" },
      });
      expect((await post(update)).status).toBe(200);
      expect(await itemsFor(tx, userId)).toEqual([]);
      expect(sent).toEqual([]);
    });
  });

  test("replies politely to an unlinked chat but never processes it", async () => {
    await withApp(async ({ tx, post, sent }) => {
      const stranger = 7_770_001;
      const update = textUpdate({
        chat: { id: stranger, type: "private", first_name: "Eve" },
      });
      expect((await post(update)).status).toBe(200);
      expect(sent).toEqual([{ chatId: stranger, text: unlinkedChatReply }]);
      expect(
        await tx
          .select()
          .from(inboundItems)
          .where(
            eq(
              inboundItems.sourceRef,
              `telegram:123456:${String(update.update_id)}`,
            ),
          ),
      ).toEqual([]);
    });
  });

  test("still acknowledges an unlinked chat when the reply fails", async () => {
    await inRollback(db, async (tx) => {
      const { deps } = testDeps(tx);
      deps.telegram.sender = {
        sendMessage: () => Promise.reject(new Error("Telegram is down")),
      };
      const res = await createApp(deps).request("/webhooks/telegram", {
        method: "POST",
        headers: { "X-Telegram-Bot-Api-Secret-Token": testWebhookSecret },
        body: JSON.stringify(
          textUpdate({ chat: { id: 1, type: "private", first_name: "Eve" } }),
        ),
      });
      expect(res.status).toBe(200);
    });
  });

  test("ignores a redelivered update", async () => {
    await withApp(async ({ tx, userId, post }) => {
      const update = textUpdate();
      await post(update);
      expect((await post(update)).status).toBe(200);
      expect(await itemsFor(tx, userId)).toHaveLength(1);
      expect(await jobsFor(tx, userId)).toHaveLength(1);
    });
  });

  test("a burst of messages queues one turn", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await post(textUpdate({ text: "one" }));
      await post(textUpdate({ text: "two" }));
      expect(await itemsFor(tx, userId)).toHaveLength(2);
      expect(await jobsFor(tx, userId)).toHaveLength(1);
    });
  });

  test("skips messages that aren't text", async () => {
    await withApp(async ({ tx, userId, post }) => {
      const update = textUpdate();
      delete update.message?.text;
      expect((await post(update)).status).toBe(200);
      expect(await itemsFor(tx, userId)).toEqual([]);
    });
  });
});

const emoji = (list: string[]) =>
  list.map((e) => ({ type: "emoji", emoji: e }));

function reactionUpdate(
  messageId: number,
  before: string[],
  after: string[],
  chat: Record<string, unknown> = {
    id: chatId,
    type: "private",
    first_name: "Ada",
  },
): Update {
  nextUpdateId += 1;
  return {
    update_id: nextUpdateId,
    message_reaction: {
      chat,
      message_id: messageId,
      user: { id: chatId, is_bot: false, first_name: "Ada" },
      date: sentAt,
      old_reaction: emoji(before),
      new_reaction: emoji(after),
    },
  } as unknown as Update;
}

/** One of Winston's messages, delivered as Telegram message 777. */
async function winstonSaid(tx: DbOrTx, userId: string, text: string) {
  const [run] = await tx.insert(runs).values({ userId }).returning();
  await tx.insert(outboundMessages).values({
    userId,
    runId: run?.id ?? "",
    text,
    telegramMessageIds: [776, 777],
  });
}

describe("POST /webhooks/telegram: reactions", () => {
  test("a reaction to Winston's message is stored with its emoji and target, and queues a turn", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await winstonSaid(tx, userId, "Your 3pm moved to 4.");
      expect((await post(reactionUpdate(777, [], ["👍"]))).status).toBe(200);
      const [item] = await itemsFor(tx, userId);
      expect(item).toMatchObject({
        type: "telegram.reaction.added",
        payload: {
          emoji: "👍",
          target: { telegramMessageId: 777, text: "Your 3pm moved to 4." },
        },
        occurredAt: new Date(sentAt * 1000),
      });
      expect(await jobsFor(tx, userId)).toHaveLength(1);
    });
  });

  test("a removed reaction is ignored; a changed one counts as the new emoji", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await winstonSaid(tx, userId, "Booked.");
      await post(reactionUpdate(777, ["👍"], []));
      expect(await itemsFor(tx, userId)).toEqual([]);
      await post(reactionUpdate(777, ["👍"], ["👎"]));
      const items = await itemsFor(tx, userId);
      expect(
        items.map((item) => (item.payload as { emoji: string }).emoji),
      ).toEqual(["👎"]);
    });
  });

  test("a reaction to a message Winston didn't send is ignored gracefully", async () => {
    await withApp(async ({ tx, userId, post }) => {
      expect((await post(reactionUpdate(12345, [], ["❤"]))).status).toBe(200);
      expect(await itemsFor(tx, userId)).toEqual([]);
      expect(await jobsFor(tx, userId)).toEqual([]);
    });
  });

  test("keeps only the start of a long target message", async () => {
    await withApp(async ({ tx, userId, post }) => {
      await winstonSaid(tx, userId, "a".repeat(500));
      await post(reactionUpdate(777, [], ["👍"]));
      const [item] = await itemsFor(tx, userId);
      expect(
        (item?.payload as { target: { text: string } }).target.text,
      ).toHaveLength(200);
    });
  });
});
