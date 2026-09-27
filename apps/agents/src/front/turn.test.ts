import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  modelCalls,
  outboundMessages,
  runMessages,
  runs,
  telegramLinks,
} from "@winston/db/schema";
import { inRollback, insertUser, testDb } from "@winston/db/testing";
import type { UserMessagePayload } from "@winston/domain/inbound";
import { createLogger } from "@winston/shared/logger";
import { asc, eq } from "drizzle-orm";
import { dbModelCallSink } from "../model/log.ts";
import { fakeGateway, textReply, toolCallReply } from "../model/testing.ts";
import { emptyReplyNudge, runFrontTurn } from "./turn.ts";

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});

let telegramIds = 5_000;

/** A linked user, a scripted model and a fake Telegram, all rolled back afterwards. */
async function scenario(
  replies: Record<string, unknown>[][],
  fn: (context: {
    tx: DbOrTx;
    userId: string;
    say: (text: string, extra?: Partial<UserMessagePayload>) => Promise<number>;
    turn: (index?: number) => Promise<string | undefined>;
    sent: { chatId: number; text: string }[];
    requests: Record<string, unknown>[][];
  }) => Promise<void>,
) {
  await inRollback(db, async (tx) => {
    const user = await insertUser(tx, { timezone: "America/New_York" });
    await tx
      .insert(telegramLinks)
      .values({ userId: user.id, chatId: 42, telegramUserId: 42 });
    const sent: { chatId: number; text: string }[] = [];
    const telegram = {
      sendMessage: (chatId: number, text: string) => {
        sent.push({ chatId, text });
        telegramIds += 1;
        return Promise.resolve({ message_id: telegramIds });
      },
    };
    const requests: Record<string, unknown>[][] = [];
    const say = async (
      text: string,
      extra: Partial<UserMessagePayload> = {},
    ) => {
      telegramIds += 1;
      await tx.insert(inboundItems).values({
        userId: user.id,
        type: "user_message",
        payload: { text, telegramMessageId: telegramIds, ...extra },
        occurredAt: new Date("2026-09-27T16:00:00Z"),
      });
      return telegramIds;
    };
    const turn = async (index = 0) => {
      const fake = fakeGateway({
        replies: replies[index] ?? [textReply("")],
        sink: dbModelCallSink(tx, logger),
      });
      requests[index] = fake.requests;
      return runFrontTurn(
        { db: tx, logger, gateway: fake.gateway, telegram },
        user.id,
      );
    };
    await fn({ tx, userId: user.id, say, turn, sent, requests });
  });
}

