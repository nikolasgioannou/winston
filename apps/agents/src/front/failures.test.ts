import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { DbOrTx } from "@winston/db/client";
import {
  inboundItems,
  modelCalls,
  runMessages,
  runs,
  telegramLinks,
} from "@winston/db/schema";
import { inRollback, insertRun, insertUser, testDb } from "@winston/db/testing";
import { createLogger } from "@winston/shared/logger";
import { asc, eq } from "drizzle-orm";
import { dbModelCallSink } from "../model/log.ts";
import {
  fakeGateway,
  hangingReply,
  httpError,
  refusal,
  textReply,
} from "../model/testing.ts";
import { outageNotice, refusalReply, runFrontTurn } from "./turn.ts";
import { fakeVmClient, testRunTokenSecret } from "../vm/testing.ts";
import { localBlobStore } from "@winston/blobs";

const testBlobs = localBlobStore(`${tmpdir()}/winston-test-blobs`);

const db = await testDb();
const logger = createLogger("agents-test", {
  pretty: false,
  destination: { write: () => undefined },
});
const noTimers = { setInterval: () => 0, clearInterval: () => undefined };
const sonnet = "anthropic/claude-sonnet-5";
const opus = "anthropic/claude-opus-5.5";

/** A linked user whose turns run against scripted model replies, rolled back afterwards. */
async function withUser(
  fn: (context: {
    tx: DbOrTx;
    userId: string;
    say: (text: string) => Promise<void>;
    turn: (replies: Record<string, unknown>[]) => Promise<{
      models: string[];
      error: unknown;
      requests: Record<string, unknown>[];
    }>;
    sent: string[];
  }) => Promise<void>,
) {
  await inRollback(db, async (tx) => {
    const user = await insertUser(tx);
    await tx
      .insert(telegramLinks)
      .values({ userId: user.id, chatId: 99, telegramUserId: 99 });
    const sent: string[] = [];
    let messageIds = 0;
    const telegram = {
      sendMessage: (_chatId: number, text: string) => {
        sent.push(text);
        messageIds += 1;
        return Promise.resolve({ message_id: messageIds });
      },
      sendRichMessage: (_chatId: number, text: string) => {
        sent.push(text);
        messageIds += 1;
        return Promise.resolve({ message_id: messageIds });
      },
      sendChatAction: () => Promise.resolve(true),
      sendFiles: () => Promise.resolve([]),
    };
    const say = async (text: string) => {
      await tx.insert(inboundItems).values({
        userId: user.id,
        type: "user_message",
        payload: { text, telegramMessageId: Math.floor(Math.random() * 1e9) },
        occurredAt: new Date(),
      });
    };
    const turn = async (replies: Record<string, unknown>[]) => {
      const fake = fakeGateway({ replies, sink: dbModelCallSink(tx, logger) });
      const error = await runFrontTurn(
        {
          db: tx,
          logger,
          gateway: fake.gateway,
          vm: fakeVmClient().client,
          runTokenSecret: testRunTokenSecret,
          blobs: testBlobs,
          webPublicUrl: "https://runwinston.com",
          telegram,
          timers: noTimers,
          retryDelayMs: 0,
          callTimeoutMs: 200,
        },
        user.id,
      ).then(
        () => undefined,
        (e: unknown) => e,
      );
      return {
        models: fake.requests.map((request) => String(request.model)),
        error,
        requests: fake.requests,
      };
    };
    await fn({ tx, userId: user.id, say, turn, sent });
  });
}

const unconsumed = async (tx: DbOrTx, userId: string) =>
  (
    await tx.select().from(inboundItems).where(eq(inboundItems.userId, userId))
  ).filter((item) => item.consumedByRunId === null);

describe("front-of-house failure policy", () => {
  test("transient errors get two quick retries on the front model", async () => {
    await withUser(async ({ tx, userId, say, turn, sent }) => {
      await say("hi");
      const { models, error } = await turn([
        httpError(503),
        httpError(429),
        textReply("Hi."),
      ]);
      expect(error).toBeUndefined();
      expect(models).toEqual([sonnet, sonnet, sonnet]);
      expect(sent).toEqual(["Hi."]);
      // Every attempt is recorded, failed ones included, with their own step numbers.
      const calls = await tx
        .select({ step: modelCalls.step, stop: modelCalls.stopReason })
        .from(modelCalls)
        .innerJoin(runs, eq(runs.id, modelCalls.runId))
        .where(eq(runs.userId, userId))
        .orderBy(asc(modelCalls.id));
      expect(calls).toEqual([
        { step: 0, stop: "error" },
        { step: 1, stop: "error" },
        { step: 2, stop: "stop" },
      ]);
    });
  });

  test("a call past its time limit is cut off and retried", async () => {
    await withUser(async ({ say, turn, sent }) => {
      await say("hi");
      const { models, error } = await turn([hangingReply, textReply("Hi.")]);
      expect(error).toBeUndefined();
      expect(models).toEqual([sonnet, sonnet]);
      expect(sent).toEqual(["Hi."]);
    });
  });

  test("after the retries, one attempt on the fallback model", async () => {
    await withUser(async ({ say, turn, sent }) => {
      await say("hi");
      const { models } = await turn([
        httpError(500),
        httpError(500),
        httpError(500),
        textReply("From Opus."),
      ]);
      expect(models).toEqual([sonnet, sonnet, sonnet, opus]);
      expect(sent).toEqual(["From Opus."]);
    });
  });

  test("a non-transient error skips the retries", async () => {
    await withUser(async ({ say, turn, sent }) => {
      await say("hi");
      const { models } = await turn([httpError(400), textReply("From Opus.")]);
      expect(models).toEqual([sonnet, opus]);
      expect(sent).toEqual(["From Opus."]);
    });
  });

  test("when everything fails: the fixed notice, the input handed back, the run failed", async () => {
    await withUser(async ({ tx, userId, say, turn, sent }) => {
      await say("hi");
      const { models, error } = await turn([httpError(500)]);
      expect(error).toBeInstanceOf(Error);
      expect(models).toEqual([sonnet, sonnet, sonnet, opus]);
      expect(sent).toEqual([outageNotice]);
      expect(await unconsumed(tx, userId)).toHaveLength(1);
      const [run] = await tx.select().from(runs).where(eq(runs.userId, userId));
      expect(run?.status).toBe("failed");
    });
  });

  test("the notice goes out once per outage, and the next working turn answers the waiting input", async () => {
    await withUser(async ({ tx, userId, say, turn, sent }) => {
      await say("first");
      await turn([httpError(500)]);
      await say("second");
      await turn([httpError(500)]);
      expect(sent).toEqual([outageNotice]);

      await turn([textReply("Back. Answering both.")]);
      expect(sent).toEqual([outageNotice, "Back. Answering both."]);
      expect(await unconsumed(tx, userId)).toEqual([]);

      // A new outage gets a new notice.
      await say("third");
      await turn([httpError(500)]);
      expect(sent.at(-1)).toBe(outageNotice);
      expect(sent.filter((text) => text === outageNotice)).toHaveLength(2);
    });
  });

  test("failed turns never enter the context, so waiting input appears once", async () => {
    await withUser(async ({ say, turn }) => {
      await say("remember the milk");
      await turn([httpError(500)]);
      const { requests } = await turn([textReply("Noted.")]);
      const context = JSON.stringify(requests[0]?.messages);
      expect(context.match(/remember the milk/g)).toHaveLength(1);
    });
  });

  test("a refusal gets one try on the fallback model, and its output is never kept", async () => {
    await withUser(async ({ tx, userId, say, turn, sent }) => {
      await say("hi");
      const { models } = await turn([
        refusal(),
        textReply("Here's what I can do."),
      ]);
      expect(models).toEqual([sonnet, opus]);
      expect(sent).toEqual(["Here's what I can do."]);
      const [run] = await tx.select().from(runs).where(eq(runs.userId, userId));
      const roles = (
        await tx
          .select()
          .from(runMessages)
          .where(eq(runMessages.runId, run?.id ?? ""))
          .orderBy(asc(runMessages.id))
      ).map((row) => row.role);
      expect(roles).toEqual(["user", "assistant"]);
    });
  });

  test("refused twice: a plain 'can't help' and the turn completes", async () => {
    await withUser(async ({ tx, userId, say, turn, sent }) => {
      await say("hi");
      const { error } = await turn([refusal(), refusal()]);
      expect(error).toBeUndefined();
      expect(sent).toEqual([refusalReply]);
      const [run] = await tx.select().from(runs).where(eq(runs.userId, userId));
      expect(run?.status).toBe("completed");
    });
  });

  test("input claimed by a crashed turn is handed back and answered", async () => {
    await withUser(async ({ tx, userId, turn, sent }) => {
      const dead = await insertRun(tx, userId); // still "running": its worker died
      await tx.insert(inboundItems).values({
        userId,
        type: "user_message",
        payload: { text: "lost?", telegramMessageId: 1 },
        occurredAt: new Date(),
        consumedByRunId: dead.id,
      });
      await turn([textReply("Not lost.")]);
      expect(sent).toEqual(["Not lost."]);
      const [row] = await tx.select().from(runs).where(eq(runs.id, dead.id));
      expect(row?.status).toBe("failed");
    });
  });
});