describe("runFrontTurn", () => {
  test("the final text is the reply: sent and recorded", async () => {
    await scenario(
      [[textReply("Morning.")]],
      async ({ tx, userId, say, turn, sent }) => {
        await say("hi");
        const runId = await turn();
        if (!runId) throw new Error("expected a run");

        expect(sent).toEqual([{ chatId: 42, text: "Morning." }]);
        const [outbound] = await tx
          .select()
          .from(outboundMessages)
          .where(eq(outboundMessages.userId, userId));
        expect(outbound).toMatchObject({ runId, text: "Morning." });
        expect(outbound?.telegramMessageIds).toHaveLength(1);
        const [run] = await tx.select().from(runs).where(eq(runs.id, runId));
        expect(run).toMatchObject({ status: "completed", stepCount: 1 });
        expect(
          await tx.select().from(modelCalls).where(eq(modelCalls.runId, runId)),
        ).toHaveLength(1);
      },
    );
  });

  test("no_reply ends the turn silently after one call, discarding any text beside it", async () => {
    await scenario(
      [[toolCallReply("no_reply", {}, "No reply needed.")]],
      async ({ tx, userId, say, turn, sent, requests }) => {
        await say("thanks");
        const runId = await turn();
        if (!runId) throw new Error("expected a run");
        expect(sent).toEqual([]);
        expect(requests[0]).toHaveLength(1);
        expect(
          await tx
            .select()
            .from(outboundMessages)
            .where(eq(outboundMessages.userId, userId)),
        ).toEqual([]);
        // The call and its result are both stored, so the next request stays valid.
        const rows = await tx
          .select()
          .from(runMessages)
          .where(eq(runMessages.runId, runId))
          .orderBy(asc(runMessages.id));
        expect(rows.map((row) => row.role)).toEqual([
          "user",
          "assistant",
          "tool",
        ]);
      },
    );
  });

  test("an empty reply is nudged once, never taken as silence", async () => {
    await scenario(
      [[textReply(""), textReply("Lisbon.")]],
      async ({ tx, say, turn, sent }) => {
        await say("capital of Portugal?");
        const runId = await turn();
        if (!runId) throw new Error("expected a run");
        expect(sent).toEqual([{ chatId: 42, text: "Lisbon." }]);
        const rows = await tx
          .select()
          .from(runMessages)
          .where(eq(runMessages.runId, runId))
          .orderBy(asc(runMessages.id));
        expect(rows.map((row) => [row.role, row.content])).toContainEqual([
          "user",
          { role: "user", content: emptyReplyNudge },
        ]);
      },
    );
  });

  test("two empty replies send nothing and still complete the turn", async () => {
    await scenario(
      [[textReply(""), textReply("")]],
      async ({ tx, userId, say, turn, sent, requests }) => {
        await say("hmm");
        await turn();
        expect(sent).toEqual([]);
        expect(requests[0]).toHaveLength(2);
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.userId, userId));
        expect(run?.status).toBe("completed");
      },
    );
  });

  test("every step lands in run_messages in order, starting with the input envelope", async () => {
    await scenario([[textReply("Moved.")]], async ({ tx, say, turn }) => {
      await say("move my 3pm");
      const runId = await turn();
      if (!runId) throw new Error("expected a run");
      const rows = await tx
        .select()
        .from(runMessages)
        .where(eq(runMessages.runId, runId))
        .orderBy(asc(runMessages.id));
      expect(rows.map((row) => [row.seq, row.role])).toEqual([
        [0, "user"],
        [1, "assistant"],
      ]);
      expect(JSON.stringify(rows[0]?.content)).toContain(
        "<text>move my 3pm</text>",
      );
      expect(JSON.stringify(rows[0]?.content)).toContain(
        "<sent_at>2026-09-27T12:00:00-04:00</sent_at>",
      );
    });
  });

  test("inbound items are consumed exactly once, and a burst becomes one envelope batch", async () => {
    await scenario([[textReply("Hi.")]], async ({ tx, userId, say, turn }) => {
      await say("one");
      await say("two");
      const runId = await turn();
      if (!runId) throw new Error("expected a run");
      const items = await tx
        .select()
        .from(inboundItems)
        .where(eq(inboundItems.userId, userId));
      expect(items.map((item) => item.consumedByRunId)).toEqual([runId, runId]);
      const [input] = await tx
        .select()
        .from(runMessages)
        .where(eq(runMessages.runId, runId));
      expect(
        JSON.stringify(input?.content).match(/<system_event /g),
      ).toHaveLength(2);

      // Nothing new: no second run.
      expect(await turn(1)).toBeUndefined();
      expect(
        await tx.select().from(runs).where(eq(runs.userId, userId)),
      ).toHaveLength(1);
    });
  });

  test("the next turn sees the conversation so far, with a cache breakpoint at the end of the previous turn", async () => {
    await scenario(
      [[textReply("Noted.")], [textReply("Bella.")]],
      async ({ say, turn, requests }) => {
        await say("my sister is Bella");
        await turn(0);
        await say("who's my sister?");
        await turn(1);

        const sent = JSON.stringify(requests[1]?.[0]?.messages);
        expect(sent).toContain("my sister is Bella");
        expect(sent).toContain("Noted.");
        expect(sent).toContain("who's my sister?");
        // System prompt and the previous turn's last message.
        expect(
          sent.match(/"cache_control":\{"type":"ephemeral"\}/g),
        ).toHaveLength(2);
      },
    );
  });

  test("a reply to one of Winston's messages quotes it", async () => {
    await scenario(
      [[textReply("Your 3pm is with Dana.")], [textReply("Moved.")]],
      async ({ tx, userId, say, turn }) => {
        await say("what's at 3?");
        await turn(0);
        const [outbound] = await tx
          .select()
          .from(outboundMessages)
          .where(eq(outboundMessages.userId, userId));
        await say("move it", {
          replyToTelegramMessageId: outbound?.telegramMessageIds[0] ?? 0,
        });
        const runId = await turn(1);
        const [input] = await tx
          .select()
          .from(runMessages)
          .where(eq(runMessages.runId, runId ?? ""));
        expect(JSON.stringify(input?.content)).toContain(
          '<reply_to from=\\"winston\\">Your 3pm is with Dana.</reply_to>',
        );
      },
    );
  });

  test("a failing model marks the run failed and rethrows", async () => {
    await scenario(
      [[{ error: { message: "upstream exploded", code: 500 } }]],
      async ({ tx, userId, say, turn }) => {
        await say("hi");
        const error = await turn().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(Error);
        const [run] = await tx
          .select()
          .from(runs)
          .where(eq(runs.userId, userId));
        expect(run?.status).toBe("failed");
      },
    );
  });
});
